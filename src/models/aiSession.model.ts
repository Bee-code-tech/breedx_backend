import { Schema, model } from 'mongoose';
import { AI_MODEL_IDS } from '../config/models';
import { IAiSession, SESSION_MODES } from '../types/ai';

const aiSessionSchema = new Schema<IAiSession>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    mode: { type: String, enum: SESSION_MODES, default: 'ask' },
    title: { type: String, default: 'New chat', trim: true },
    titled: { type: Boolean, default: false },
    libraries: { type: [Schema.Types.ObjectId], ref: 'Library', default: [] },
    files: { type: [Schema.Types.ObjectId], ref: 'LibraryFile', default: [] },
    space: { type: Schema.Types.ObjectId, ref: 'Space', default: null },
    courses: { type: [Schema.Types.ObjectId], default: [] },
    spaceMaterials: { type: [Schema.Types.ObjectId], default: [] },
    aiModel: { type: String, enum: [...AI_MODEL_IDS, null], default: null },
    summary: { type: String, default: '' },
    summarizedCount: { type: Number, default: 0 },
    messageCount: { type: Number, default: 0 },
    energyUsed: { type: Number, default: 0 },
    lastMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

aiSessionSchema.index({ owner: 1, mode: 1, lastMessageAt: -1 });

const AiSession = model<IAiSession>('AiSession', aiSessionSchema);
export default AiSession;
