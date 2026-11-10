import crypto from 'crypto';
import { Types } from 'mongoose';
import CourseMastery from '../models/courseMastery.model';
import Material from '../models/material.model';
import Quiz from '../models/quiz.model';
import SpaceMember from '../models/spaceMember.model';
import User from '../models/user.model';
import Warmup from '../models/warmup.model';
import { ILibraryFile, IMaterial } from '../types/library';
import { CourseTopic, ICourseMastery, IWarmup } from '../types/progress';
import { ISpaceMaterial } from '../types/space';
import { pickQuestions, Slot, Source, Topic } from './ai/bank';
import { courseMapFor } from './ai/courseMap';

export const WARMUP_QUESTIONS = 10;
// Of the 10: this many on today's topic, the rest one each on related topics
const MAIN_QUESTIONS = 7;
const RELATED_TOPICS = 3;
// Questions kept in each topic's bank per file, so a retry gets fresh ones
const WARMUP_BANK = 8;
// About 40 seconds a question
export const WARMUP_MINUTES = 7;

export type Course = { _id: Types.ObjectId; code: string; title: string; materials: ISpaceMaterial[] };

const due = (mastery: ICourseMastery | undefined, now: number) =>
  Boolean(mastery?.reviewAt && mastery.reviewAt.getTime() <= now);

/**
 * Picks today's topic from the whole course (there's no fixed order to follow):
 * 1. a weak topic that's due, weakest first ("retry" under 50%, else "recheck")
 * 2. a topic not practised yet, newest materials first: that's likely what class is on ("next")
 * 3. a mastered topic due for review ("review")
 * 4. the topic practised longest ago
 * Then up to 3 related topics for one question each: weak or due ones first,
 * then the least recently practised, then new ones.
 */
export const chooseCourseTopics = (topics: CourseTopic[], masteries: Map<string, ICourseMastery>, now = Date.now()) => {
  if (!topics.length) return null;
  const of = (topic: CourseTopic) => masteries.get(topic.key);
  const weak = topics
    .filter((topic) => of(topic)?.status === 'learning' && due(of(topic), now))
    .sort((a, b) => of(a)!.mastery - of(b)!.mastery);
  const untouched = topics
    .filter((topic) => !of(topic) || of(topic)!.status === 'new')
    .sort((a, b) => new Date(b.newest).getTime() - new Date(a.newest).getTime());
  const masteredDue = topics
    .filter((topic) => of(topic)?.status === 'mastered' && due(of(topic), now))
    .sort((a, b) => of(a)!.reviewAt!.getTime() - of(b)!.reviewAt!.getTime());
  const practised = topics
    .filter((topic) => of(topic)?.lastPracticedAt)
    .sort((a, b) => of(a)!.lastPracticedAt!.getTime() - of(b)!.lastPracticedAt!.getTime());

  let main: CourseTopic;
  let reason: IWarmup['reason'];
  if (weak[0]) {
    main = weak[0];
    reason = (of(main)!.lastScore ?? 0) < 50 ? 'retry' : 'recheck';
  } else if (untouched[0]) {
    main = untouched[0];
    reason = 'next';
  } else if (masteredDue[0]) {
    main = masteredDue[0];
    reason = 'review';
  } else {
    main = practised[0] ?? topics[0];
    reason = 'review';
  }

  const related: CourseTopic[] = [];
  for (const topic of [...weak, ...masteredDue, ...practised, ...untouched]) {
    if (related.length >= RELATED_TOPICS) break;
    if (topic !== main && !related.includes(topic)) related.push(topic);
  }
  return { main, related, reason };
};

/** The pieces `pickQuestions` works with: one topic of one material. */
const slotsFor = (topic: CourseTopic, need: number, materials: Map<string, IMaterial>): Slot[] => {
  const usable = topic.sources.filter((source) => materials.has(String(source.material)));
  if (!usable.length || need <= 0) return [];
  // Spread the questions over the files that cover the topic
  const counts = usable.map(() => 0);
  for (let i = 0; i < need; i++) counts[i % usable.length]++;
  return usable
    .map((source, index) => {
      const material = materials.get(String(source.material))!;
      const topicInFile: Topic = {
        key: source.topicKey,
        chapterTitle: topic.title,
        topicTitle: topic.title,
        pageStart: source.pageStart,
        pageEnd: source.pageEnd,
        concepts: topic.concepts,
      };
      // The course material stands in for a library file: its id opens it in the space
      const file = { _id: source.spaceMaterial, name: source.fileName } as unknown as ILibraryFile;
      return { source: { material, file } as Source, topic: topicInFile, need: counts[index] };
    })
    .filter((slot) => slot.need > 0);
};

/**
 * Prepares a student's warm-up for one class: 10 medium questions that test
 * understanding, from that class's course materials only. Returns the one
 * already made, or null when warm-ups are off (for the student, the space or
 * this course) or the course has no readable materials.
 */
