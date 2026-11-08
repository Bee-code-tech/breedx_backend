import { Schema, model } from 'mongoose';
import { ISpaceMember, SPACE_ROLES } from '../types/space';

const spaceMemberSchema = new Schema<ISpaceMember>(
  {
    space: { type: Schema.Types.ObjectId, ref: 'Space', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    email: { type: String, lowercase: true, trim: true },
    role: { type: String, enum: SPACE_ROLES, default: 'member' },
    status: { type: String, enum: ['active', 'invited'], default: 'active' },
    joinedAt: { type: Date, default: Date.now },
    onHome: { type: Boolean },
    schedulePrefs: { type: Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true }
);

// One row per person per space
spaceMemberSchema.index({ space: 1, user: 1 }, { unique: true, partialFilterExpression: { user: { $exists: true } } });
spaceMemberSchema.index({ space: 1, email: 1 }, { unique: true, partialFilterExpression: { email: { $exists: true } } });
spaceMemberSchema.index({ user: 1, status: 1 });

export default model<ISpaceMember>('SpaceMember', spaceMemberSchema);
