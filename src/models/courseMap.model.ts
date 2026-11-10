import { Schema, model } from 'mongoose';
import { ICourseMap } from '../types/progress';

const courseMapSchema = new Schema<ICourseMap>({
  space: { type: Schema.Types.ObjectId, ref: 'Space', required: true },
  course: { type: Schema.Types.ObjectId, required: true },
  signature: { type: String, required: true },
  topics: { type: Schema.Types.Mixed, default: [] },
  builtAt: { type: Date, default: Date.now },
});

courseMapSchema.index({ space: 1, course: 1 }, { unique: true });

const CourseMap = model<ICourseMap>('CourseMap', courseMapSchema);
export default CourseMap;
