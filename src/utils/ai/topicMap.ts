import { BACKGROUND_ENGINE } from '../../config/models';
import { ChapterEntry, PageUnit, TopicMap } from '../../types/library';
import { generateJson, TokenCount, ZERO_TOKENS } from './vertex';

// Most characters of the page-by-page digest sent to the AI. A 700-page book
// fits by showing less of each page
const DIGEST_CHARS = 120_000;
const MAX_CHAPTERS = 40;
const MAX_TOPICS = 15;
const MAX_CONCEPTS = 6;

const SCHEMA = {
  type: 'object',
  properties: {
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          startPage: { type: 'integer' },
          topics: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                startPage: { type: 'integer' },
                concepts: { type: 'array', items: { type: 'string' } },
              },
              required: ['title', 'startPage', 'concepts'],
            },
          },
        },
        required: ['title', 'startPage', 'topics'],
      },
    },
  },
  required: ['chapters'],
};

const SYSTEM =
  "You build the table of contents for a student's study material. You get the start of every page, " +
  'marked [p1], [p2]… Use those marker numbers as page numbers, never the numbers printed in the text. ' +
  'Return the chapters in order (the first starts on page 1; call front matter "Introduction"), the main topics ' +
  'in each chapter, and up to 6 key concepts per topic in a few words each. Use the material\'s own headings ' +
  'where it has them. A short handout can be one chapter. Keep titles short and clear.';

interface RawMap {
  chapters: { title: string; startPage: number; topics: { title: string; startPage: number; concepts: string[] }[] }[];
}

const clampPage = (page: unknown, last: number) => Math.min(Math.max(Math.round(Number(page) || 1), 1), last);

/** Puts the AI's answer in order, fixes impossible page numbers and works out where each part ends. */
const normalise = (raw: RawMap, pageCount: number): TopicMap => {
  const seen = new Set<number>();
  const chapters = (raw.chapters ?? [])
    .map((chapter) => ({ ...chapter, title: String(chapter.title ?? '').trim(), startPage: clampPage(chapter.startPage, pageCount) }))
    .filter((chapter) => chapter.title)
    .sort((a, b) => a.startPage - b.startPage)
    .filter((chapter) => !seen.has(chapter.startPage) && seen.add(chapter.startPage))
    .slice(0, MAX_CHAPTERS);

  if (!chapters.length) return fallbackMap(pageCount);
  chapters[0].startPage = 1;

  return {
    chapters: chapters.map((chapter, index): ChapterEntry => {
      const endPage = index + 1 < chapters.length ? chapters[index + 1].startPage - 1 : pageCount;
      const topicStarts = new Set<number>();
      const topics = (chapter.topics ?? [])
        .map((topic) => ({
          title: String(topic.title ?? '').trim(),
          startPage: Math.min(Math.max(clampPage(topic.startPage, pageCount), chapter.startPage), endPage),
          concepts: (topic.concepts ?? []).map((concept) => String(concept).trim()).filter(Boolean).slice(0, MAX_CONCEPTS),
        }))
        .filter((topic) => topic.title)
        .sort((a, b) => a.startPage - b.startPage)
        .filter((topic) => !topicStarts.has(topic.startPage) && topicStarts.add(topic.startPage))
        .slice(0, MAX_TOPICS);
      if (topics.length) topics[0].startPage = chapter.startPage;

      return {
        title: chapter.title,
        startPage: chapter.startPage,
        endPage,
        topics: topics.map((topic, i) => ({
          ...topic,
          endPage: i + 1 < topics.length ? topics[i + 1].startPage - 1 : endPage,
        })),
      };
    }),
  };
};

const fallbackMap = (pageCount: number): TopicMap => ({
  chapters: [{ title: 'Whole document', startPage: 1, endPage: pageCount, topics: [] }],
});

/** Builds the chapter → topic → concept map of a material from its pages. */
export const buildTopicMap = async (
  pages: string[],
  outline: { title: string; page: number }[],
  unit: PageUnit
): Promise<{ map: TopicMap; tokens: TokenCount }> => {
  const perPage = Math.max(60, Math.min(400, Math.floor(DIGEST_CHARS / Math.max(pages.length, 1))));
  const digest = pages
    .map((page, index) => `[p${index + 1}] ${page.replace(/\s+/g, ' ').slice(0, perPage)}`)
    .join('\n');
  const bookmarks = outline.length
    ? `The file's own bookmarks (title → page):\n${outline.map((item) => `${item.title} → ${item.page}`).join('\n')}\n\n`
    : '';
  const units = unit === 'page' ? 'pages' : unit === 'slide' ? 'slides' : 'sections';

  try {
    const { data, tokens } = await generateJson<RawMap>({
      engine: BACKGROUND_ENGINE,
      system: SYSTEM,
      json: SCHEMA,
      temperature: 0,
      prompt: `${bookmarks}The material has ${pages.length} ${units}:\n\n${digest}`,
    });
    return { map: normalise(data, pages.length), tokens };
  } catch (error) {
    console.error('Topic map failed, using a single chapter:', (error as Error).message);
    return { map: fallbackMap(pages.length), tokens: ZERO_TOKENS };
  }
};

/** The chapter and topic a page belongs to. */
export const locate = (map: TopicMap, page: number) => {
  const index = map.chapters.findIndex((chapter) => page >= chapter.startPage && page <= chapter.endPage);
  const chapter = map.chapters[Math.max(index, 0)];
  const topic = chapter?.topics.find((entry) => page >= entry.startPage && page <= entry.endPage);
  return { chapter: Math.max(index, 0), chapterTitle: chapter?.title ?? '', topicTitle: topic?.title ?? '' };
};
