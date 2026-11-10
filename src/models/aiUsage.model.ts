import { Schema, model } from 'mongoose';
import { AI_MODEL_IDS } from '../config/models';
import { AI_FEATURES, IAiUsage } from '../types/ai';

const aiUsageSchema = new Schema<IAiUsage>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    feature: { type: String, enum: AI_FEATURES, required: true },
    aiModel: { type: String, enum: [...AI_MODEL_IDS, null], default: null },
    engine: { type: String, required: true },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    energy: { type: Number, default: 0 },
    material: { type: Schema.Types.ObjectId, ref: 'Material', default: null },
    session: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

aiUsageSchema.index({ user: 1, createdAt: -1 });
aiUsageSchema.index({ user: 1, aiModel: 1, createdAt: -1 });

const AiUsage = model<IAiUsage>('AiUsage', aiUsageSchema);
export default AiUsage;
