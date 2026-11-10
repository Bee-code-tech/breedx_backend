import { Schema, model } from 'mongoose';
import { IWarmup } from '../types/progress';

const warmupSchema = new Schema<IWarmup>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    space: { type: Schema.Types.ObjectId, ref: 'Space', required: true },
    entry: { type: Schema.Types.ObjectId, ref: 'ScheduleEntry', required: true },
    date: { type: String, required: true },
    courseCode: { type: String, default: '' },
    course: { type: Schema.Types.ObjectId, default: null },
    quiz: { type: Schema.Types.ObjectId, ref: 'Quiz', required: true },
    material: { type: Schema.Types.ObjectId, ref: 'Material', default: null },
    topicKey: { type: String, required: true },
    topicTitle: { type: String, default: '' },
    position: { type: Number, default: 1 },
    totalTopics: { type: Number, default: 1 },
    covered: { type: Number, default: 0 },
    reason: { type: String, enum: ['next', 'retry', 'recheck', 'review'], default: 'next' },
    status: { type: String, enum: ['ready', 'sent', 'taken'], default: 'ready' },
    score: { type: Number, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// One warm-up per student per class
warmupSchema.index({ user: 1, entry: 1, date: 1 }, { unique: true });
warmupSchema.index({ user: 1, createdAt: -1 });
warmupSchema.index({ quiz: 1 });

const Warmup = model<IWarmup>('Warmup', warmupSchema);
export default Warmup;
