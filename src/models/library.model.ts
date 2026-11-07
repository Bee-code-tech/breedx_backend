import { Schema, model } from 'mongoose';
import { ILibrary, LIBRARY_THEMES } from '../types/library';

const librarySchema = new Schema<ILibrary>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    icon: { type: String, default: 'folder' },
    theme: { type: String, enum: LIBRARY_THEMES, required: true },
  },
  { timestamps: true }
);

const Library = model<ILibrary>('Library', librarySchema);
export default Library;
