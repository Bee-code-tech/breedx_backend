import { Types } from 'mongoose';
import FlashcardBankItem from '../models/flashcardBankItem.model';
import QuizBankItem from '../models/quizBankItem.model';
import CourseMastery from '../models/courseMastery.model';
import TopicMastery from '../models/topicMastery.model';
import { IQuiz, ReviewRating } from '../types/quiz';
import { ITopicMastery, TopicStatus } from '../types/progress';

const DAY = 24 * 60 * 60 * 1000;

// A topic quiz at or above this moves the student on; below RETRY_BELOW repeats the topic
export const MASTERED_AT = 80;
export const RETRY_BELOW = 50;
// Days until a mastered topic comes back, growing each time it's passed again
const REVIEW_GAPS = [7, 21, 60];
const RECHECK_DAYS = 3;
// Fewer answers than this on a topic nudge its mastery but don't change its status
const MIN_ANSWERS_FOR_STATUS = 3;

const CARD_NUDGE: Record<ReviewRating, number> = { again: -6, hard: -3, good: 2, easy: 4 };

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

interface TopicRef {
  material: Types.ObjectId;
  topicKey: string;
  topicTitle: string;
  chapterTitle: string;
}

/** What a topic's next state is after a score: mastered and spaced out, rechecked soon, or retried next time. */
const nextState = (current: Pick<ITopicMastery, 'status' | 'reviewStage'> | null, score: number, now: number) => {
  if (score >= MASTERED_AT) {
    const stage = current?.status === 'mastered' ? Math.min(current.reviewStage + 1, REVIEW_GAPS.length - 1) : 0;
    return { status: 'mastered' as TopicStatus, reviewStage: stage, reviewAt: new Date(now + REVIEW_GAPS[stage] * DAY) };
  }
  if (score >= RETRY_BELOW) {
    return { status: 'learning' as TopicStatus, reviewStage: 0, reviewAt: new Date(now + RECHECK_DAYS * DAY) };
  }
  // Due straight away: the next warm-up repeats it with fresh questions
  return { status: 'learning' as TopicStatus, reviewStage: 0, reviewAt: new Date(now) };
};

/**
 * Updates the student's mastery of every topic a quiz attempt touched. Each
 * AI question knows its topic through its bank item; written questions are
 * skipped. Never throws.
 */
export const applyQuizResult = async (
  userId: string,
  quiz: Pick<IQuiz, 'questions'>,
  answers: { questionId: string; correct: boolean }[]
): Promise<{ topicKey: string; topicTitle: string; mastery: number; material: string; score: number; status: TopicStatus }[]> => {
  try {
    const bankIds = quiz.questions.map((question) => question.bankItem).filter(Boolean) as Types.ObjectId[];
    if (!bankIds.length) return [];
    const items = await QuizBankItem.find({ _id: { $in: bankIds } })
      .select('material topicKey topicTitle chapterTitle')
      .lean();
    const itemById = new Map(items.map((item) => [String(item._id), item]));
    const rightById = new Map(answers.map((answer) => [answer.questionId, answer.correct]));

    // Tally answers by topic
    const topics = new Map<string, TopicRef & { right: number; total: number }>();
    for (const question of quiz.questions) {
      const item = question.bankItem ? itemById.get(String(question.bankItem)) : null;
      if (!item) continue;
      const key = `${item.material}:${item.topicKey}`;
      if (!topics.has(key)) {
        topics.set(key, { material: item.material, topicKey: item.topicKey, topicTitle: item.topicTitle, chapterTitle: item.chapterTitle, right: 0, total: 0 });
      }
      const tally = topics.get(key)!;
      tally.total++;
      if (rightById.get(question.id)) tally.right++;
    }

    const now = Date.now();
    const results = [];
    for (const topic of topics.values()) {
      const score = Math.round((topic.right / topic.total) * 100);
      const current = await TopicMastery.findOne({ user: userId, material: topic.material, topicKey: topic.topicKey });
      const decisive = topic.total >= MIN_ANSWERS_FOR_STATUS;
      // A full topic quiz counts for a lot; one stray question in a mixed quiz, a little
      const weight = decisive ? 0.5 : 0.15;
      const mastery = current && current.answered ? clamp(current.mastery * (1 - weight) + score * weight) : clamp(score * (decisive ? 1 : 0.5));
      const state = decisive ? nextState(current, score, now) : null;
      // The number agrees with the status: mastered reads at least 80, a retry under 50
      const shown =
        state?.status === 'mastered'
          ? Math.max(mastery, MASTERED_AT)
          : state && score < RETRY_BELOW
            ? Math.min(mastery, RETRY_BELOW - 1)
            : mastery;

      await TopicMastery.updateOne(
        { user: userId, material: topic.material, topicKey: topic.topicKey },
        {
          $set: {
            topicTitle: topic.topicTitle,
            chapterTitle: topic.chapterTitle,
            mastery: shown,
            lastScore: score,
            lastPracticedAt: new Date(now),
            ...(state ?? (current?.status && current.status !== 'new' ? {} : { status: 'learning' })),
          },
          $inc: { answered: topic.total, correct: topic.right },
        },
        { upsert: true }
      );
      results.push({
        topicKey: topic.topicKey,
        topicTitle: topic.topicTitle,
        mastery: shown,
        material: String(topic.material),
        score,
        status: state?.status ?? current?.status ?? 'learning',
      });
    }
    return results;
  } catch (error) {
    console.error('Updating topic mastery failed:', error);
    return [];
  }
};

