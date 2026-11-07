import { Response, NextFunction } from 'express';
import CgpaRecord from '../models/cgpa.model';
import { AuthRequest } from '../types/auth';
import { CGPA_SCALES, CgpaScale, ICgpaRecord } from '../types/cgpa';
import { gradesOutsideScale, parseLevels, summarize } from '../utils/cgpa';
import { sendError, sendSuccess } from '../utils/response';

type SavedRecord = Pick<ICgpaRecord, 'scale' | 'levels' | 'updatedAt'> | null;

// What every CGPA endpoint answers with: the saved record and its results.
// A student with no record yet starts on the 5.0 scale with nothing saved.
const toPublicRecord = (record: SavedRecord) => {
  const scale = record?.scale ?? '5.0';
  const levels = record?.levels ?? [];
  return {
    scale,
    levels,
    summary: summarize(levels, scale),
    updatedAt: record?.updatedAt ?? null,
  };
};

const findRecord = (userId?: string) => CgpaRecord.findOne({ user: userId }).lean();

// GET /api/v1/cgpa
export const getRecord = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const record = await findRecord(req.user?.id);
    sendSuccess(res, toPublicRecord(record));
  } catch (error) {
    next(error);
  }
};

// PUT /api/v1/cgpa/levels — replaces the whole academic record
export const saveLevels = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const existing = await findRecord(req.user?.id);
    const scale = existing?.scale ?? '5.0';
    const parsed = parseLevels(req.body.levels, scale);

    if ('error' in parsed) {
      sendError(res, parsed.error, 400);
      return;
    }

    const record = await CgpaRecord.findOneAndUpdate(
      { user: req.user?.id },
      { $set: { levels: parsed.levels }, $setOnInsert: { scale } },
      { new: true, upsert: true, lean: true }
    );

    sendSuccess(res, toPublicRecord(record), 'Academic record saved');
  } catch (error) {
    next(error);
  }
};

// PATCH /api/v1/cgpa/scale — every GPA and CGPA is worked out again on the new scale
export const setScale = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const scale = req.body.scale as CgpaScale;

    if (!CGPA_SCALES.includes(scale)) {
      sendError(res, `Scale must be one of ${CGPA_SCALES.join(', ')}`, 400);
      return;
    }

    const existing = await findRecord(req.user?.id);
    const unsupported = gradesOutsideScale(existing?.levels ?? [], scale);

    if (unsupported > 0) {
      sendError(
        res,
        `Change the ${unsupported} grade${unsupported === 1 ? '' : 's'} the ${scale} scale doesn't use before switching`,
        409,
        { unsupported }
      );
      return;
    }

    const record = await CgpaRecord.findOneAndUpdate(
      { user: req.user?.id },
      { $set: { scale } },
      { new: true, upsert: true, lean: true }
    );

    sendSuccess(res, toPublicRecord(record), 'Grading scale updated');
  } catch (error) {
    next(error);
  }
};
