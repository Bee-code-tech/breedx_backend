import JSZip from 'jszip';
import mammoth from 'mammoth';
import { PDFDocument } from 'pdf-lib';
import { BACKGROUND_ENGINE } from '../../config/models';
import { PageUnit } from '../../types/library';
import { generate, TokenCount, ZERO_TOKENS, addTokens } from './vertex';

/** A material's text, one entry per page (or slide, or section). Pages count from 1. */
export interface ExtractedText {
  unit: PageUnit;
  pages: string[];
  /** The PDF's own bookmarks, if it has them: a strong hint for the topic map. */
  outline: { title: string; page: number }[];
  tokens: TokenCount;
  /** Scanned pages read with the AI, for the student's monthly usage. */
  scanned?: number;
}

export class UnsupportedFileError extends Error {
  constructor(extension: string) {
    super(`Reading .${extension || 'unknown'} files isn't supported yet`);
  }
}

// A page with less text than this is treated as a scan and read by the AI
const SCANNED_BELOW = 40;
// Most scanned pages read per file, to keep one huge scan from costing too much
const MAX_SCANNED_PAGES = 400;
const SCAN_BATCH = 10;
const SCAN_PARALLEL = 3;
// Text files without real pages are split into sections about this long
const SECTION_CHARS = 3000;

const CONTENT_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

const extensionFor = (fileName: string, contentType: string) => {
  const parts = fileName.toLowerCase().split('.');
  const fromName = parts.length > 1 ? parts.pop() ?? '' : '';
  return fromName || CONTENT_TYPES[contentType] || '';
};

const tidy = (text: string) =>
  text
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Splits long text into sections at paragraph breaks, for files that have no pages. */
const toSections = (text: string): string[] => {
  const sections: string[] = [];
  let current = '';
  for (const paragraph of tidy(text).split(/\n\n+/)) {
    if (current && current.length + paragraph.length > SECTION_CHARS) {
      sections.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) sections.push(current);
  return sections.length ? sections : [''];
};

// unpdf is an ES module; this loads it from our CommonJS build without TypeScript rewriting it to require()
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importModule = new Function('name', 'return import(name)') as (name: string) => Promise<unknown>;

interface OutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items: OutlineItem[];
}

interface PdfDocument {
  numPages: number;
  getOutline(): Promise<OutlineItem[] | null>;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
  destroy?(): Promise<void>;
  cleanup?(): Promise<unknown>;
}

interface Unpdf {
  getDocumentProxy(data: Uint8Array): Promise<PdfDocument>;
  extractText(pdf: PdfDocument, options: { mergePages: false }): Promise<{ totalPages: number; text: string[] }>;
}

const readOutline = async (pdf: PdfDocument): Promise<ExtractedText['outline']> => {
  const outline: ExtractedText['outline'] = [];
  const walk = async (items: OutlineItem[], depth: number) => {
    for (const item of items) {
      if (outline.length >= 300) return;
      try {
        const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
        if (Array.isArray(dest) && dest[0]) {
          outline.push({ title: `${'  '.repeat(depth)}${item.title.trim()}`, page: (await pdf.getPageIndex(dest[0])) + 1 });
        }
      } catch {
        // A broken bookmark is skipped; the AI maps the file either way
      }
      if (depth < 2 && item.items?.length) await walk(item.items, depth + 1);
    }
  };
  try {
    await walk((await pdf.getOutline()) ?? [], 0);
  } catch {
    return [];
  }
  return outline;
};

