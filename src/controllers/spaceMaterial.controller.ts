import { NextFunction, Response } from 'express';
import { Types } from 'mongoose';
import env from '../config/env';
import Library from '../models/library.model';
import LibraryFile from '../models/libraryFile.model';
import Material from '../models/material.model';
import SpaceMember from '../models/spaceMember.model';
import User from '../models/user.model';
import { AuthRequest } from '../types/auth';
import { MaterialCategory } from '../types/library';
import { ISpace, ISpaceMaterial, MaterialFileType, SpaceRole } from '../types/space';
import { storeUpload, uploadedSize } from '../utils/materials';
import { notify } from '../utils/notify';
import { planFor, storageUsed } from '../utils/plan';
import { sendError, sendSuccess } from '../utils/response';
import { createUploadUrl, readObject } from '../utils/storage';
import { loadSpace } from './space.controller';

const NAME_MAX = 200;
// File types a course material can be
const EXTENSIONS: Record<string, MaterialFileType> = {
  pdf: 'pdf',
  doc: 'doc',
  docx: 'doc',
  txt: 'doc',
  md: 'doc',
  epub: 'doc',
  ppt: 'ppt',
  pptx: 'ppt',
  key: 'ppt',
};
// The library category a course material goes under when saved to a library
const CATEGORY_FOR: Record<MaterialFileType, MaterialCategory> = { pdf: 'pdfs', doc: 'texts', ppt: 'slides' };

const isId = (value: unknown): value is string => typeof value === 'string' && Types.ObjectId.isValid(value);
const canManage = (role: SpaceRole) => role === 'owner' || role === 'admin';
const extensionOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');

const formatBytes = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${Math.round(bytes / 1024 ** 3)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;

const planLimit = (res: Response, message: string, limit: string, status = 403) =>
  sendError(res, message, status, { code: 'PLAN_LIMIT', limit });

const findMaterial = (space: ISpace, materialId: unknown) => {
  if (!isId(materialId)) return null;
  for (const course of space.courses) {
    const material = course.materials.id(materialId);
    if (material) return { course, material: material as ISpaceMaterial & Types.Subdocument };
  }
  return null;
};

export const toPublicMaterial = (material: ISpaceMaterial, courseId: Types.ObjectId | string) => ({
  id: String(material._id),
  courseId: String(courseId),
  title: material.title,
  fileType: material.fileType,
  size: material.size,
  status: material.status,
  // False for old materials added by name only, before uploads
  hasFile: Boolean(material.material),
  uploadedAt: material.uploadedAt,
});

/**
 * Starts uploading a course material. The browser then PUTs the file to
 * `uploadUrl` (straight to Google Cloud) and calls complete. Counts against
 * the uploader's storage.
 */
export const startMaterialUpload = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const { space, membership, userId } = found;
    if (!canManage(membership.role) && !space.rules.membersCanUpload) {
      sendError(res, 'Only the owner and admins can add materials here', 403);
      return;
    }
    const course = isId(req.params.courseId) ? space.courses.id(req.params.courseId) : null;
    if (!course) {
      sendError(res, 'Course not found', 404);
      return;
    }

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const size = req.body?.size;
    const contentType =
      typeof req.body?.contentType === 'string' && req.body.contentType ? req.body.contentType : 'application/octet-stream';
    if (!name || name.length > NAME_MAX) {
      sendError(res, `File name is required and must be ${NAME_MAX} characters or fewer`, 400);
      return;
    }
    const fileType = EXTENSIONS[extensionOf(name)];
    if (!fileType) {
      sendError(res, 'Add a PDF, Word, PowerPoint, Keynote, EPUB or text file', 400);
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
      planLimit(res, `Not enough storage. You've used ${formatBytes(used)} of ${formatBytes(limits.storageBytes)}.`, 'storage');
      return;
    }

    const uploader = await User.findById(userId).select('firstName lastName').lean();
    const id = new Types.ObjectId();
    const uploadPath = `uploads/${userId}/space-${id}`;
    const origin = req.headers.origin;
    const uploadUrl = await createUploadUrl(uploadPath, contentType, origin && env.CLIENT_ORIGINS.includes(origin) ? origin : undefined);

    course.materials.push({
      _id: id,
      title: name,
      fileType,
      uploadedBy: new Types.ObjectId(userId),
      uploadedByName: uploader ? `${uploader.firstName} ${uploader.lastName ?? ''}`.trim() : 'A student',
      uploadedAt: new Date(),
      material: null,
      size,
      status: 'uploading',
      uploadPath,
    } as unknown as ISpaceMaterial);
    await space.save();

    const material = course.materials.id(id) as unknown as ISpaceMaterial;
    sendSuccess(res, { material: toPublicMaterial(material, course._id), uploadUrl }, 'Upload started', 201);
  } catch (error) {
    next(error);
  }
};

