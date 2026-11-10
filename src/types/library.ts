import { Document, Types } from 'mongoose';

// Card colours the frontend picks from
export const LIBRARY_THEMES = [
  'lime',
  'blue',
  'peach',
  'mint',
  'lavender',
  'pink',
  'lemon',
  'coral',
  'sky',
  'lilac',
  'aqua',
  'honey',
] as const;

export type LibraryTheme = (typeof LIBRARY_THEMES)[number];

// Upload categories and the file types each accepts, matching the frontend
export const MATERIAL_CATEGORIES = {
  pdfs: ['pdf'],
  notes: ['txt'],
  texts: ['pdf', 'epub', 'txt', 'md', 'doc', 'docx'],
  slides: ['ppt', 'pptx', 'key'],
  'past-questions': ['pdf', 'doc', 'docx', 'txt'],
} as const;

export type MaterialCategory = keyof typeof MATERIAL_CATEGORIES;

export type MaterialStatus = 'stored' | 'processing' | 'ready' | 'failed';

export type LibraryFileStatus = 'uploading' | 'ready';

export interface ILibrary extends Document {
  owner: Types.ObjectId;
  name: string;
  description: string;
  icon: string;
  theme: LibraryTheme;
  createdAt: Date;
  updatedAt: Date;
}

/** What a "page" is in a material: a PDF page, a slide, or a stretch of text for docs without pages. */
export type PageUnit = 'page' | 'slide' | 'section';

export interface TopicEntry {
  title: string;
  startPage: number;
  endPage: number;
  concepts: string[];
}

export interface ChapterEntry {
  title: string;
  startPage: number;
  endPage: number;
  topics: TopicEntry[];
}

/** The material's table of contents, built by the AI when it first reads it. */
export interface TopicMap {
  chapters: ChapterEntry[];
}

/** Where processing is, so students waiting on the same file can see it too. */
export interface ProcessingProgress {
  stage: 'reading' | 'scanning' | 'mapping' | 'indexing';
  done: number;
  total: number;
}

/** One stored file in the bucket, shared by every library entry that points to it. */
export interface IMaterial extends Document {
  storagePath: string;
  size: number;
  contentType: string;
  md5Hash: string;
  crc32c: string;
  /** Filled in when the AI first reads the file. */
  pageCount: number | null;
  /** Of those, how many were scanned images read with the AI. */
  scannedPages?: number;
  pageUnit: PageUnit;
  /** `stored` until the AI first reads it (only when a student prompts). */
  status: MaterialStatus;
  map: TopicMap | null;
  chunkCount: number;
  progress: ProcessingProgress | null;
  /** When processing last started, so a crashed run can be picked up again. */
  processingAt: Date | null;
  processedAt: Date | null;
  /** Why processing failed. `UNSUPPORTED` is never retried. */
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A file as it appears in one library: the student's name and category for it. */
export interface ILibraryFile extends Document {
  owner: Types.ObjectId;
  library: Types.ObjectId;
  /** Set once the upload finishes. */
  material: Types.ObjectId | null;
  name: string;
  category: MaterialCategory;
  size: number;
  status: LibraryFileStatus;
  /** Where the browser uploads to, before the file is checked. */
  uploadPath: string | null;
  /** Unfinished uploads are cleared after this. */
  expiresAt: Date | null;
  savedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
