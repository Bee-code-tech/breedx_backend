import { Document, Types } from 'mongoose';

export type TopicStatus = 'new' | 'learning' | 'mastered';

/**
 * How well a student knows one topic of one material. Quizzes and flashcards
 * update it; warm-ups and "weakest first" read it.
 */
export interface ITopicMastery extends Document {
  user: Types.ObjectId;
  material: Types.ObjectId;
  /** The topic's key in the material's topic map, e.g. c2t0. */
  topicKey: string;
  topicTitle: string;
  chapterTitle: string;
  /** 0 to 100. */
  mastery: number;
  status: TopicStatus;
  /** Questions answered on this topic, and how many were right. */
  answered: number;
  correct: number;
  lastScore: number | null;
  lastPracticedAt: Date | null;
  /** When the topic should come back: weak topics soon, mastered ones later and later. */
  reviewAt: Date | null;
  /** How many checks in a row it's passed since being mastered (sets the next gap). */
  reviewStage: number;
}

export type WarmupStatus = 'ready' | 'sent' | 'taken';

/** A short quiz on one topic, made before a class and sent 30 minutes before it starts. */
export interface IWarmup extends Document {
  user: Types.ObjectId;
  space: Types.ObjectId;
  /** The class on the timetable. */
  entry: Types.ObjectId;
  /** The class's local date, YYYY-MM-DD. */
  date: string;
  courseCode: string;
  /** The space course it came from. */
  course: Types.ObjectId | null;
  quiz: Types.ObjectId;
  /** Old library-based warm-ups only. */
  material: Types.ObjectId | null;
  topicKey: string;
  topicTitle: string;
  /** Where the topic sits on the course path: topic 3 of 12. */
  position: number;
  totalTopics: number;
  /** Course topics the student had practised before this warm-up. */
  covered: number;
  /** Why this topic: next on the path, a recheck of a weak one, or a review of a mastered one. */
  reason: 'next' | 'retry' | 'recheck' | 'review';
  status: WarmupStatus;
  score: number | null;
  createdAt: Date;
}

/** One topic of a course, merged from every course material that covers it. */
export interface CourseTopic {
  /** From the title, so it stays the same when the map is rebuilt. */
  key: string;
  title: string;
  concepts: string[];
  sources: {
    material: Types.ObjectId;
    /** The course material in the space (its id in the course), to open it. */
    spaceMaterial: Types.ObjectId;
    fileName: string;
    /** The topic's key in that material's own topic map. */
    topicKey: string;
    pageStart: number;
    pageEnd: number;
  }[];
  /** When its newest source was added: topics from new uploads are likely what class is on. */
  newest: Date;
}

/** A course's topics, merged across all its materials. Rebuilt when the materials change. */
export interface ICourseMap extends Document {
  space: Types.ObjectId;
  course: Types.ObjectId;
  /** The materials it was built from, so a change is spotted. */
  signature: string;
  topics: CourseTopic[];
  builtAt: Date;
}

/** How well a student knows one topic of a class's course. Warm-ups update it. */
export interface ICourseMastery extends Document {
  user: Types.ObjectId;
  space: Types.ObjectId;
  course: Types.ObjectId;
  topicKey: string;
  title: string;
  mastery: number;
  status: TopicStatus;
  answered: number;
  correct: number;
  lastScore: number | null;
  lastPracticedAt: Date | null;
  reviewAt: Date | null;
  reviewStage: number;
}
