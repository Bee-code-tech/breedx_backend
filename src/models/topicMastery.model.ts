import { Schema, model } from 'mongoose';
import { ITopicMastery } from '../types/progress';

const topicMasterySchema = new Schema<ITopicMastery>({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  material: { type: Schema.Types.ObjectId, ref: 'Material', required: true },
  topicKey: { type: String, required: true },
  topicTitle: { type: String, default: '' },
  chapterTitle: { type: String, default: '' },
  mastery: { type: Number, default: 0 },
  status: { type: String, enum: ['new', 'learning', 'mastered'], default: 'new' },
  answered: { type: Number, default: 0 },
  correct: { type: Number, default: 0 },
  lastScore: { type: Number, default: null },
  lastPracticedAt: { type: Date, default: null },
  reviewAt: { type: Date, default: null },
  reviewStage: { type: Number, default: 0 },
});

topicMasterySchema.index({ user: 1, material: 1, topicKey: 1 }, { unique: true });
topicMasterySchema.index({ user: 1, mastery: 1 });

const TopicMastery = model<ITopicMastery>('TopicMastery', topicMasterySchema);
export default TopicMastery;
