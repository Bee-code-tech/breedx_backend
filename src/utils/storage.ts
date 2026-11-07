import { Storage } from '@google-cloud/storage';
import env from '../config/env';

// Uses the VM's service account in production, and your gcloud login locally
const bucket = new Storage().bucket(env.GCS_BUCKET);

/**
 * Starts a resumable upload and returns its URL. The browser sends the file
 * straight to Google Cloud with a PUT to this URL, so it never passes through
 * our server. The URL only works for this one file.
 */
export const createUploadUrl = async (path: string, contentType: string, origin?: string): Promise<string> => {
  const [url] = await bucket.file(path).createResumableUpload({
    metadata: { contentType },
    ...(origin && { origin }),
  });
  return url;
};

export interface StoredObject {
  size: number;
  md5Hash: string;
  crc32c: string;
  contentType: string;
}

/** What Google Cloud recorded for an uploaded file, or null if nothing arrived. */
export const getObject = async (path: string): Promise<StoredObject | null> => {
  try {
    const [meta] = await bucket.file(path).getMetadata();
    return {
      size: Number(meta.size ?? 0),
      md5Hash: String(meta.md5Hash ?? ''),
      crc32c: String(meta.crc32c ?? ''),
      contentType: String(meta.contentType ?? 'application/octet-stream'),
    };
  } catch (error) {
    if ((error as { code?: number }).code === 404) return null;
    throw error;
  }
};

export const moveObject = async (from: string, to: string): Promise<void> => {
  await bucket.file(from).move(to);
};

export const deleteObject = async (path: string): Promise<void> => {
  await bucket.file(path).delete({ ignoreNotFound: true });
};

export const readObject = (path: string) => bucket.file(path).createReadStream();
