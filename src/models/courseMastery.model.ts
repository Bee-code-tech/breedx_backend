import { Schema, model } from 'mongoose';
import { ICourseMastery } from '../types/progress';

const courseMasterySchema = new Schema<ICourseMastery>({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  space: { type: Schema.Types.ObjectId, ref: 'Space', required: true },
  course: { type: Schema.Types.ObjectId, required: true },
  topicKey: { type: String, required: true },
  title: { type: String, default: '' },
  mastery: { type: Number, default: 0 },
  status: { type: String, enum: ['new', 'learning', 'mastered'], default: 'new' },
  answered: { type: Number, default: 0 },
  correct: { type: Number, default: 0 },
  lastScore: { type: Number, default: null },
  lastPracticedAt: { type: Date, default: null },
  reviewAt: { type: Date, default: null },
  reviewStage: { type: Number, default: 0 },
});

courseMasterySchema.index({ user: 1, space: 1, course: 1, topicKey: 1 }, { unique: true });

const CourseMastery = model<ICourseMastery>('CourseMastery', courseMasterySchema);
export default CourseMastery;
