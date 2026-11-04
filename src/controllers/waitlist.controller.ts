import { Request, Response, NextFunction } from 'express';
import WaitlistEntry from '../models/waitlist.model';
import { sendSuccess, sendError } from '../utils/response';
import { sendWaitlistEmail } from '../utils/mail';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normalizeEmail = (email: unknown): string =>
  typeof email === 'string' ? email.trim().toLowerCase() : '';

// POST /api/v1/waitlist
export const joinWaitlist = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!EMAIL_REGEX.test(email)) {
      sendError(res, 'Enter a valid email address', 400);
      return;
    }

    // Joining twice is not an error: the second call only skips the email
    const result = await WaitlistEntry.updateOne(
      { email },
      { $setOnInsert: { email } },
      { upsert: true }
    );
    const joined = result.upsertedCount > 0;
    if (joined) sendWaitlistEmail(email);

    const count = await WaitlistEntry.estimatedDocumentCount();
    sendSuccess(
      res,
      { email, count, alreadyJoined: !joined },
      joined ? "You're on the waitlist" : "You're already on the waitlist",
      joined ? 201 : 200
    );
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/waitlist/count
export const getWaitlistCount = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const count = await WaitlistEntry.estimatedDocumentCount();
    sendSuccess(res, { count });
  } catch (error) {
    next(error);
  }
};
