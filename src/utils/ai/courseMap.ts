import { Types } from 'mongoose';
import { BACKGROUND_ENGINE } from '../../config/models';
import CourseMap from '../../models/courseMap.model';
import { IMaterial } from '../../types/library';
import { CourseTopic, ICourseMap } from '../../types/progress';
import { ISpaceMaterial } from '../../types/space';
import { Topic, topicsOf } from './bank';
import { recordUsage } from './energy';
import { prepareMaterial } from './process';
import { generateJson } from './vertex';

// Most topics sent to the AI to merge in one go
const MERGE_LIMIT = 400;

const SCHEMA = {
  type: 'object',
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          concepts: { type: 'array', items: { type: 'string' } },
          members: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'concepts', 'members'],
      },
    },
  },
  required: ['topics'],
};

/** "Merge Sort & Stability" → "merge-sort-stability", so a topic keeps its key across rebuilds. */
const keyFor = (title: string) =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'topic';

export interface CourseSource {
  spaceMaterial: ISpaceMaterial;
  material: IMaterial;
}

type Entry = { id: string; source: CourseSource; topic: Topic };

/**
 * Reads each ready course material (any not read yet are read now) and returns
 * them. Files the AI can't read are left out.
 */
export const courseSources = async (
  materials: ISpaceMaterial[],
  userId: string
): Promise<CourseSource[]> => {
  const sources: CourseSource[] = [];
  for (const spaceMaterial of materials) {
    if (spaceMaterial.status !== 'ready' || !spaceMaterial.material) continue;
    try {
      const material = await prepareMaterial(String(spaceMaterial.material), { fileName: spaceMaterial.title, userId });
      sources.push({ spaceMaterial, material });
    } catch {
      // Unreadable: skipped
    }
  }
  return sources;
};

/**
 * The course's topic map: every topic of every course material, with the same
 * topic from different files merged into one. Built once, shared by the whole
 * class, and rebuilt only when the course's files change. Null when the course
 * has no readable materials.
 */
export const courseMapFor = async (
  spaceId: Types.ObjectId,
  course: { _id: Types.ObjectId; title: string; code: string; materials: ISpaceMaterial[] },
  userId: string
): Promise<ICourseMap | null> => {
  const ready = course.materials.filter((material) => material.status === 'ready' && material.material);
  if (!ready.length) return null;
  const signature = ready
    .map((material) => String(material.material))
    .sort()
    .join(',');
  const existing = await CourseMap.findOne({ space: spaceId, course: course._id });
  if (existing && existing.signature === signature) return existing;

  const sources = await courseSources(ready, userId);
  if (!sources.length) return null;

  const entries: Entry[] = sources.flatMap((source, index) =>
    topicsOf(source.material.map).map((topic) => ({ id: `m${index}:${topic.key}`, source, topic }))
  );
  if (!entries.length) return null;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  // One file: its topics are the course's. Several: the AI merges the same topic across files
  let groups: { title: string; concepts: string[]; members: string[] }[] = entries.map((entry) => ({
    title: entry.topic.topicTitle,
    concepts: entry.topic.concepts,
    members: [entry.id],
  }));
  if (sources.length > 1) {
    const previous = (existing?.topics ?? []).map((topic) => topic.title);
    const listing = entries
      .slice(0, MERGE_LIMIT)
      .map(
        (entry) =>
          `${entry.id} | ${entry.source.spaceMaterial.title} | ${entry.topic.chapterTitle} › ${entry.topic.topicTitle}` +
          (entry.topic.concepts.length ? ` (${entry.topic.concepts.join(', ')})` : '')
      )
      .join('\n');
    try {
      const { data, tokens } = await generateJson<{ topics: typeof groups }>({
        engine: BACKGROUND_ENGINE,
        temperature: 0,
        json: SCHEMA,
        system:
          `You organise the topics of a university course${course.code ? ` (${course.code} ${course.title})` : ''} taught from several files: ` +
          'lecture slides, textbooks, notes and past questions. Group entries that cover the SAME topic, even when worded differently, ' +
          'into one course topic. Keep genuinely different topics apart. Give each course topic a short, clear title and up to 6 key concepts. ' +
          'Every entry id must appear in exactly one topic.' +
          (previous.length ? ` Reuse these existing titles wherever they still fit: ${previous.join('; ')}.` : ''),
        prompt: `Entries (id | file | chapter › topic):\n${listing}`,
      });
      await recordUsage({ userId, feature: 'quiz', engine: BACKGROUND_ENGINE.model, tokens });
      const seen = new Set<string>();
      const merged = (data.topics ?? [])
        .map((group) => ({
          title: String(group.title ?? '').trim(),
          concepts: (group.concepts ?? []).map(String).slice(0, 6),
          members: (group.members ?? []).filter((id) => byId.has(id) && !seen.has(id) && seen.add(id)),
        }))
        .filter((group) => group.title && group.members.length);
      // Anything the AI left out stays as its own topic
      const missed = entries.filter((entry) => !seen.has(entry.id));
      groups = [...merged, ...missed.map((entry) => ({ title: entry.topic.topicTitle, concepts: entry.topic.concepts, members: [entry.id] }))];
    } catch (error) {
      console.error('Merging course topics failed, keeping them per file:', (error as Error).message);
    }
  }

  const usedKeys = new Set<string>();
  const topics: CourseTopic[] = groups.map((group) => {
    let key = keyFor(group.title);
    for (let n = 2; usedKeys.has(key); n++) key = `${keyFor(group.title)}-${n}`;
    usedKeys.add(key);
    const members = group.members.map((id) => byId.get(id)!);
    return {
      key,
      title: group.title,
      concepts: group.concepts,
      sources: members.map((entry) => ({
        material: entry.source.material._id as Types.ObjectId,
        spaceMaterial: entry.source.spaceMaterial._id,
        fileName: entry.source.spaceMaterial.title,
        topicKey: entry.topic.key,
        pageStart: entry.topic.pageStart,
        pageEnd: entry.topic.pageEnd,
      })),
      newest: new Date(Math.max(...members.map((entry) => entry.source.spaceMaterial.uploadedAt.getTime()))),
    };
  });

  return CourseMap.findOneAndUpdate(
    { space: spaceId, course: course._id },
    { $set: { signature, topics, builtAt: new Date() } },
    { upsert: true, new: true }
  );
};
