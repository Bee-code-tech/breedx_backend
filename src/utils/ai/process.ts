import { BACKGROUND_ENGINE } from '../../config/models';
import env from '../../config/env';
import Material from '../../models/material.model';
import MaterialChunk from '../../models/materialChunk.model';
import { IMaterial, ProcessingProgress, TopicMap } from '../../types/library';
import { downloadObject } from '../storage';
import { recordUsage } from './energy';
import { extractText, UnsupportedFileError } from './extract';
import { buildTopicMap, locate } from './topicMap';
import { addTokens, embed } from './vertex';

// A run that hasn't finished after this long is treated as crashed and started again
const STALE_AFTER_MS = 20 * 60 * 1000;
const WAIT_POLL_MS = 2000;
// Progress is saved for other servers' waiting students at most this often
const SAVE_PROGRESS_MS = 2000;
// Chunks aim for about this many characters (roughly 400 tokens)
const CHUNK_TARGET = 1600;
const CHUNK_MAX = 2400;
const INSERT_BATCH = 500;

export class MaterialNotReadyError extends Error {
  constructor(public code: 'UNSUPPORTED' | 'EMPTY' | 'FAILED', message: string) {
    super(message);
  }
}

type Listener = (progress: ProcessingProgress) => void;

// Runs in this server, so students waiting on the same file share one run
const running = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<Listener>>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Chunk {
  text: string;
  pageStart: number;
  pageEnd: number;
}

