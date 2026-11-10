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
    scannedPages: { type: Number, default: 0 },
    pageUnit: { type: String, enum: ['page', 'slide', 'section'], default: 'page' },
    status: { type: String, enum: ['stored', 'processing', 'ready', 'failed'], default: 'stored' },
    // Filled in the first time a student uses the file with the AI
    map: { type: Schema.Types.Mixed, default: null },
    chunkCount: { type: Number, default: 0 },
    progress: { type: Schema.Types.Mixed, default: null },
    processingAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true }
);

// The same file uploaded twice, by anyone, is stored once
materialSchema.index({ md5Hash: 1, crc32c: 1, size: 1 }, { unique: true });

const Material = model<IMaterial>('Material', materialSchema);
export default Material;
