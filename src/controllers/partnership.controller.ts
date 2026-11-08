import { Request, Response, NextFunction } from 'express';
import PartnershipRequest, { PARTNERSHIP_TYPES, PartnershipType } from '../models/partnership.model';
import { sendSuccess, sendError } from '../utils/response';
import { sendPartnershipEmails } from '../utils/mail';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Longest value each field accepts
const LIMITS = {
  name: 120,
  organization: 160,
  email: 254,
  phone: 32,
  website: 300,
  topic: 300,
  message: 4000,
} as const;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
// Single-line fields: collapse line breaks so they can't leak into email subjects
const line = (value: unknown): string => text(value).replace(/\s+/g, ' ');

const ALREADY_SENT = 'You have already sent a partnership request with this email. We will reply to you soon.';

// POST /api/v1/partnerships
export const submitPartnership = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const body = req.body ?? {};
    const input = {
      name: line(body.name),
      organization: line(body.organization),
      email: line(body.email).toLowerCase(),
      phone: line(body.phone),
      type: line(body.type) as PartnershipType,
      website: line(body.website),
      topic: line(body.topic),
      message: text(body.message),
    };

    if (!input.name) return sendError(res, 'Enter your name', 400);
    if (!EMAIL_REGEX.test(input.email)) return sendError(res, 'Enter a valid email address', 400);
    if (!PARTNERSHIP_TYPES.includes(input.type)) return sendError(res, 'Choose a partnership type', 400);
    if (!input.message) return sendError(res, 'Write a message', 400);
    for (const [field, max] of Object.entries(LIMITS)) {
      if (input[field as keyof typeof LIMITS].length > max) {
        return sendError(res, `${field} must be ${max} characters or fewer`, 400);
      }
    }

    if (await PartnershipRequest.exists({ email: input.email })) {
      return sendError(res, ALREADY_SENT, 409, { code: 'already_submitted' });
    }

    let request;
    try {
      request = await PartnershipRequest.create(input);
    } catch (error) {
      // Two submissions at once: the unique index catches the second
      if ((error as { code?: number }).code === 11000) {
        return sendError(res, ALREADY_SENT, 409, { code: 'already_submitted' });
      }
      throw error;
    }

    // The request is saved; an email problem must not turn this into an error
    try {
      sendPartnershipEmails(request);
    } catch (error) {
      console.error('Partnership emails failed:', error);
    }
    sendSuccess(res, { id: request.id, email: request.email }, 'Partnership request received', 201);
  } catch (error) {
    next(error);
  }
};