export const prepareWarmup = async (
  userId: string,
  space: { _id: Types.ObjectId; rules?: { warmups?: boolean } },
  entry: { _id: Types.ObjectId; courseCode: string },
  course: Course,
  date: string
): Promise<IWarmup | null> => {
  const existing = await Warmup.findOne({ user: userId, entry: entry._id, date });
  if (existing) return existing;
  if (space.rules?.warmups === false) return null;

  const [user, member] = await Promise.all([
    User.findById(userId).select('warmups').lean(),
    SpaceMember.findOne({ space: space._id, user: userId, status: 'active' }).select('mutedCourses').lean(),
  ]);
  if (!user || user.warmups === false || !member) return null;
  if (member.mutedCourses?.some((id) => String(id) === String(course._id))) return null;

  const map = await courseMapFor(space._id, course, userId);
  if (!map?.topics.length) return null;

  const masteries = new Map(
    (await CourseMastery.find({ user: userId, space: space._id, course: course._id }).lean<ICourseMastery[]>()).map((entry) => [
      entry.topicKey,
      entry,
    ])
  );
  const choice = chooseCourseTopics(map.topics, masteries);
  if (!choice) return null;

  const materialIds = [...new Set(map.topics.flatMap((topic) => topic.sources.map((source) => String(source.material))))];
  const materials = new Map(
    (await Material.find({ _id: { $in: materialIds }, status: 'ready' })).map((material) => [String(material._id), material])
  );
  const relatedCount = Math.min(choice.related.length, WARMUP_QUESTIONS - MAIN_QUESTIONS);
  const slots = [
    ...slotsFor(choice.main, WARMUP_QUESTIONS - relatedCount, materials),
    ...choice.related.slice(0, relatedCount).flatMap((topic) => slotsFor(topic, 1, materials)),
  ];
  if (!slots.length) return null;

  const seen = new Set((await Quiz.distinct('questions.bankItem', { owner: userId })).filter(Boolean).map(String));
  const picked = await pickQuestions({
    userId,
    sources: slots.map((slot) => slot.source),
    count: WARMUP_QUESTIONS,
    difficulty: 'medium',
    types: ['mcqs', 'true-false'],
    seen,
    slots,
    minBank: WARMUP_BANK,
    deep: true,
  });
  // Short of 10 (a question failed its check)? Top up from today's topic, then the rest of the course
  if (picked.length < WARMUP_QUESTIONS) {
    const taken = new Set([...seen, ...picked.map(({ item }) => String(item._id))]);
    for (const topic of [choice.main, ...choice.related, ...map.topics]) {
      const short = WARMUP_QUESTIONS - picked.length;
      if (short <= 0) break;
      const extra = await pickQuestions({
        userId,
        sources: [],
        count: short,
        difficulty: 'medium',
        types: ['mcqs', 'true-false'],
        seen: taken,
        slots: slotsFor(topic, short, materials),
        deep: true,
      });
      for (const pick of extra) {
        if (picked.length >= WARMUP_QUESTIONS || taken.has(String(pick.item._id))) continue;
        taken.add(String(pick.item._id));
        picked.push(pick);
      }
    }
  }
  if (!picked.length) return null;

  const code = course.code || entry.courseCode;
  const quiz = await Quiz.create({
    owner: userId,
    title: `${code ? `${code} ` : ''}warm-up: ${choice.main.title}`,
    method: 'warmup',
    space: space._id,
    difficulty: 'medium',
    types: [...new Set(picked.map(({ item }) => item.type))],
    sourceName: course.title,
    settings: { timeLimit: null, retakes: 1, randomize: false, showResults: true, hints: true, visibility: 'private' },
    questions: picked.map(({ item, file }) => ({
      id: crypto.randomUUID(),
      type: item.type,
      prompt: item.prompt,
      choices: item.choices,
      correct: item.correct,
      explanation: item.explanation,
      hint: item.hint,
      quote: item.quote,
      sourceTitle: file.name,
      spaceMaterial: file._id,
      image: null,
      choiceImages: [],
      bankItem: item._id,
      fileId: null,
      pageStart: item.pageStart,
      pageEnd: item.pageEnd,
    })),
  });

  try {
    return await Warmup.create({
      user: userId,
      space: space._id,
      entry: entry._id,
      date,
      courseCode: code,
      course: course._id,
      quiz: quiz._id,
      topicKey: choice.main.key,
      topicTitle: choice.main.title,
      position: 0,
      totalTopics: map.topics.length,
      covered: [...masteries.values()].filter((entry) => entry.answered > 0).length,
      reason: choice.reason,
    });
  } catch (error) {
    // Made twice at once: keep the first
    await Quiz.deleteOne({ _id: quiz._id });
    if ((error as { code?: number }).code === 11000) return Warmup.findOne({ user: userId, entry: entry._id, date });
    throw error;
  }
};
