import { Request, Response, NextFunction } from 'express';
import User from '../models/user.model';
import { sendSuccess, sendError } from '../utils/response';

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
