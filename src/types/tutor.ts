import { Document, Types } from 'mongoose';

export const CHECK_LEVELS = ['recall', 'explain_back', 'apply', 'spot_error'] as const;
export type CheckLevel = (typeof CHECK_LEVELS)[number];
export type AskLevel = 'probe' | CheckLevel | 'wrap_up';
export type TutorStage = 'explain' | 'check' | 'reteach' | 'wrap_up';
export type Grade = 'pass' | 'partial' | 'fail' | 'not_an_answer';

/** One source a topic is taught from: part of one stored material. */
export interface GuideSource {
  material: Types.ObjectId;
  topicKey: string;
  fileName: string;
  pageStart: number;
  pageEnd: number;
}

export interface GuideGoal {
  id: string;
  title: string;
  concept: string;
  prerequisites: string[];
  key_facts: { text: string; quote: string; page: number }[];
  misconceptions: { belief: string; why_wrong: string }[];
  styles: {
    diagram: { description: string; board: string };
    analogy: string;
    worked_example: string;
  };
  checks: {
    recall: { question: string; expected: string };
    explain_back: { question: string; expected: string };
    apply: { question: string; expected: string };
    spot_error: { claim: string; expected: string };
  };
}

/** How to teach one topic, built once from its sources and shared by everyone. */
export interface ITeacherGuide extends Document {
  /** Hash of the sources, so the same topic from the same files reuses the guide. */
  signature: string;
  sources: GuideSource[];
  title: string;
  summary: string;
  goals: GuideGoal[];
  status: 'building' | 'ready' | 'failed';
  aiModel: string;
  /** Facts dropped because their quote wasn't really in the notes. */
  dropped: number;
  builtAt: Date | null;
}

export interface BoardElement {
  id: string;
  kind: string;
  role: string;
  text?: string;
  target?: string;
  from?: string;
  to?: string;
  zone?: string;
  faded?: boolean;
  [key: string]: unknown;
}

export interface PendingAsk {
  goal_id: string;
  level: AskLevel;
  question: string;
  expected: string;
  options?: string[];
}

export interface ITutorSession extends Document {
  user: Types.ObjectId;
  /** Set when the session starts (the guide may still need building then). */
  guide: Types.ObjectId | null;
  sources: GuideSource[];
  /** Where it came from, to show and to link back. */
  scope: { kind: 'file' | 'course'; fileId?: Types.ObjectId; spaceId?: Types.ObjectId; courseId?: Types.ObjectId; topicKey: string };
  title: string;
  status: 'preparing' | 'live' | 'ended';
  stage: TutorStage;
  goalIndex: number;
  /** Per goal id: levels passed, and failed attempts per level. */
  progress: Record<string, { passed: CheckLevel[]; fails: Partial<Record<CheckLevel, number>> }>;
  pending: PendingAsk | null;
  /** Wrong beliefs the student showed this session, until a breakthrough clears them. */
  misconceptions: { concept: string; belief: string; quote: string; tries: number; resolved: boolean }[];
  /** Teaching beats on the current goal since it started (or since a reteach). */
  taughtBeats: number;
  /** Recent check results, for the student's pace. */
  grades: Grade[];
  /** The last few questions asked, so the tutor never asks the same thing twice. */
  asked: string[];
  /** The tutor's last spoken line as sent, sentence by sentence, to know what an interrupt cut off. */
  lastSay: { text: string }[] | null;
  /** The last few beats' spoken sentences by beat id, so an interrupt can name which beat it cut off. */
  recentSays: { beat: number; clips: string[] }[];
  /** Id of the last beat; each beat gets the next one. */
  beatSeq: number;
  /** The grader's verdict on the last answer, given to the tutor on its next turn. */
  lastGrade: { level: string; grade: Grade; reason: string } | null;
  /**
   * The board now. `used` is out of 100: measured by the app when it reports
   * (`measured`), otherwise estimated from what's drawn.
   */
  board: { page: number; title: string; elements: BoardElement[]; used: number; measured?: boolean };
  /** Finished boards, oldest first, for the thumbnail strip and looking back. */
  boards: { page: number; title: string; elements: BoardElement[]; endedAt: number }[];
  notes: { text: string; kind: string; at: number }[];
  /** The conversation with Claude, exactly as sent and returned. */
  messages: unknown[];
  /** Results for the last beat's tool calls, sent with the next message. */
  toolResults: { id: string; name: string; result: string; isError?: boolean }[];
  /** The AI it runs on, fixed when it's created, so switching TUTOR_PROVIDER never breaks a session. */
  provider: 'gemini' | 'claude';
  /** male (Charon) or female (Kore); warm/calm on older sessions. */
  voice: 'male' | 'female' | 'warm' | 'calm';
  /** Country code whose English accent the tutor speaks with, e.g. "NG". */
  accent: string;
  minutes: number;
  startedAt: Date | null;
  endedAt: Date | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Sequence number of the next recorded event. */
  seq: number;
  summary: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Everything that happened, in order, with its time: the session's recording. */
export interface ITutorEvent extends Document {
  session: Types.ObjectId;
  seq: number;
  /** Milliseconds since the session started. */
  at: number;
  type: 'beat' | 'student' | 'grade' | 'stage' | 'new_board' | 'end';
  data: Record<string, unknown>;
}

/** What the tutor remembers about how a student learns. They can see and delete it. */
export interface IStudentProfile extends Document {
  user: Types.ObjectId;
  terms: { concept: string; term: string; quote: string }[];
  misconceptions: { concept: string; belief: string; fixed: boolean }[];
  /** Explanation styles that led to a pass, counted. */
  styles: { diagram: number; analogy: number; worked_example: number };
  interests: string[];
}
