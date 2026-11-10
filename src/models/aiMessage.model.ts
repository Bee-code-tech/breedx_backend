import { Schema, model } from 'mongoose';
import { AI_MODEL_IDS } from '../config/models';
import { IAiMessage } from '../types/ai';

const citationSchema = new Schema(
  {
    n: Number,
    fileId: Schema.Types.ObjectId,
    fileName: String,
    libraryId: Schema.Types.ObjectId,
    pageStart: Number,
    pageEnd: Number,
    unit: String,
    chapter: String,
    topic: String,
    text: String,
    spaceSlug: { type: String, default: null },
    spaceMaterialId: { type: Schema.Types.ObjectId, default: null },
  },
  { _id: false }
);

const aiMessageSchema = new Schema<IAiMessage>(
  {
    session: { type: Schema.Types.ObjectId, ref: 'AiSession', required: true },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, default: '' },
    sources: { type: [citationSchema], default: [] },
    cited: { type: [Number], default: [] },
    steps: { type: [{ _id: false, id: String, text: String, status: String }], default: [] },
    grounding: { type: String, enum: ['notes', 'mixed', 'general', null], default: null },
    status: { type: String, enum: ['complete', 'stopped', 'failed'], default: 'complete' },
    aiModel: { type: String, enum: [...AI_MODEL_IDS, null], default: null },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    energy: { type: Number, default: 0 },
    feedback: {
      type: new Schema({ rating: { type: String, enum: ['up', 'down'] }, comment: String, at: Date }, { _id: false }),
      default: null,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

aiMessageSchema.index({ session: 1, createdAt: 1 });

const AiMessage = model<IAiMessage>('AiMessage', aiMessageSchema);
export default AiMessage;
