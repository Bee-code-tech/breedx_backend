import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import DeviceChallenge from '../models/deviceChallenge.model';
import Session from '../models/session.model';
import User from '../models/user.model';
import { IUser } from '../types/user';
import { AuthRequest } from '../types/auth';
import { sendSuccess, sendError } from '../utils/response';
import { generateOTP, hashOTP, OTP_TTL_MS, OTP_MAX_ATTEMPTS, OTP_RESEND_COOLDOWN_MS } from '../utils/otp';
import { sendOTP, sendPasswordResetCode, sendWelcomeEmail } from '../utils/mail';
import { passwordStamp, signPasswordResetToken, signSetupToken, verifyToken } from '../utils/token';
import { verifyGoogleCredential } from '../utils/google';
import env from '../config/env';
import { beginLogin, clearRefreshCookie, getOrCreateDeviceId, issueSession, toPublicUser } from '../utils/session';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 8;
const SPECIAL_CHAR_REGEX = /[^A-Za-z0-9]/;

const normalizeEmail = (email: unknown): string =>
  typeof email === 'string' ? email.trim().toLowerCase() : '';

// Signup is complete once the email is verified and a password is set
const isSignupComplete = (user: IUser): boolean => user.isVerified && !!user.password;

// otpExpires - TTL = when the last code was issued
const isInResendCooldown = (user: IUser): boolean =>
  !!user.otpExpires && user.otpExpires.getTime() - OTP_TTL_MS + OTP_RESEND_COOLDOWN_MS > Date.now();

const isValidPassword = (password: unknown): password is string =>
  typeof password === 'string' && password.length >= PASSWORD_MIN_LENGTH && SPECIAL_CHAR_REGEX.test(password);

const PASSWORD_RULE_MESSAGE = `Password must be at least ${PASSWORD_MIN_LENGTH} characters and include a special character`;

const issueOTP = async (user: IUser): Promise<void> => {
  const otp = generateOTP();
  user.otp = hashOTP(otp);
  user.otpExpires = new Date(Date.now() + OTP_TTL_MS);
  user.otpAttempts = 0;
  await user.save();
  await sendOTP(user.email, otp, user.firstName);
};

