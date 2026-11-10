import { Document, Types } from 'mongoose';

export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

// Short-answer questions need AI marking, which comes later
export const QUESTION_TYPES = ['mcqs', 'true-false'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const TRUE_FALSE = ['True', 'False'];

/** Where in a material a bank item came from: a topic of its topic map. */
export interface BankPlace {
  material: Types.ObjectId;
  /** `c<chapter>t<topic>`, e.g. c2t0. A chapter without topics is `c2t-`. */
  topicKey: string;
  chapterTitle: string;
  topicTitle: string;
  pageStart: number;
  pageEnd: number;
}

/**
 * A checked quiz question made from one topic of a material. Shared by every
 * student with that file: generated once, reused for everyone's quizzes.
 */
export interface IQuizBankItem extends Document, BankPlace {
  type: QuestionType;
  difficulty: Difficulty;
  prompt: string;
  choices: string[];
  correct: number;
  explanation: string;
  /** A nudge without giving the answer away, for quizzes with hints on. */
  hint: string;
  /** `deep` questions test understanding (warm-ups); `basic` ones are the original quiz style. */
  depth: 'basic' | 'deep';
  /** The exact words in the notes that prove the answer, for "see it in your notes". */
  quote: string;
  /** What the question tests: define, apply, why, predict, spot-error, compare or calculate. */
  skill: string;
  createdAt: Date;
}

/** A checked flashcard made from one topic of a material, shared like quiz questions. */
export interface IFlashcardBankItem extends Document, BankPlace {
  difficulty: Difficulty;
  front: string;
  /** Two possible answers the student picks between; `correct` says which is right. */
  a1: string;
  a2: string;
  correct: 1 | 2;
  /** The full explanation shown on the back. */
  answer: string;
  createdAt: Date;
}

export interface QuizQuestion {
  /** Stable id within the quiz, used to match answers. */
  id: string;
  type: QuestionType;
  prompt: string;
  choices: string[];
  correct: number;
  explanation: string;
  hint: string;
  image: string | null;
  choiceImages: (string | null)[];
  /** The exact words in the notes that prove the answer, highlighted when the page opens. */
  quote: string;
  /** The file it came from, for "Lecture 3.pdf · p. 14". */
  sourceTitle: string;
  /** Warm-ups: the course material in the space it came from. */
  spaceMaterial: Types.ObjectId | null;
  /** Library quizzes: the library the file is in, to open it in Study. */
  libraryId?: Types.ObjectId | null;
  /** AI questions: the bank item and the pages it came from. */
  bankItem: Types.ObjectId | null;
  fileId: Types.ObjectId | null;
  pageStart: number | null;
  pageEnd: number | null;
}

export interface QuizSettings {
  /** Minutes, or null for no time limit. */
  timeLimit: number | null;
  /** Extra attempts after the first, or null for unlimited. */
  retakes: number | null;
  randomize: boolean;
  showResults: boolean;
  hints: boolean;
  /** `anyone` with the link can take it; `private` only the owner. */
  visibility: 'anyone' | 'private';
}

// Warm-ups are made for a class and don't count toward the daily limits
export type QuizMethod = 'ai' | 'manual' | 'import' | 'warmup';

export interface IQuiz extends Document {
  owner: Types.ObjectId;
  /** Warm-ups: the space whose course it came from. */
  space: Types.ObjectId | null;
  title: string;
  method: QuizMethod;
  difficulty: Difficulty;
  types: QuestionType[];
  /** What it was made from, for the card: a file name, "3 files", "CSV File"… */
  sourceName: string;
  files: Types.ObjectId[];
  questions: QuizQuestion[];
  settings: QuizSettings;
  createdAt: Date;
  updatedAt: Date;
}

export interface IQuizAttempt extends Document {
  quiz: Types.ObjectId;
  /** Null for a guest who took it from the link without an account (until they sign up and claim it). */
  user: Types.ObjectId | null;
  /** A guest's browser id, so their retakes are counted. */
  guestId: string | null;
  /** Lets the guest attach this attempt to their account after signing up. */
  claimToken: string | null;
  /** True when the taker owns the quiz (a private take); false for a shared one. */
  own: boolean;
  /** A pre-class warm-up: free, outside the daily limits. */
  warmup: boolean;
  /** The chosen choice index per question id; null when skipped. */
  answers: { questionId: string; choice: number | null; correct: boolean }[];
  correct: number;
  total: number;
  score: number;
  seconds: number;
  createdAt: Date;
}

export const CARD_TAGS = ['navy', 'lime', 'blue', 'white'] as const;
export type CardTag = (typeof CARD_TAGS)[number];

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

export interface Flashcard {
  id: string;
  front: string;
  a1: string;
  a2: string;
  correct: 1 | 2;
  answer: string;
  difficulty: Difficulty;
  tag: CardTag;
  bankItem: Types.ObjectId | null;
  fileId: Types.ObjectId | null;
  pageStart: number | null;
  pageEnd: number | null;
  /** Spaced repetition: when it's next due, days between reviews, and how easy it's proving. */
  dueAt: Date;
  interval: number;
  ease: number;
  reviews: number;
}

export interface IFlashcardDeck extends Document {
  owner: Types.ObjectId;
  title: string;
  files: Types.ObjectId[];
  cards: Flashcard[];
  createdAt: Date;
  updatedAt: Date;
}
