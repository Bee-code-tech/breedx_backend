import { Schema, model } from 'mongoose';
import { ILibraryFile, MATERIAL_CATEGORIES } from '../types/library';

const libraryFileSchema = new Schema<ILibraryFile>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    library: { type: Schema.Types.ObjectId, ref: 'Library', required: true, index: true },
    material: { type: Schema.Types.ObjectId, ref: 'Material', default: null, index: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, enum: Object.keys(MATERIAL_CATEGORIES), required: true },
    size: { type: Number, required: true },
    status: { type: String, enum: ['uploading', 'ready'], default: 'uploading' },
    uploadPath: { type: String, default: null },
    expiresAt: { type: Date, default: null },
    savedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Uploads that never finish disappear after expiresAt. The bucket's own
// lifecycle rule clears their half-uploaded files under uploads/
libraryFileSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, partialFilterExpression: { status: 'uploading' } }
);

const LibraryFile = model<ILibraryFile>('LibraryFile', libraryFileSchema);
export default LibraryFile;
