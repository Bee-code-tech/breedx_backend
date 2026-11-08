import { Schema, model } from 'mongoose';
import {
  ISpace,
  MATERIAL_FILE_TYPES,
  SCHEDULE_KINDS,
  SPACE_PRIVACY,
} from '../types/space';

const materialSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    fileType: { type: String, enum: MATERIAL_FILE_TYPES, required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    uploadedByName: { type: String, required: true },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const courseSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    code: { type: String, default: '', trim: true },
    materials: { type: [materialSchema], default: [] },
  },
  { _id: true }
);

const spaceSchema = new Schema<ISpace>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true },
    school: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    reason: { type: String, trim: true },
    // A small square data URL, like profile photos
    imageUrl: { type: String, default: null },
    privacy: { type: String, enum: SPACE_PRIVACY, default: 'private' },
    rules: {
      membersCanUpload: { type: Boolean, default: true },
      membersCanInvite: { type: Boolean, default: false },
      approveNewMembers: { type: Boolean, default: false },
    },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    timezone: { type: String, default: 'Africa/Lagos' },
    courses: { type: [courseSchema], default: [] },
    scheduleUpdates: {
      type: [
        {
          kind: { type: String, enum: SCHEDULE_KINDS, required: true },
          title: { type: String, required: true },
          detail: { type: String, default: '' },
          postedBy: { type: String, required: true },
          at: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    upcomingTests: {
      type: [{ title: { type: String, required: true }, source: { type: String, default: '' }, date: { type: Date, required: true } }],
      default: [],
    },
    quizActivity: {
      type: [{ title: { type: String, required: true }, detail: { type: String, default: '' }, at: { type: Date, default: Date.now } }],
      default: [],
    },
  },
  { timestamps: true }
);

export default model<ISpace>('Space', spaceSchema);
