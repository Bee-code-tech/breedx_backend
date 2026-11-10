import { Types } from 'mongoose';
import FlashcardBankItem from '../models/flashcardBankItem.model';
import LibraryFile from '../models/libraryFile.model';
import Material from '../models/material.model';
import MaterialChunk from '../models/materialChunk.model';
import QuizBankItem from '../models/quizBankItem.model';
import Space from '../models/space.model';
import { IMaterial } from '../types/library';
import { deleteObject, getObject, moveObject } from './storage';

/**
 * Turns a finished browser upload into a stored material. The same file
 * already stored (by anyone, in a library or a space) is reused and the new
 * copy dropped. Returns null when nothing has arrived at `uploadPath` yet.
 */
export const storeUpload = async (uploadPath: string): Promise<{ material: IMaterial; size: number } | null> => {
  const stored = await getObject(uploadPath);
  if (!stored) return null;

  const fingerprint = { md5Hash: stored.md5Hash, crc32c: stored.crc32c, size: stored.size };
  let material = await Material.findOne(fingerprint);
  if (material) {
    await deleteObject(uploadPath);
    return { material, size: stored.size };
  }

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
  return { material, size: stored.size };
};

/** The size an upload really has, before it's stored. */
export const uploadedSize = async (uploadPath: string) => (await getObject(uploadPath))?.size ?? null;

/**
 * Deletes stored materials that nothing uses any more: no library file and no
 * space course points to them. Their AI data (chunks, question and card
 * banks) goes with them.
 */
export const releaseMaterials = async (materialIds: (Types.ObjectId | string | null | undefined)[]) => {
  const unique = [...new Set(materialIds.filter(Boolean).map(String))];

  for (const id of unique) {
    if (await LibraryFile.exists({ material: id })) continue;
    if (await Space.exists({ 'courses.materials.material': id })) continue;
    const material = await Material.findByIdAndDelete(id);
    if (material) {
      await Promise.all([
        MaterialChunk.deleteMany({ material: material._id }),
        QuizBankItem.deleteMany({ material: material._id }),
        FlashcardBankItem.deleteMany({ material: material._id }),
      ]);
      await deleteObject(material.storagePath);
    }
  }
};

/** Space course uploads that never finished: removed after a day. Runs hourly. */
export const clearStaleMaterialUploads = async (now = new Date()) => {
  if (now.getUTCMinutes() !== 0) return;
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  await Space.updateMany(
    { 'courses.materials': { $elemMatch: { status: 'uploading', uploadedAt: { $lt: cutoff } } } },
    { $pull: { 'courses.$[].materials': { status: 'uploading', uploadedAt: { $lt: cutoff } } } }
  );
};
