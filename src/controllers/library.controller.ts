import { Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import env from '../config/env';
import Library from '../models/library.model';
import LibraryFile from '../models/libraryFile.model';
import Material from '../models/material.model';
import { AuthRequest } from '../types/auth';
import {
  ILibrary,
  ILibraryFile,
  LIBRARY_THEMES,
  LibraryTheme,
  MATERIAL_CATEGORIES,
  MaterialCategory,
} from '../types/library';
import { planFor, storageUsed, usageFor } from '../utils/plan';
import { sendError, sendSuccess } from '../utils/response';
import { createUploadUrl, deleteObject, getObject, moveObject, readObject } from '../utils/storage';

const NAME_MAX = 80;
const DESCRIPTION_MAX = 300;
const FILE_NAME_MAX = 200;
const UPLOAD_WINDOW_MS = 24 * 60 * 60 * 1000;
const ICON_PATTERN = /^[a-z0-9-]{1,40}$/;

// ── Shapes sent to the frontend ───────────────────────────────────────────────

const toPublicLibrary = (library: ILibrary, stats?: { files: number; bytes: number }) => ({
  id: library._id,
  name: library.name,
  description: library.description,
  icon: library.icon,
  theme: library.theme,
  fileCount: stats?.files ?? 0,
  sizeBytes: stats?.bytes ?? 0,
  createdAt: library.createdAt,
  updatedAt: library.updatedAt,
});

const toPublicFile = (file: ILibraryFile) => ({
  id: file._id,
  libraryId: file.library,
  name: file.name,
  category: file.category,
  size: file.size,
  status: file.status,
  saved: Boolean(file.savedAt),
  savedAt: file.savedAt,
  createdAt: file.createdAt,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const isId = (value: unknown): value is string => typeof value === 'string' && Types.ObjectId.isValid(value);

const extensionOf = (name: string) => {
  const parts = name.split('.');
  return parts.length < 2 ? '' : (parts.pop() ?? '').toLowerCase();
};

const isCategory = (value: unknown): value is MaterialCategory =>
  typeof value === 'string' && value in MATERIAL_CATEGORIES;

const categoryAccepts = (category: MaterialCategory, name: string) =>
  (MATERIAL_CATEGORIES[category] as readonly string[]).includes(extensionOf(name));

const findOwnLibrary = (userId: string, id: unknown) =>
  isId(id) ? Library.findOne({ _id: id, owner: userId }) : Promise.resolve(null);

const findOwnFile = (userId: string, libraryId: unknown, fileId: unknown) =>
  isId(libraryId) && isId(fileId)
    ? LibraryFile.findOne({ _id: fileId, library: libraryId, owner: userId })
    : Promise.resolve(null);

const planLimit = (res: Response, message: string, limit: string, statusCode = 403) =>
  sendError(res, message, statusCode, { code: 'PLAN_LIMIT', limit });

const formatBytes = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${Math.round(bytes / 1024 ** 3)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;

// Checks text fields shared by create and update. Returns an error message or the clean values.
const readLibraryFields = (body: Record<string, unknown>, partial: boolean) => {
  const fields: Partial<Pick<ILibrary, 'name' | 'description' | 'icon' | 'theme'>> = {};

  if (body.name !== undefined || !partial) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return { error: 'Library name is required' };
    if (name.length > NAME_MAX) return { error: `Library name must be ${NAME_MAX} characters or fewer` };
    fields.name = name;
  }

  if (body.description !== undefined) {
    if (typeof body.description !== 'string') return { error: 'Description must be text' };
    const description = body.description.trim();
    if (description.length > DESCRIPTION_MAX) {
      return { error: `Description must be ${DESCRIPTION_MAX} characters or fewer` };
    }
    fields.description = description;
  }

  if (body.icon !== undefined) {
    if (typeof body.icon !== 'string' || !ICON_PATTERN.test(body.icon)) return { error: 'Choose a valid icon' };
    fields.icon = body.icon;
  }

  if (body.theme !== undefined || !partial) {
    const theme = body.theme ?? LIBRARY_THEMES[0];
    if (!LIBRARY_THEMES.includes(theme as LibraryTheme)) return { error: 'Choose a valid colour' };
    fields.theme = theme as LibraryTheme;
  }

  return { fields };
};

/**
 * Deletes stored files nobody points to anymore. A file shared by several
 * libraries (or students) stays until the last one lets go of it.
 */
const releaseMaterials = async (materialIds: (Types.ObjectId | null)[]) => {
  const unique = [...new Set(materialIds.filter(Boolean).map(String))];

  for (const id of unique) {
    if (await LibraryFile.exists({ material: id })) continue;
    const material = await Material.findByIdAndDelete(id);
    // TODO: when AI processing lands, also delete this material's chunks and topic map
    if (material) await deleteObject(material.storagePath);
  }
};

/** Removes library entries and anything they leave behind in the bucket. */
const removeFiles = async (files: ILibraryFile[]) => {
  if (files.length === 0) return;
  await LibraryFile.deleteMany({ _id: { $in: files.map((file) => file._id) } });
  await Promise.all(files.filter((file) => file.uploadPath).map((file) => deleteObject(file.uploadPath as string)));
  await releaseMaterials(files.map((file) => file.material));
};

// ── Libraries ─────────────────────────────────────────────────────────────────

// GET /api/v1/libraries
export const listLibraries = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const [libraries, stats, usage] = await Promise.all([
      Library.find({ owner: userId }).sort({ createdAt: -1 }),
      LibraryFile.aggregate<{ _id: Types.ObjectId; files: number; bytes: number }>([
        { $match: { owner: new Types.ObjectId(userId), status: 'ready' } },
        { $group: { _id: '$library', files: { $sum: 1 }, bytes: { $sum: '$size' } } },
      ]),
      usageFor(userId),
    ]);

    const byLibrary = new Map(stats.map((item) => [String(item._id), item]));
    sendSuccess(res, {
      libraries: libraries.map((library) => toPublicLibrary(library, byLibrary.get(String(library._id)))),
      usage,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/libraries/usage
export const getUsage = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    sendSuccess(res, await usageFor(req.user!.id));
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/libraries
export const createLibrary = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const parsed = readLibraryFields(req.body ?? {}, false);
    if ('error' in parsed) {
      sendError(res, parsed.error as string, 400);
      return;
    }

    const { limits } = await planFor(userId);
    if (limits.libraries !== null) {
      const owned = await Library.countDocuments({ owner: userId });
      if (owned >= limits.libraries) {
        planLimit(
          res,
          `Your plan allows ${limits.libraries} ${limits.libraries === 1 ? 'library' : 'libraries'}. Upgrade to create more.`,
          'libraries'
        );
        return;
      }
    }

    const library = await Library.create({ ...parsed.fields, owner: userId });
    sendSuccess(res, { library: toPublicLibrary(library) }, 'Library created', 201);
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/libraries/:id
export const getLibrary = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const library = await findOwnLibrary(req.user!.id, req.params.id);
    if (!library) {
      sendError(res, 'Library not found', 404);
      return;
    }

    const files = await LibraryFile.find({ library: library._id, status: 'ready' }).sort({ createdAt: -1 });
    const bytes = files.reduce((sum, file) => sum + file.size, 0);
    sendSuccess(res, {
      library: toPublicLibrary(library, { files: files.length, bytes }),
      files: files.map(toPublicFile),
    });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/v1/libraries/:id
export const updateLibrary = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const library = await findOwnLibrary(req.user!.id, req.params.id);
    if (!library) {
      sendError(res, 'Library not found', 404);
      return;
    }

    const parsed = readLibraryFields(req.body ?? {}, true);
    if ('error' in parsed) {
      sendError(res, parsed.error as string, 400);
      return;
    }

    library.set(parsed.fields);
    await library.save();
    sendSuccess(res, { library: toPublicLibrary(library) }, 'Library updated');
  } catch (error) {
    next(error);
  }
};

// DELETE /api/v1/libraries/:id — its files go too, and the storage is freed
export const deleteLibrary = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const library = await findOwnLibrary(req.user!.id, req.params.id);
    if (!library) {
      sendError(res, 'Library not found', 404);
      return;
    }

    const files = await LibraryFile.find({ library: library._id });
    await library.deleteOne();
    await removeFiles(files);
    sendSuccess(res, { usage: await usageFor(req.user!.id) }, 'Library deleted');
  } catch (error) {
    next(error);
  }
};

// ── Uploads ───────────────────────────────────────────────────────────────────

// POST /api/v1/libraries/:id/uploads — step 1: check the limits and get an upload URL
export const startUpload = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const library = await findOwnLibrary(userId, req.params.id);
    if (!library) {
      sendError(res, 'Library not found', 404);
      return;
    }

    const { name, size, category } = req.body ?? {};
    const contentType =
      typeof req.body?.contentType === 'string' && req.body.contentType ? req.body.contentType : 'application/octet-stream';
    const fileName = typeof name === 'string' ? name.trim() : '';

    if (!fileName || fileName.length > FILE_NAME_MAX) {
      sendError(res, 'File name is required and must be 200 characters or fewer', 400);
      return;
    }
    if (!isCategory(category)) {
      sendError(res, 'Choose a category for this file', 400);
      return;
    }
    if (!categoryAccepts(category, fileName)) {
      sendError(res, `This category accepts ${MATERIAL_CATEGORIES[category].join(', ').toUpperCase()} files`, 400);
      return;
    }
    if (!Number.isInteger(size) || size <= 0) {
      sendError(res, 'File size is required', 400);
      return;
    }

    const { limits } = await planFor(userId);
    if (size > limits.maxFileBytes) {
      planLimit(res, `Files on your plan can be up to ${formatBytes(limits.maxFileBytes)}`, 'fileSize', 413);
      return;
    }

    const used = await storageUsed(userId);
    if (used + size > limits.storageBytes) {
      planLimit(
        res,
        `Not enough storage. You've used ${formatBytes(used)} of ${formatBytes(limits.storageBytes)}.`,
        'storage'
      );
      return;
    }

    const file = new LibraryFile({
      owner: userId,
      library: library._id,
      name: fileName,
      category,
      size,
      status: 'uploading',
      expiresAt: new Date(Date.now() + UPLOAD_WINDOW_MS),
    });
    file.uploadPath = `uploads/${userId}/${file._id}`;

    const origin = req.headers.origin;
    const uploadUrl = await createUploadUrl(
      file.uploadPath,
      contentType,
      origin && env.CLIENT_ORIGINS.includes(origin) ? origin : undefined
    );
    await file.save();

    sendSuccess(res, { file: toPublicFile(file), uploadUrl }, 'Upload started', 201);
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/libraries/:id/files/:fileId/complete — step 3, after the browser's PUT
export const completeUpload = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const file = await findOwnFile(userId, req.params.id, req.params.fileId);
    if (!file) {
      sendError(res, 'File not found', 404);
      return;
    }
    if (file.status === 'ready') {
      sendSuccess(res, { file: toPublicFile(file) }, 'File uploaded');
      return;
    }

    const uploadPath = file.uploadPath as string;
    const stored = await getObject(uploadPath);
    if (!stored) {
      sendError(res, "The upload hasn't finished yet", 409);
      return;
    }

    // Check again with the real size: the size sent at the start can't be trusted
    const { limits } = await planFor(userId);
    const used = await storageUsed(userId, String(file._id));
    if (stored.size > limits.maxFileBytes || used + stored.size > limits.storageBytes) {
      await removeFiles([file]);
      planLimit(res, 'This file is larger than your plan allows', stored.size > limits.maxFileBytes ? 'fileSize' : 'storage', 413);
      return;
    }

    // The same file already stored (by anyone)? Point to it and drop the new copy
    const fingerprint = { md5Hash: stored.md5Hash, crc32c: stored.crc32c, size: stored.size };
    let material = await Material.findOne(fingerprint);

    if (material) {
      await deleteObject(uploadPath);
    } else {
      const id = new Types.ObjectId();
      const storagePath = `materials/${id}`;
      await moveObject(uploadPath, storagePath);
      try {
        material = await Material.create({ _id: id, storagePath, contentType: stored.contentType, ...fingerprint });
      } catch (error) {
        // Someone stored the same file a moment ago: use theirs
        if ((error as { code?: number }).code !== 11000) throw error;
        await deleteObject(storagePath);
        material = await Material.findOne(fingerprint);
        if (!material) throw error;
      }
    }

    file.material = material._id as Types.ObjectId;
    file.size = stored.size;
    file.status = 'ready';
    file.uploadPath = null;
    file.expiresAt = null;
    await file.save();

    sendSuccess(res, { file: toPublicFile(file), usage: await usageFor(userId) }, 'File uploaded');
  } catch (error) {
    next(error);
  }
};

