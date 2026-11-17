import { Schema, model } from 'mongoose';
import { IStudentProfile, ITeacherGuide, ITutorEvent, ITutorSession } from '../types/tutor';

const teacherGuideSchema = new Schema<ITeacherGuide>({
  signature: { type: String, required: true, unique: true },
  sources: { type: Schema.Types.Mixed, default: [] },
  title: { type: String, default: '' },
  summary: { type: String, default: '' },
  goals: { type: Schema.Types.Mixed, default: [] },
  status: { type: String, enum: ['building', 'ready', 'failed'], default: 'building' },
  aiModel: { type: String, default: '' },
  dropped: { type: Number, default: 0 },
  builtAt: { type: Date, default: null },
});

const tutorSessionSchema = new Schema<ITutorSession>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    guide: { type: Schema.Types.ObjectId, ref: 'TeacherGuide', default: null },
    sources: { type: Schema.Types.Mixed, default: [] },
    scope: { type: Schema.Types.Mixed, required: true },
    title: { type: String, default: '' },
    focus: { type: String, default: '' },
    status: { type: String, enum: ['preparing', 'live', 'ended'], default: 'preparing' },
    stage: { type: String, enum: ['explain', 'check', 'reteach', 'wrap_up'], default: 'explain' },
    goalIndex: { type: Number, default: 0 },
    progress: { type: Schema.Types.Mixed, default: {} },
    pending: { type: Schema.Types.Mixed, default: null },
    lastGrade: { type: Schema.Types.Mixed, default: null },
    lastSay: { type: Schema.Types.Mixed, default: null },
    recentSays: { type: Schema.Types.Mixed, default: [] },
    beatSeq: { type: Number, default: 0 },
    misconceptions: { type: Schema.Types.Mixed, default: [] },
    asked: { type: [String], default: [] },
    grades: { type: [String], default: [] },
    taughtBeats: { type: Number, default: 0 },
    board: { type: Schema.Types.Mixed, default: { page: 1, title: '', elements: [], used: 0 } },
    boards: { type: Schema.Types.Mixed, default: [] },
    notes: { type: Schema.Types.Mixed, default: [] },
    messages: { type: Schema.Types.Mixed, default: [] },
    toolResults: { type: Schema.Types.Mixed, default: [] },
    provider: { type: String, enum: ['gemini', 'claude'], default: 'gemini' },
    voice: { type: String, enum: ['male', 'female', 'warm', 'calm'], default: 'male' },
    accent: { type: String, default: '' },
    minutes: { type: Number, default: 15 },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    tokens: { type: Schema.Types.Mixed, default: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    seq: { type: Number, default: 0 },
    summary: { type: String, default: '' },
  },
  { timestamps: true, minimize: false }
);
tutorSessionSchema.index({ user: 1, createdAt: -1 });

const tutorEventSchema = new Schema<ITutorEvent>({
  session: { type: Schema.Types.ObjectId, ref: 'TutorSession', required: true },
  seq: { type: Number, required: true },
  at: { type: Number, required: true },
  type: { type: String, required: true },
  data: { type: Schema.Types.Mixed, default: {} },
});
tutorEventSchema.index({ session: 1, seq: 1 }, { unique: true });

const studentProfileSchema = new Schema<IStudentProfile>({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  terms: { type: Schema.Types.Mixed, default: [] },
  misconceptions: { type: Schema.Types.Mixed, default: [] },
  styles: { type: Schema.Types.Mixed, default: { diagram: 0, analogy: 0, worked_example: 0 } },
  interests: { type: [String], default: [] },
});

export const TeacherGuide = model<ITeacherGuide>('TeacherGuide', teacherGuideSchema);
export const TutorSession = model<ITutorSession>('TutorSession', tutorSessionSchema);
export const TutorEvent = model<ITutorEvent>('TutorEvent', tutorEventSchema);
export const StudentProfile = model<IStudentProfile>('StudentProfile', studentProfileSchema);