/** Reads scanned pages by sending them to the AI as small PDFs, a few batches at a time. */
const readScannedPages = async (
  buffer: Buffer,
  pageNumbers: number[],
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<{ texts: Map<number, string>; tokens: TokenCount }> => {
  const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const batches: number[][] = [];
  for (let i = 0; i < pageNumbers.length; i += SCAN_BATCH) batches.push(pageNumbers.slice(i, i + SCAN_BATCH));

  const texts = new Map<number, string>();
  let tokens = ZERO_TOKENS;
  let done = 0;

  const readBatch = async (batch: number[]) => {
    const part = await PDFDocument.create();
    const copied = await part.copyPages(source, batch.map((page) => page - 1));
    copied.forEach((page) => part.addPage(page));
    const data = Buffer.from(await part.save()).toString('base64');

    const result = await generate({
      engine: BACKGROUND_ENGINE,
      temperature: 0,
      signal,
      prompt: [
        { inlineData: { mimeType: 'application/pdf', data } },
        {
          text:
            `These are ${batch.length} pages of a student's study material. Write out all the text on each page exactly, ` +
            'keeping headings, lists and equations. Describe diagrams or tables in one short line in [square brackets]. ' +
            `Start each page with a line "=== PAGE n ===", n from 1 to ${batch.length}. Write [blank] for an empty page. ` +
            'Output nothing else.',
        },
      ],
    });

    const pieces = result.text.split(/^=== PAGE (\d+) ===\s*$/m);
    for (let i = 1; i < pieces.length; i += 2) {
      const page = batch[Number(pieces[i]) - 1];
      const text = tidy(pieces[i + 1] ?? '').replace(/^\[blank\]$/i, '');
      if (page) texts.set(page, text);
    }
    tokens = addTokens(tokens, result.tokens);
    done += batch.length;
    onProgress(done, pageNumbers.length);
  };

  for (let i = 0; i < batches.length; i += SCAN_PARALLEL) {
    await Promise.all(batches.slice(i, i + SCAN_PARALLEL).map(readBatch));
  }
  return { texts, tokens };
};

const readPdf = async (
  buffer: Buffer,
  onScanProgress: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<ExtractedText> => {
  const { getDocumentProxy, extractText } = (await importModule('unpdf')) as Unpdf;
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = text.map(tidy);
    const outline = await readOutline(pdf);

    const scanned = pages
      .map((page, index) => ({ page: index + 1, length: page.length }))
      .filter((page) => page.length < SCANNED_BELOW)
      .slice(0, MAX_SCANNED_PAGES)
      .map((page) => page.page);

    let tokens = ZERO_TOKENS;
    if (scanned.length) {
      const result = await readScannedPages(buffer, scanned, onScanProgress, signal);
      result.texts.forEach((value, page) => {
        if (value.length > pages[page - 1].length) pages[page - 1] = value;
      });
      tokens = result.tokens;
    }
    return { unit: 'page', pages, outline, tokens, scanned: scanned.length };
  } finally {
    // Frees the parsed document's memory
    await (pdf.destroy ?? pdf.cleanup)?.call(pdf).catch(() => undefined);
  }
};

const decodeXml = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const readPptx = async (buffer: Buffer): Promise<ExtractedText> => {
  const zip = await JSZip.loadAsync(buffer);
  const slides = Object.keys(zip.files)
    .map((name) => ({ name, number: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(name)?.[1]) }))
    .filter((slide) => slide.number)
    .sort((a, b) => a.number - b.number);

  const pages: string[] = [];
  for (const slide of slides) {
    const xml = await zip.files[slide.name].async('string');
    const paragraphs = xml.split('</a:p>').map((paragraph) =>
      [...paragraph.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => decodeXml(match[1])).join('')
    );
    pages.push(tidy(paragraphs.filter(Boolean).join('\n')));
  }
  return { unit: 'slide', pages, outline: [], tokens: ZERO_TOKENS };
};

/**
 * Pulls the text out of a stored file, page by page. Text PDFs, Word, slides
 * and plain text are read for free; only scanned PDF pages use the AI.
 */
export const extractText = async (
  buffer: Buffer,
  fileName: string,
  contentType: string,
  onScanProgress: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<ExtractedText> => {
  const extension = extensionFor(fileName, contentType);
  switch (extension) {
    case 'pdf':
      return readPdf(buffer, onScanProgress, signal);
    case 'pptx':
      return readPptx(buffer);
    case 'docx': {
      const { value } = await mammoth.extractRawText({ buffer });
      return { unit: 'section', pages: toSections(value), outline: [], tokens: ZERO_TOKENS };
    }
    case 'txt':
    case 'md':
      return { unit: 'section', pages: toSections(buffer.toString('utf8')), outline: [], tokens: ZERO_TOKENS };
    default:
      // Old .doc and .ppt, Keynote and EPUB come later
      throw new UnsupportedFileError(extension);
  }
};
