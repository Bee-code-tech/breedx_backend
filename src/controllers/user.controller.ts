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
