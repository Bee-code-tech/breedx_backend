import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/user.model';
import env from '../config/env';
import { sendSuccess, sendError } from '../utils/response';

// POST /api/v1/auth/register
export const register = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { name, email, password } = req.body;

    // Validate required fields
    if (!name || !email || !password) {
      sendError(res, 'Name, email and password are required', 400);
      return;
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      sendError(res, 'Email is already registered', 409);
      return;
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user
    const user = await User.create({
      name,
      email,
      password: hashedPassword,
    });

    // Sign JWT
    const token = jwt.sign(
      { id: user._id, role: user.role },
      env.JWT_SECRET as string,
      { expiresIn: env.JWT_EXPIRES_IN as unknown as number }
    );

    sendSuccess(
      res,
      {
        token,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
      },
      'Registration successful',
      201
    );
  } catch (error) {
    next(error);
  }
};