// ── Files ─────────────────────────────────────────────────────────────────────

// PATCH /api/v1/libraries/:id/files/:fileId — rename or recategorise
export const updateFile = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const file = await findOwnFile(req.user!.id, req.params.id, req.params.fileId);
    if (!file || file.status !== 'ready') {
      sendError(res, 'File not found', 404);
      return;
    }

    const { name, category } = req.body ?? {};
    const nextName = name === undefined ? file.name : typeof name === 'string' ? name.trim() : '';
    const nextCategory = category === undefined ? file.category : category;

    if (!nextName || nextName.length > FILE_NAME_MAX) {
      sendError(res, 'File name is required and must be 200 characters or fewer', 400);
      return;
    }
    if (extensionOf(nextName) !== extensionOf(file.name)) {
      sendError(res, 'Keep the file extension when renaming', 400);
      return;
    }
    if (!isCategory(nextCategory) || !categoryAccepts(nextCategory, nextName)) {
      sendError(res, "This file type doesn't fit that category", 400);
      return;
    }

    file.name = nextName;
    file.category = nextCategory;
    await file.save();
    sendSuccess(res, { file: toPublicFile(file) }, 'File updated');
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/libraries/:id/files/:fileId/copy — no extra storage: it's the same file
export const copyFile = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const file = await findOwnFile(userId, req.params.id, req.params.fileId);
    if (!file || file.status !== 'ready') {
      sendError(res, 'File not found', 404);
      return;
    }

    const ids: unknown[] = Array.isArray(req.body?.libraryIds) ? req.body.libraryIds : [];
    const targetIds = [...new Set(ids.filter(isId))].filter((id) => id !== String(file.library));
    if (targetIds.length === 0) {
      sendError(res, 'Choose at least one other library', 400);
      return;
    }

    const targets = await Library.find({ _id: { $in: targetIds }, owner: userId }).select('_id');
    if (targets.length !== targetIds.length) {
      sendError(res, 'Library not found', 404);
      return;
    }

    // Skip libraries that already hold this file
    const existing = await LibraryFile.find({ library: { $in: targetIds }, material: file.material }).select('library');
    const skip = new Set(existing.map((item) => String(item.library)));

    const copies = await LibraryFile.insertMany(
      targetIds
        .filter((id) => !skip.has(id))
        .map((library) => ({
          owner: userId,
          library,
          material: file.material,
          name: file.name,
          category: file.category,
          size: file.size,
          status: 'ready',
        }))
    );

    sendSuccess(res, { files: copies.map((copy) => toPublicFile(copy as unknown as ILibraryFile)) }, 'File copied', 201);
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/libraries/:id/files/:fileId/move
export const moveFile = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const file = await findOwnFile(userId, req.params.id, req.params.fileId);
    if (!file || file.status !== 'ready') {
      sendError(res, 'File not found', 404);
      return;
    }

    const target = await findOwnLibrary(userId, req.body?.libraryId);
    if (!target) {
      sendError(res, 'Library not found', 404);
      return;
    }
    if (String(target._id) === String(file.library)) {
      sendSuccess(res, { file: toPublicFile(file) }, 'File moved');
      return;
    }

    // Already there? Just drop this copy
    const duplicate = await LibraryFile.findOne({ library: target._id, material: file.material });
    if (duplicate) {
      await file.deleteOne();
      sendSuccess(res, { file: toPublicFile(duplicate) }, 'File moved');
      return;
    }

    file.library = target._id as Types.ObjectId;
    await file.save();
    sendSuccess(res, { file: toPublicFile(file) }, 'File moved');
  } catch (error) {
    next(error);
  }
};

