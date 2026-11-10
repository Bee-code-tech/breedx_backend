import { Schema, model } from 'mongoose';
import { IStudyDay } from '../types/activity';

const studyDaySchema = new Schema<IStudyDay>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    day: { type: String, required: true },
    counts: {
      reading: { type: Number, default: 0 },
      ai: { type: Number, default: 0 },
      quiz: { type: Number, default: 0 },
      flashcards: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

studyDaySchema.index({ user: 1, day: -1 }, { unique: true });

const StudyDay = model<IStudyDay>('StudyDay', studyDaySchema);
export default StudyDay;
