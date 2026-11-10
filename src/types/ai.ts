import { Document, Types } from 'mongoose';
import { AiModelId } from '../config/models';

export const AI_FEATURES = ['processing', 'find', 'ask', 'study', 'simplify', 'quiz', 'flashcards'] as const;

export type AiFeature = (typeof AI_FEATURES)[number];

/** One AI request: what it cost us in tokens, and the student in energy. */
export interface IAiUsage extends Document {
  user: Types.ObjectId;
  feature: AiFeature;
  /** The BreedX model the student picked, or null for background work. */
  aiModel: AiModelId | null;
  /** The real model that ran. */
  engine: string;
  inputTokens: number;
  outputTokens: number;
  /** Energy taken from the student. 0 for free features such as Find. */
  energy: number;
  material: Types.ObjectId | null;
  session: Types.ObjectId | null;
  createdAt: Date;
}

/** A piece of a material, about a page long, ready for searching by meaning. */
export interface IMaterialChunk extends Document {
  material: Types.ObjectId;
  index: number;
  text: string;
  pageStart: number;
  pageEnd: number;
  chapter: number;
  chapterTitle: string;
  topicTitle: string;
  embedding: number[];
}

export const SESSION_MODES = ['ask'] as const;

export type SessionMode = (typeof SESSION_MODES)[number];

/** A saved AI chat, like a conversation in ChatGPT's sidebar. */
export interface IAiSession extends Document {
  owner: Types.ObjectId;
  mode: SessionMode;
  title: string;
  /** True once the AI has named it, or the student renamed it. */
  titled: boolean;
  /** What the chat covers: these files, else these libraries, else everything. */
  libraries: Types.ObjectId[];
  files: Types.ObjectId[];
  /** A space whose course materials the chat covers, optionally only some courses or materials. */
  space: Types.ObjectId | null;
  courses: Types.ObjectId[];
  spaceMaterials: Types.ObjectId[];
  /** The model last used, so the picker remembers it. */
  aiModel: AiModelId | null;
  /** Short summary of older messages, so long chats stay cheap. */
  summary: string;
  /** How many of the oldest messages `summary` covers. */
  summarizedCount: number;
  messageCount: number;
  energyUsed: number;
  lastMessageAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface Citation {
  /** The number used in the answer, as in [2]. */
  n: number;
  fileId: Types.ObjectId;
  fileName: string;
  libraryId: Types.ObjectId;
  pageStart: number;
  pageEnd: number;
  unit: string;
  chapter: string;
  topic: string;
  /** The passage the AI read, for a preview on tap. */
  text: string;
  /** Course materials: open with /spaces/:spaceSlug/materials/:spaceMaterialId. */
  spaceSlug?: string | null;
  spaceMaterialId?: Types.ObjectId | null;
}

export interface MessageStep {
  id: string;
  text: string;
  status: 'active' | 'done' | 'skipped';
}

export type Grounding = 'notes' | 'mixed' | 'general';

export interface IAiMessage extends Document {
  session: Types.ObjectId;
  owner: Types.ObjectId;
  role: 'user' | 'assistant';
  content: string;
  /** Answers only: the passages it was given. Those it used are in `cited`. */
  sources: Citation[];
  cited: number[];
  steps: MessageStep[];
  /** Whether the answer came from the student's notes, general knowledge, or both. */
  grounding: Grounding | null;
  status: 'complete' | 'stopped' | 'failed';
  aiModel: AiModelId | null;
  inputTokens: number;
  outputTokens: number;
  energy: number;
  feedback: { rating: 'up' | 'down'; comment: string; at: Date } | null;
  createdAt: Date;
}
