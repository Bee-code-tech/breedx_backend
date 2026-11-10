import { Document, Types } from 'mongoose';

export const ACTIVITY_KINDS = ['reading', 'ai', 'quiz', 'flashcards'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** One day a student studied, in their own timezone. Streaks are built from these. */
export interface IStudyDay extends Document {
  user: Types.ObjectId;
  /** YYYY-MM-DD in the student's timezone. */
  day: string;
  counts: Record<ActivityKind, number>;
  createdAt: Date;
  updatedAt: Date;
}

/** Where a student is in a file, for "Continue studying". */
export interface IReadingProgress extends Document {
  user: Types.ObjectId;
  file: Types.ObjectId;
  library: Types.ObjectId;
  page: number;
  /** From the viewer when the AI hasn't read the file yet. */
  pageCount: number | null;
  /** The furthest page reached, so jumping back doesn't lower the progress. */
  furthestPage: number;
  lastOpenedAt: Date;
}