/** Finishes an upload once the browser's PUT is done. Members hear about it. */
export const completeMaterialUpload = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const { space, userId } = found;
    const hit = findMaterial(space, req.params.materialId);
    if (!hit || String(hit.material.uploadedBy) !== userId) {
      sendError(res, 'Material not found', 404);
      return;
    }
    const { course, material } = hit;
    if (material.status === 'ready') {
      sendSuccess(res, { material: toPublicMaterial(material, course._id) }, 'Material added');
      return;
    }
    if (material.status !== 'uploading' || !material.uploadPath) {
      sendError(res, 'This material has no upload', 400);
      return;
    }

    // Check again with the real size: the size sent at the start can't be trusted
    const realSize = await uploadedSize(material.uploadPath);
    if (realSize === null) {
      sendError(res, "The upload hasn't finished yet", 409);
      return;
    }
    const { limits } = await planFor(userId);
    const used = await storageUsed(userId, String(material._id));
    if (realSize > limits.maxFileBytes || used + realSize > limits.storageBytes) {
      material.deleteOne();
      await space.save();
      planLimit(res, 'This file is larger than your plan allows', realSize > limits.maxFileBytes ? 'fileSize' : 'storage', 413);
      return;
    }

    const stored = await storeUpload(material.uploadPath);
    if (!stored) {
      sendError(res, "The upload hasn't finished yet", 409);
      return;
    }
    material.material = stored.material._id as Types.ObjectId;
    material.size = stored.size;
    material.status = 'ready';
    material.uploadPath = null;
    material.uploadedAt = new Date();
    await space.save();
    sendSuccess(res, { material: toPublicMaterial(material, course._id) }, 'Material added');

    // Everyone else in the space sees new materials under the bell, a day's worth in one
    const members = await SpaceMember.find({ space: space._id, status: 'active', user: { $ne: new Types.ObjectId(userId) } }).lean();
    const label = course.code || course.title;
    void notify(
      members.map((member) => member.user!).filter(Boolean),
      {
        category: 'spaces',
        kind: 'space-materials',
        title: '',
        link: `/classes/${space.slug}?tab=materials`,
        image: space.imageUrl ?? null,
        group: {
          key: `space-materials:${space._id}`,
          title: (count) => (count === 1 ? `${material.uploadedByName} added ${material.title} to ${label}` : `New materials in ${space.name}`),
          body: (count) => (count === 1 ? space.name : `${count} uploads today`),
        },
      }
    );
  } catch (error) {
    next(error);
  }
};

/** Streams a course material to any member, to read in the app. */
export const getMaterialContent = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const hit = findMaterial(found.space, req.params.materialId);
    const material = hit?.material.material ? await Material.findById(hit.material.material) : null;
    if (!hit || !material) {
      sendError(res, 'Material not found', 404);
      return;
    }
    res.setHeader('Content-Type', material.contentType);
    res.setHeader('Content-Length', String(material.size));
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(hit.material.title)}`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    readObject(material.storagePath)
      .on('error', (error) => (res.headersSent ? res.destroy(error) : next(error)))
      .pipe(res);
  } catch (error) {
    next(error);
  }
};

/**
 * Saves a course material to one of the student's libraries. It points at
 * the same stored file, so nothing is uploaded again; it counts once in
 * their storage.
 */
export const saveMaterialToLibrary = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const { space, userId } = found;
    const hit = findMaterial(space, req.params.materialId);
    if (!hit || !hit.material.material || hit.material.status !== 'ready') {
      sendError(res, 'Material not found', 404);
      return;
    }
    const library = isId(req.body?.libraryId) ? await Library.findOne({ _id: req.body.libraryId, owner: userId }) : null;
    if (!library) {
      sendError(res, 'Choose one of your libraries', 400);
      return;
    }

    const existing = await LibraryFile.findOne({ library: library._id, material: hit.material.material, status: 'ready' });
    if (existing) {
      sendSuccess(res, { fileId: existing._id, libraryId: library._id }, 'Already in this library');
      return;
    }
    // Only a file new to the student uses more storage
    const owned = await LibraryFile.exists({ owner: userId, material: hit.material.material, status: 'ready' });
    if (!owned) {
      const { limits } = await planFor(userId);
      const used = await storageUsed(userId);
      if (used + hit.material.size > limits.storageBytes) {
        planLimit(res, `Not enough storage. You've used ${formatBytes(used)} of ${formatBytes(limits.storageBytes)}.`, 'storage');
        return;
      }
    }

    const file = await LibraryFile.create({
      owner: userId,
      library: library._id,
      material: hit.material.material,
      name: hit.material.title,
      category: CATEGORY_FOR[hit.material.fileType],
      size: hit.material.size,
      status: 'ready',
    });
    sendSuccess(res, { fileId: file._id, libraryId: library._id }, `Saved to ${library.name}`, 201);
  } catch (error) {
    next(error);
  }
};
