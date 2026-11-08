import { Schema, model } from 'mongoose';
import { IScheduleEntry, SCHEDULE_ENTRY_KINDS } from '../types/space';

const scheduleEntrySchema = new Schema<IScheduleEntry>(
  {
    space: { type: Schema.Types.ObjectId, ref: 'Space', required: true },
    kind: { type: String, enum: SCHEDULE_ENTRY_KINDS, required: true },
    day: { type: Number, min: 1, max: 7 },
    date: { type: String },
    course: { type: Schema.Types.ObjectId },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    courseCode: { type: String, default: '', trim: true },
    title: { type: String, default: '', trim: true },
    venue: { type: String, default: '', trim: true },
    note: { type: String, default: '', trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    owner: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

scheduleEntrySchema.index({ space: 1, kind: 1, owner: 1 });
// The reminder loop looks entries up by when they start
scheduleEntrySchema.index({ kind: 1, day: 1, startTime: 1 });
scheduleEntrySchema.index({ kind: 1, date: 1, startTime: 1 });

export default model<IScheduleEntry>('ScheduleEntry', scheduleEntrySchema);
