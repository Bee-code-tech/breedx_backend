import { Schema, model } from 'mongoose';
import { IReadingProgress } from '../types/activity';

const readingProgressSchema = new Schema<IReadingProgress>({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  file: { type: Schema.Types.ObjectId, ref: 'LibraryFile', required: true },
  library: { type: Schema.Types.ObjectId, ref: 'Library', required: true },
  page: { type: Number, default: 1 },
  pageCount: { type: Number, default: null },
  furthestPage: { type: Number, default: 1 },
  lastOpenedAt: { type: Date, default: Date.now },
});

readingProgressSchema.index({ user: 1, file: 1 }, { unique: true });
readingProgressSchema.index({ user: 1, lastOpenedAt: -1 });

const ReadingProgress = model<IReadingProgress>('ReadingProgress', readingProgressSchema);
export default ReadingProgress;
