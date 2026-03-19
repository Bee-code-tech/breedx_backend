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
    const { 
      fullname, 
      username, 
      email, 
      password,
      gender,
      religion,
      phone_number,
      level,
      institution,
      faculty,
      department,
      role
    } = req.body;

    // Validate required fields
    if (!fullname || !username || !email || !password) {
      sendError(res, 'Fullname, username, email and password are required', 400);
      return;
    }

    // Check if user already exists (email or username)
    const existingUser = await User.findOne({ 
      $or: [{ email }, { username }] 
    });
    
    if (existingUser) {
      const field = existingUser.email === email ? 'Email' : 'Username';
      sendError(res, `${field} is already registered`, 409);
      return;
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user
    const user = await User.create({
      fullname,
      username,
      email,
      password: hashedPassword,
      gender,
      religion,
      phone_number,
      level,
      institution,
      faculty,
      department,
      role: role || 'student'
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
          fullname: user.fullname,
          username: user.username,
          email: user.email,
          role: user.role,
          shops: user.shops,
        },
      },
      'Registration successful',
      201
    );
  } catch (error) {
    next(error);
  }
};