// POST /api/v1/auth/register
export const register = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { firstName, lastName, country } = req.body;
    const email = normalizeEmail(req.body.email);

    if (!firstName || !lastName || !email || !country) {
      sendError(res, 'First name, last name, email and country are required', 400);
      return;
    }

    if (!EMAIL_REGEX.test(email)) {
      sendError(res, 'Please provide a valid email address', 400);
      return;
    }

    const existingUser = await User.findOne({ email }).select('+password +otpExpires');

    if (existingUser) {
      if (existingUser.authProvider === 'google') {
        sendError(res, 'This email is registered with Google. Please sign in with Google', 409);
        return;
      }

      if (isSignupComplete(existingUser)) {
        sendError(res, 'Email is already registered', 409);
        return;
      }

      if (isInResendCooldown(existingUser)) {
        sendError(res, 'Please wait a minute before requesting a new code', 429);
        return;
      }

      // Unfinished signup — update details and send a fresh code
      existingUser.firstName = firstName;
      existingUser.lastName = lastName;
      existingUser.country = country;
      existingUser.isVerified = false;
      await issueOTP(existingUser);

      sendSuccess(res, { email }, 'Verification code sent. Please check your email.');
      return;
    }

    const user = new User({ firstName, lastName, email, country, authProvider: 'local' });
    await issueOTP(user);

    sendSuccess(res, { email }, 'Registration successful. Please check your email for verification code.', 201);
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
    const email = normalizeEmail(req.body.email);
    const otp = typeof req.body.otp === 'string' ? req.body.otp.trim() : String(req.body.otp ?? '');

    if (!email || !otp) {
      sendError(res, 'Email and OTP are required', 400);
      return;
    }

    const user = await User.findOne({ email }).select('+password +otp +otpExpires +otpAttempts');

    if (!user || user.authProvider !== 'local') {
      sendError(res, 'Invalid or expired OTP', 400);
      return;
    }

    if (isSignupComplete(user)) {
      sendError(res, 'Account is already set up. Please log in', 400);
      return;
    }

    if (!user.otp || !user.otpExpires || user.otpExpires.getTime() < Date.now()) {
      sendError(res, 'Invalid or expired OTP', 400);
      return;
    }

    if (user.otpAttempts >= OTP_MAX_ATTEMPTS) {
      sendError(res, 'Too many incorrect attempts. Please request a new code', 429);
      return;
    }

    if (user.otp !== hashOTP(otp)) {
      user.otpAttempts += 1;
      await user.save();
      sendError(res, 'Invalid or expired OTP', 400);
      return;
    }

    user.isVerified = true;
    user.otp = undefined;
    user.otpExpires = undefined;
    user.otpAttempts = 0;
    await user.save();

    sendSuccess(
      res,
      { setupToken: signSetupToken(user.id, user.role) },
      'Email verified. Please set your password'
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
    const email = normalizeEmail(req.body.email);

    if (!email) {
      sendError(res, 'Email is required', 400);
      return;
    }

    const user = await User.findOne({ email }).select('+password +otpExpires');

    if (!user || user.authProvider !== 'local') {
      sendError(res, 'User not found', 404);
      return;
    }

    if (isSignupComplete(user)) {
      sendError(res, 'Account is already set up. Please log in', 400);
      return;
    }

    if (isInResendCooldown(user)) {
      sendError(res, 'Please wait a minute before requesting a new code', 429);
      return;
    }

    user.isVerified = false;
    await issueOTP(user);

    sendSuccess(res, null, 'New verification code sent to your email');
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/auth/set-password
export const setPassword = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { setupToken, password } = req.body;

    if (!setupToken || !password) {
      sendError(res, 'Setup token and password are required', 400);
      return;
    }

    const payload = verifyToken(setupToken, 'password-setup');

    if (!payload) {
      sendError(res, 'Setup link is invalid or has expired. Please verify your email again', 401);
      return;
    }

    if (!isValidPassword(password)) {
      sendError(res, PASSWORD_RULE_MESSAGE, 400);
      return;
    }

    const user = await User.findById(payload.id).select('+password');

    if (!user || !user.isVerified) {
      sendError(res, 'Setup link is invalid or has expired. Please verify your email again', 401);
      return;
    }

    // Setup tokens are single-use: once a password exists, they stop working
    if (user.password) {
      sendError(res, 'Password is already set. Please log in', 400);
      return;
    }

    user.password = await bcrypt.hash(password, 12);
    await user.save();

    // The email was just proven, so this first device needs no extra code
    const accessToken = await issueSession(req, res, user, getOrCreateDeviceId(req, res));
    sendWelcomeEmail(user.email, user.firstName);

    sendSuccess(res, { accessToken, user: toPublicUser(user) }, 'Account setup complete', 201);
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/auth/login
export const login = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const email = normalizeEmail(req.body.email);
    const { password } = req.body;

    if (!email || !password) {
      sendError(res, 'Email and password are required', 400);
      return;
    }

    const user = await User.findOne({ email }).select('+password');

    if (user && user.authProvider === 'google') {
      sendError(res, 'This account uses Google sign-in. Please sign in with Google', 400);
      return;
    }

    if (user && !isSignupComplete(user)) {
      sendError(res, 'Please finish signing up: verify your email and set a password', 403);
      return;
    }

    if (!user || !(await bcrypt.compare(password, user.password as string))) {
      sendError(res, 'Invalid email or password', 401);
      return;
    }

    await beginLogin(req, res, user);
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/auth/forgot-password
export const forgotPassword = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!EMAIL_REGEX.test(email)) {
      sendError(res, 'Please provide a valid email address', 400);
      return;
    }

    const user = await User.findOne({ email }).select('+password +otpExpires');

    // Google-only accounts have no password to reset
    if (user && user.password && user.isVerified && !isInResendCooldown(user)) {
      const otp = generateOTP();
      user.otp = hashOTP(otp);
      user.otpExpires = new Date(Date.now() + OTP_TTL_MS);
      user.otpAttempts = 0;
      await user.save();

      // Not awaited: response time must not reveal whether the account exists
      sendPasswordResetCode(user.email, otp, user.firstName).catch((error) => {
        console.error('Password reset email failed:', error);
      });
    }

    // Same answer either way, so this can't be used to check who has an account
    sendSuccess(res, null, 'If that email has a BreedX password, we sent a reset code to it');
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/auth/verify-reset-code
export const verifyResetCode = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = String(req.body.code ?? '').trim();

    if (!email || !code) {
      sendError(res, 'Email and code are required', 400);
      return;
    }

    const user = await User.findOne({ email }).select('+password +otp +otpExpires +otpAttempts');

    if (!user || !user.password || !user.otp || !user.otpExpires || user.otpExpires.getTime() < Date.now()) {
      sendError(res, 'Invalid or expired code', 400);
      return;
    }

    if (user.otpAttempts >= OTP_MAX_ATTEMPTS) {
      sendError(res, 'Too many incorrect attempts. Please request a new code', 429);
      return;
    }

    if (user.otp !== hashOTP(code)) {
      user.otpAttempts += 1;
      await user.save();
      sendError(res, 'Invalid or expired code', 400);
      return;
    }

    user.otp = undefined;
    user.otpExpires = undefined;
    user.otpAttempts = 0;
    await user.save();

    sendSuccess(
      res,
      { resetToken: signPasswordResetToken(user.id, user.role, user.password) },
      'Code verified. Please choose a new password'
    );
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/auth/reset-password
export const resetPassword = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { resetToken, password } = req.body;

    if (!resetToken || !password) {
      sendError(res, 'Reset token and password are required', 400);
      return;
    }

    if (!isValidPassword(password)) {
      sendError(res, PASSWORD_RULE_MESSAGE, 400);
      return;
    }

    const payload = typeof resetToken === 'string' ? verifyToken(resetToken, 'password-reset') : null;
    const user = payload && (await User.findById(payload.id).select('+password'));

    if (!payload || !user?.password || payload.passwordStamp !== passwordStamp(user.password)) {
      sendError(res, 'This reset has expired. Please request a new code', 401);
      return;
    }

    user.password = await bcrypt.hash(password, 12);
    await user.save();

    // Sign out everywhere: if someone else was in the account, they're out now
    await Promise.all([Session.deleteMany({ user: user._id }), DeviceChallenge.deleteMany({ user: user._id })]);
    clearRefreshCookie(res);

    sendSuccess(res, null, 'Password updated. Please log in');
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/auth/google
export const googleAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { credential } = req.body;
    const country = typeof req.body.country === 'string' ? req.body.country.trim() : '';

    if (!credential || typeof credential !== 'string') {
      sendError(res, 'Google credential is required', 400);
      return;
    }

    if (!env.GOOGLE_CLIENT_ID) {
      sendError(res, 'Google sign-in is not available right now', 503);
      return;
    }

    const profile = await verifyGoogleCredential(credential);

    if (!profile) {
      sendError(res, 'Google sign-in failed. Please try again', 401);
      return;
    }

    // The Google ID wins: the email on a Google account can change
    const user: IUser | null =
      (await User.findOne({ googleId: profile.googleId }).select('+password +googleId')) ??
      (await User.findOne({ email: profile.email }).select('+password +googleId'));

    if (!user) {
      if (!country) {
        sendError(res, 'Please select your country to continue', 400, { code: 'COUNTRY_REQUIRED' });
        return;
      }

      const newUser = new User({
        firstName: profile.firstName,
        lastName: profile.lastName,
        email: profile.email,
        country,
        googleId: profile.googleId,
        authProvider: 'google',
        isVerified: true,
      });
      await newUser.save();

      // Google just proved the email, so this first device needs no extra code
      const accessToken = await issueSession(req, res, newUser, getOrCreateDeviceId(req, res));
      sendWelcomeEmail(newUser.email, newUser.firstName);
      sendSuccess(res, { accessToken, user: toPublicUser(newUser) }, 'Account created', 201);
      return;
    }

    if (user.googleId && user.googleId !== profile.googleId) {
      sendError(res, 'This email is linked to a different Google account', 409);
      return;
    }

    // Unfinished manual signup: nobody proved this email until now, so Google's details win
    if (!isSignupComplete(user) && user.authProvider === 'local') {
      user.firstName = profile.firstName;
      user.lastName = profile.lastName;
      user.authProvider = 'google';
      user.isVerified = true;
      user.otp = undefined;
      user.otpExpires = undefined;
      user.otpAttempts = 0;
      if (country) user.country = country;
      sendWelcomeEmail(user.email, user.firstName);
    }

    user.googleId = profile.googleId;
    await user.save();

    // Same device rules as password login
    await beginLogin(req, res, user);
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/auth/me
export const getMe = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const user = await User.findById(req.user?.id);

    if (!user) {
      sendError(res, 'User not found', 404);
      return;
    }

    sendSuccess(res, toPublicUser(user), 'User fetched successfully');
  } catch (error) {
    next(error);
  }
};
