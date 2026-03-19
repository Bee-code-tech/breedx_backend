import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/user.model';
import env from '../config/env';
import { sendSuccess, sendError } from '../utils/response';
import { generateOTP } from '../utils/otp';
import { sendOTP } from '../utils/mail';

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
      role,
      category
    } = req.body;

    // Validate required fields
    if (!fullname || !username || !email || !password || !role) {
      sendError(res, 'Fullname, username, email, password and role are required', 400);
      return;
    }

    // Check if user already exists
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

    // Generate OTP
    const otp = generateOTP();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

    // Create user (unverified)
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
      role,
      category,
      otp,
      otpExpires,
      isVerified: false
    });

    // Send OTP email
    await sendOTP(email, otp);

    sendSuccess(
      res,
      { email },
      'Registration successful. Please check your email for verification code.',
      201
    );
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/auth/verify-otp
export const verifyOTP = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      sendError(res, 'Email and OTP are required', 400);
      return;
    }

    const user = await User.findOne({ 
      email,
      otp,
      otpExpires: { $gt: new Date() }
    });

    if (!user) {
      sendError(res, 'Invalid or expired OTP', 400);
      return;
    }

    // Mark as verified
    user.isVerified = true;
    user.otp = undefined;
    user.otpExpires = undefined;
    await user.save();

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
          properties: user.properties,
        },
      },
      'Email verified successfully'
    );
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/auth/resend-otp
export const resendOTP = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { email } = req.body;

    if (!email) {
      sendError(res, 'Email is required', 400);
      return;
    }

    const user = await User.findOne({ email });

    if (!user) {
      sendError(res, 'User not found', 404);
      return;
    }

    if (user.isVerified) {
      sendError(res, 'Email is already verified', 400);
      return;
    }

    // Generate new OTP
    const otp = generateOTP();
    user.otp = otp;
    user.otpExpires = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    // Send OTP email
    await sendOTP(email, otp);

    sendSuccess(res, null, 'New verification code sent to your email');
  } catch (error) {
    next(error);
  }
};
