import { Schema, model } from 'mongoose';
import { CGPA_LEVELS, CGPA_SCALES, ICgpaRecord } from '../types/cgpa';

const courseSchema = new Schema(
  {
    id: { type: String, required: true },
    code: { type: String, default: '' },
    title: { type: String, default: '' },
    credits: { type: String, default: '' },
    grade: { type: String, default: '' },
  },
  { _id: false }
);

const levelSchema = new Schema(
  {
    id: { type: String, required: true },
    level: { type: String, enum: CGPA_LEVELS, required: true },
    session: { type: String, default: '' },
    semesters: {
      first: { type: [courseSchema], default: [] },
      second: { type: [courseSchema], default: [] },
    },
  },
  { _id: false }
);

const cgpaRecordSchema = new Schema<ICgpaRecord>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    scale: { type: String, enum: CGPA_SCALES, default: '5.0' },
    levels: { type: [levelSchema], default: [] },
  },
  { timestamps: true }
);

const CgpaRecord = model<ICgpaRecord>('CgpaRecord', cgpaRecordSchema);
export default CgpaRecord;
