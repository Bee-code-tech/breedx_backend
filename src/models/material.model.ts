import { Schema, model } from 'mongoose';
import { IMaterial } from '../types/library';

const materialSchema = new Schema<IMaterial>(
  {
    storagePath: { type: String, required: true },
    size: { type: Number, required: true },
    contentType: { type: String, default: 'application/octet-stream' },
    md5Hash: { type: String, required: true },
    crc32c: { type: String, required: true },
    pageCount: { type: Number, default: null },
    status: { type: String, enum: ['stored', 'processing', 'ready', 'failed'], default: 'stored' },
  },
  { timestamps: true }
);

// The same file uploaded twice, by anyone, is stored once
materialSchema.index({ md5Hash: 1, crc32c: 1, size: 1 }, { unique: true });

const Material = model<IMaterial>('Material', materialSchema);
export default Material;
