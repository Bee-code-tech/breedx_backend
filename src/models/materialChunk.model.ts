import { Schema, model } from 'mongoose';
import { IMaterialChunk } from '../types/ai';

// Searched by meaning through the Atlas Vector Search index "chunk_vector"
// (create it once with `npm run ai:indexes`)
const materialChunkSchema = new Schema<IMaterialChunk>({
  material: { type: Schema.Types.ObjectId, ref: 'Material', required: true },
  index: { type: Number, required: true },
  text: { type: String, required: true },
  pageStart: { type: Number, required: true },
  pageEnd: { type: Number, required: true },
  chapter: { type: Number, default: 0 },
  chapterTitle: { type: String, default: '' },
  topicTitle: { type: String, default: '' },
  embedding: { type: [Number], required: true, select: false },
});

materialChunkSchema.index({ material: 1, index: 1 });

const MaterialChunk = model<IMaterialChunk>('MaterialChunk', materialChunkSchema);
export default MaterialChunk;