/** A flashcard review nudges its topic's mastery a little. Never throws. */
export const applyCardReview = async (userId: string, bankItem: Types.ObjectId | null, rating: ReviewRating) => {
  if (!bankItem) return;
  try {
    const item = await FlashcardBankItem.findById(bankItem).select('material topicKey topicTitle chapterTitle').lean();
    if (!item) return;
    const current = await TopicMastery.findOne({ user: userId, material: item.material, topicKey: item.topicKey }).lean();
    await TopicMastery.updateOne(
      { user: userId, material: item.material, topicKey: item.topicKey },
      {
        $set: {
          topicTitle: item.topicTitle,
          chapterTitle: item.chapterTitle,
          mastery: clamp((current?.mastery ?? 30) + CARD_NUDGE[rating]),
          lastPracticedAt: new Date(),
          ...(!current || current.status === 'new' ? { status: 'learning' } : {}),
        },
      },
      { upsert: true }
    );
  } catch (error) {
    console.error('Updating topic mastery from a card failed:', error);
  }
};

/**
 * The new mastery after answering `total` questions on a topic with `score`%.
 * Three or more answers decide its status (mastered, recheck, retry); fewer
 * only nudge the number. The number always agrees with the status.
 */
export const scoreTopic = (
  current: { mastery: number; answered: number; status: TopicStatus; reviewStage: number } | null,
  score: number,
  total: number,
  now = Date.now()
) => {
  const decisive = total >= MIN_ANSWERS_FOR_STATUS;
  const weight = decisive ? 0.5 : 0.15;
  const blended =
    current && current.answered ? clamp(current.mastery * (1 - weight) + score * weight) : clamp(score * (decisive ? 1 : 0.5));
  const state = decisive ? nextState(current, score, now) : null;
  const mastery =
    state?.status === 'mastered'
      ? Math.max(blended, MASTERED_AT)
      : state && score < RETRY_BELOW
        ? Math.min(blended, RETRY_BELOW - 1)
        : blended;
  return { mastery, state };
};

/**
 * A warm-up's answers update the student's mastery of each course topic they
 * touched. Questions map to course topics through the course map. Never throws.
 */
export const applyCourseResult = async (
  userId: string,
  space: Types.ObjectId,
  course: Types.ObjectId,
  topics: { key: string; title: string; sources: { material: Types.ObjectId; topicKey: string }[] }[],
  quiz: Pick<IQuiz, 'questions'>,
  answers: { questionId: string; correct: boolean }[]
) => {
  try {
    const courseTopicOf = new Map<string, { key: string; title: string }>();
    for (const topic of topics) {
      for (const source of topic.sources) courseTopicOf.set(`${source.material}:${source.topicKey}`, topic);
    }
    const bankIds = quiz.questions.map((question) => question.bankItem).filter(Boolean) as Types.ObjectId[];
    const items = await QuizBankItem.find({ _id: { $in: bankIds } }).select('material topicKey').lean();
    const itemById = new Map(items.map((item) => [String(item._id), item]));
    const rightById = new Map(answers.map((answer) => [answer.questionId, answer.correct]));

    const tally = new Map<string, { title: string; right: number; total: number }>();
    for (const question of quiz.questions) {
      const item = question.bankItem ? itemById.get(String(question.bankItem)) : null;
      const topic = item && courseTopicOf.get(`${item.material}:${item.topicKey}`);
      if (!topic) continue;
      const entry = tally.get(topic.key) ?? { title: topic.title, right: 0, total: 0 };
      entry.total++;
      if (rightById.get(question.id)) entry.right++;
      tally.set(topic.key, entry);
    }

    const now = Date.now();
    const results = [];
    for (const [topicKey, entry] of tally) {
      const score = Math.round((entry.right / entry.total) * 100);
      const current = await CourseMastery.findOne({ user: userId, space, course, topicKey }).lean();
      const { mastery, state } = scoreTopic(current, score, entry.total, now);
      await CourseMastery.updateOne(
        { user: userId, space, course, topicKey },
        {
          $set: {
            title: entry.title,
            mastery,
            lastScore: score,
            lastPracticedAt: new Date(now),
            ...(state ?? (current?.status && current.status !== 'new' ? {} : { status: 'learning' })),
          },
          $inc: { answered: entry.total, correct: entry.right },
        },
        { upsert: true }
      );
      results.push({ topicKey, topicTitle: entry.title, score, mastery, status: state?.status ?? current?.status ?? 'learning' });
    }
    return results;
  } catch (error) {
    console.error('Updating course mastery failed:', error);
    return [];
  }
};