// DELETE /api/v1/libraries/:id/files/:fileId — also cancels an unfinished upload
export const removeFile = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const file = await findOwnFile(req.user!.id, req.params.id, req.params.fileId);
    if (!file) {
      sendError(res, 'File not found', 404);
      return;
    }

    await removeFiles([file]);
    sendSuccess(res, { usage: await usageFor(req.user!.id) }, 'File removed');
  } catch (error) {
    next(error);
  }
};

// PUT and DELETE /api/v1/libraries/:id/files/:fileId/save
export const setSaved = (saved: boolean) => async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const file = await findOwnFile(req.user!.id, req.params.id, req.params.fileId);
    if (!file || file.status !== 'ready') {
      sendError(res, 'File not found', 404);
      return;
    }

    file.savedAt = saved ? (file.savedAt ?? new Date()) : null;
    await file.save();
    sendSuccess(res, { file: toPublicFile(file) }, saved ? 'File saved' : 'File unsaved');
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/libraries/saved
export const listSaved = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const files = await LibraryFile.find({ owner: req.user!.id, status: 'ready', savedAt: { $ne: null } })
      .sort({ savedAt: -1 })
      .populate<{ library: ILibrary }>('library', 'name');

    sendSuccess(res, {
      files: files.map((file) => ({
        ...toPublicFile(file as unknown as ILibraryFile),
        libraryId: file.library._id,
        libraryName: file.library.name,
      })),
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/libraries/:id/files/:fileId/content — streams the file to open or download
export const getFileContent = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const file = await findOwnFile(req.user!.id, req.params.id, req.params.fileId);
    const material = file?.status === 'ready' ? await Material.findById(file.material) : null;
    if (!file || !material) {
      sendError(res, 'File not found', 404);
      return;
    }

    res.setHeader('Content-Type', material.contentType);
    res.setHeader('Content-Length', String(material.size));
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.setHeader('Cache-Control', 'private, max-age=3600');

    readObject(material.storagePath)
      .on('error', (error) => (res.headersSent ? res.destroy(error) : next(error)))
      .pipe(res);
  } catch (error) {
    next(error);
  }
};