/** Cuts a paragraph longer than a chunk at sentence ends, or hard if it has none. */
const splitLong = (paragraph: string): string[] => {
  if (paragraph.length <= CHUNK_MAX) return [paragraph];
  const pieces: string[] = [];
  let current = '';
  for (const sentence of paragraph.match(/[^.!?\n]+[.!?]*\s*/g) ?? [paragraph]) {
    if (current && current.length + sentence.length > CHUNK_TARGET) {
      pieces.push(current.trim());
      current = '';
    }
    current += sentence;
    while (current.length > CHUNK_MAX) {
      pieces.push(current.slice(0, CHUNK_TARGET));
      current = current.slice(CHUNK_TARGET);
    }
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces;
};

/**
 * Groups paragraphs into chunks of about a page, remembering which pages each
 * covers. A chunk never crosses into a new topic, so each one is about one thing.
 */
const toChunks = (pages: string[], map: TopicMap): Chunk[] => {
  const chunks: Chunk[] = [];
  let current: Chunk | null = null;
  let currentPlace = '';

  pages.forEach((page, index) => {
    const pageNumber = index + 1;
    const where = locate(map, pageNumber);
    const place = `${where.chapter}|${where.topicTitle}`;
    if (current && place !== currentPlace) {
      chunks.push(current);
      current = null;
    }
    currentPlace = place;

    for (const paragraph of page.split(/\n\n+/).flatMap(splitLong)) {
      if (!paragraph.trim()) continue;
      if (current && current.text.length + paragraph.length > CHUNK_TARGET) {
        chunks.push(current);
        current = null;
      }
      current = current
        ? { ...current, text: `${current.text}\n\n${paragraph}`, pageEnd: pageNumber }
        : { text: paragraph, pageStart: pageNumber, pageEnd: pageNumber };
    }
  });
  if (current) chunks.push(current);
  return chunks;
};

const emit = (id: string, progress: ProcessingProgress) => listeners.get(id)?.forEach((listener) => listener(progress));

/** The actual work: read, map, chunk, embed, save. Runs once per material. */
const run = async (material: IMaterial, fileName: string, userId: string) => {
  const id = String(material._id);
  let lastSaved = 0;
  const progress = (next: ProcessingProgress, force = false) => {
    emit(id, next);
    if (force || Date.now() - lastSaved > SAVE_PROGRESS_MS) {
      lastSaved = Date.now();
      Material.updateOne({ _id: id }, { $set: { progress: next } }).catch(() => undefined);
    }
  };

  try {
    progress({ stage: 'reading', done: 0, total: 1 }, true);
    const buffer = await downloadObject(material.storagePath);
    const extracted = await extractText(buffer, fileName, material.contentType, (done, total) =>
      progress({ stage: 'scanning', done, total })
    );

    if (extracted.pages.join('').trim().length < 20) {
      throw new MaterialNotReadyError('EMPTY', "We couldn't find any text in this file");
    }

    progress({ stage: 'mapping', done: 0, total: 1 }, true);
    const { map, tokens: mapTokens } = await buildTopicMap(extracted.pages, extracted.outline, extracted.unit);

    const chunks = toChunks(extracted.pages, map).map((chunk, index) => ({ ...chunk, index, ...locate(map, chunk.pageStart) }));
    progress({ stage: 'indexing', done: 0, total: chunks.length }, true);
    // The chapter and topic go in with the text so a search for the topic finds it
    const { vectors, tokens: embedTokens } = await embed(
      chunks.map((chunk) => `${[chunk.chapterTitle, chunk.topicTitle].filter(Boolean).join(' › ')}\n\n${chunk.text}`),
      'RETRIEVAL_DOCUMENT',
      { onBatch: (done) => progress({ stage: 'indexing', done, total: chunks.length }) }
    );

    await MaterialChunk.deleteMany({ material: id });
    for (let start = 0; start < chunks.length; start += INSERT_BATCH) {
      await MaterialChunk.insertMany(
        chunks.slice(start, start + INSERT_BATCH).map((chunk, i) => ({
          material: id,
          ...chunk,
          embedding: vectors[start + i],
        })),
        { ordered: false }
      );
    }

    await Material.updateOne(
      { _id: id },
      {
        $set: {
          status: 'ready',
          pageCount: extracted.pages.length,
          scannedPages: extracted.scanned ?? 0,
          pageUnit: extracted.unit,
          map,
          chunkCount: chunks.length,
          progress: null,
          processedAt: new Date(),
          error: null,
        },
      }
    );

    // Shared work: logged for our costs, free for the student
    await recordUsage({ userId, feature: 'processing', engine: BACKGROUND_ENGINE.model, material: id, tokens: addTokens(extracted.tokens, mapTokens) });
    await recordUsage({ userId, feature: 'processing', engine: env.AI_EMBED_MODEL, material: id, tokens: embedTokens });
  } catch (error) {
    const code = error instanceof UnsupportedFileError ? 'UNSUPPORTED' : error instanceof MaterialNotReadyError ? error.code : 'FAILED';
    console.error(`Processing material ${id} failed:`, error);
    await Material.updateOne({ _id: id }, { $set: { status: 'failed', error: code, progress: null } });
    throw error;
  }
};

const messageFor = (code: string | null) =>
  code === 'UNSUPPORTED'
    ? "This file type can't be read by the AI yet. Try a PDF, Word, PowerPoint or text file."
    : code === 'EMPTY'
      ? "We couldn't find any text in this file."
      : "We couldn't read this file. Please try again.";

/**
 * Makes sure a material has been read, mapped and indexed, doing it now if it
 * hasn't. Called the first time a student uses the file with the AI; after
 * that it returns at once, for every student who has the same file.
 */
export const prepareMaterial = async (
  materialId: string,
  options: { fileName: string; userId: string; onProgress?: Listener }
): Promise<IMaterial> => {
  const { fileName, userId, onProgress } = options;
  const current = await Material.findById(materialId);
  if (!current) throw new MaterialNotReadyError('FAILED', 'File not found');
  if (current.status === 'ready') return current;
  if (current.status === 'failed' && current.error !== 'FAILED') {
    throw new MaterialNotReadyError(current.error as 'UNSUPPORTED' | 'EMPTY', messageFor(current.error));
  }

  if (onProgress) {
    if (!listeners.has(materialId)) listeners.set(materialId, new Set());
    listeners.get(materialId)!.add(onProgress);
  }

  try {
    let job = running.get(materialId);
    if (!job) {
      // Only one run at a time, across every server
      const claimed = await Material.findOneAndUpdate(
        {
          _id: materialId,
          $or: [
            { status: { $in: ['stored', 'failed'] } },
            { status: 'processing', processingAt: { $lt: new Date(Date.now() - STALE_AFTER_MS) } },
          ],
        },
        { $set: { status: 'processing', processingAt: new Date(), error: null } },
        { new: true }
      );
      if (claimed) {
        job = run(claimed, fileName, userId).finally(() => running.delete(materialId));
        running.set(materialId, job);
      }
    }

    if (job) {
      await job.catch(() => undefined);
    } else {
      // Another server is reading it: wait and pass its progress along
      let lastProgress = '';
      while (true) {
        await sleep(WAIT_POLL_MS);
        const latest = await Material.findById(materialId).select('status progress').lean();
        if (!latest || latest.status !== 'processing') break;
        const progress = JSON.stringify(latest.progress);
        if (latest.progress && progress !== lastProgress) {
          lastProgress = progress;
          onProgress?.(latest.progress);
        }
      }
    }
  } finally {
    if (onProgress) listeners.get(materialId)?.delete(onProgress);
  }

  const done = await Material.findById(materialId);
  if (done?.status === 'ready') return done;
  throw new MaterialNotReadyError((done?.error as 'UNSUPPORTED' | 'EMPTY' | 'FAILED') ?? 'FAILED', messageFor(done?.error ?? null));
};
