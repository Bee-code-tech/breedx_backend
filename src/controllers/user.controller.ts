import { Request, Response, NextFunction } from 'express';
import User from '../models/user.model';
import { AuthRequest } from '../types/auth';
import { sendSuccess, sendError } from '../utils/response';
import { toPublicUser } from '../utils/session';

const MAX_FIELD_LENGTH = 120;
const MAX_LIST_LENGTH = 20;

// Option ids from the frontend's learning-style quiz
const STYLE_OPTIONS = {
  approach: ['video', 'practice', 'ask', 'solo'],
  time: ['morning', 'evening', 'night'],
  preference: ['myself', 'pair', 'group', 'depends'],
  planning: ['planned', 'flexible', 'mood', 'reminders'],
} as const;

const BARRIER_OPTIONS = ['procrastination', 'distractions', 'motivation', 'start', 'other'];

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_FIELD_LENGTH;

const isOptionalText = (value: unknown): boolean => value === undefined || isText(value);

const isOptionalList = (value: unknown): boolean =>
  value === undefined || (Array.isArray(value) && value.length <= MAX_LIST_LENGTH && value.every(isText));

const isChoice = (options: readonly string[], value: unknown): boolean =>
  typeof value === 'string' && options.includes(value);

// POST /api/v1/users/onboarding
export const completeOnboarding = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const academic = req.body.academicProfile ?? {};
    const style = req.body.learningStyle ?? {};

    if (!isText(academic.school) || !isText(academic.department) || !isText(academic.level)) {
      sendError(res, 'School, department and level are required', 400);
      return;
    }

    if (!isChoice(STYLE_OPTIONS.approach, style.approach) || !isChoice(STYLE_OPTIONS.time, style.time)) {
      sendError(res, 'Learning approach and time are required', 400);
      return;
    }

    const academicValid =
      [academic.programme, academic.startYear, academic.gradYear].every(isOptionalText) &&
      isOptionalList(academic.interests);
    const styleValid =
      (style.preference === undefined || isChoice(STYLE_OPTIONS.preference, style.preference)) &&
      (style.planning === undefined || isChoice(STYLE_OPTIONS.planning, style.planning)) &&
      isOptionalList(style.barriers) &&
      (style.barriers ?? []).every((barrier: string) => BARRIER_OPTIONS.includes(barrier));

    if (!academicValid || !styleValid) {
      sendError(res, 'Some onboarding answers are invalid', 400);
      return;
    }

    const user = await User.findById(req.user?.id);

    if (!user) {
      sendError(res, 'User not found', 404);
      return;
    }

    user.academicProfile = {
      school: academic.school.trim(),
      faculty: isText(academic.faculty) ? academic.faculty.trim() : undefined,
      department: academic.department.trim(),
      programme: academic.programme,
      level: academic.level.trim(),
      startYear: academic.startYear,
      gradYear: academic.gradYear,
      interests: academic.interests,
    };
    user.learningStyle = {
      approach: style.approach,
      time: style.time,
      preference: style.preference,
      planning: style.planning,
      barriers: style.barriers,
    };
    user.onboardingStatus = 'complete';
    await user.save();

    sendSuccess(res, toPublicUser(user), 'Onboarding complete');
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/users
export const getAllUsers = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const users = await User.find();
    sendSuccess(res, users, 'Users fetched successfully');
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/users/:id
export const getUserById = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      sendError(res, 'User not found', 404);
      return;
    }
    sendSuccess(res, user, 'User fetched successfully');
  } catch (error) {
    next(error);
  }
};

// DELETE /api/v1/users/:id
export const deleteUser = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) {
      sendError(res, 'User not found', 404);
      return;
    }
    sendSuccess(res, null, 'User deleted successfully');
  } catch (error) {
    next(error);
  }
};

// A 256px JPEG is about 20-40 KB; this leaves headroom without inviting huge images
const MAX_AVATAR_LENGTH = 90_000;
const AVATAR_REGEX = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const PROFILE_FIELDS = ['school', 'faculty', 'department', 'level'] as const;

// PATCH /api/v1/users/me
export const updateMe = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { firstName, lastName, country, academicProfile } = req.body ?? {};
    const profile = academicProfile ?? {};

    if (
      !isOptionalText(firstName) ||
      !(lastName === undefined || typeof lastName === 'string') ||
      !isOptionalText(country) ||
      typeof profile !== 'object' ||
      !PROFILE_FIELDS.every((field) => isOptionalText(profile[field]))
    ) {
      sendError(res, 'Check your details and try again', 400);
      return;
    }

    const user = await User.findById(req.user?.id).select('+password');
    if (!user) {
      sendError(res, 'User not found', 404);
      return;
    }

    if (firstName !== undefined) user.firstName = firstName.trim();
    if (lastName !== undefined) user.lastName = String(lastName).trim().slice(0, MAX_FIELD_LENGTH);
    if (country !== undefined) user.country = country.trim();
    for (const field of PROFILE_FIELDS) {
      if (profile[field] !== undefined) user.set(`academicProfile.${field}`, profile[field].trim());
    }
    await user.save();

    sendSuccess(res, toPublicUser(user), 'Profile updated');
  } catch (error) {
    next(error);
  }
};

// PUT /api/v1/users/me/avatar
export const updateAvatar = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { image } = req.body ?? {};
    if (typeof image !== 'string' || image.length > MAX_AVATAR_LENGTH || !AVATAR_REGEX.test(image)) {
      sendError(res, 'Use a JPG, PNG or WebP image', 400);
      return;
    }

    const user = await User.findByIdAndUpdate(req.user?.id, { avatar: image }, { new: true }).select('+password');
    if (!user) {
      sendError(res, 'User not found', 404);
      return;
    }

    sendSuccess(res, toPublicUser(user), 'Photo updated');
  } catch (error) {
    next(error);
  }
};

// DELETE /api/v1/users/me/avatar
export const removeAvatar = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const user = await User.findByIdAndUpdate(req.user?.id, { $unset: { avatar: 1 } }, { new: true }).select('+password');
    if (!user) {
      sendError(res, 'User not found', 404);
      return;
    }

    sendSuccess(res, toPublicUser(user), 'Photo removed');
  } catch (error) {
    next(error);
  }
};
