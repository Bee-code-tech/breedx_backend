import crypto from 'crypto';
import { CookieOptions, Request, Response } from 'express';
import env from '../config/env';
import DeviceChallenge from '../models/deviceChallenge.model';
import Session from '../models/session.model';
import User from '../models/user.model';
import { ISession } from '../types/session';
import { IUser } from '../types/user';
import { sendDeviceCode } from './mail';
import { generateOTP, hashOTP, OTP_RESEND_COOLDOWN_MS, OTP_TTL_MS } from './otp';
import { sendError, sendSuccess } from './response';
import { signAccessToken, signDeviceChallengeToken, signDeviceSwapToken } from './token';

export const DEVICE_LIMIT = 2;
export const DEVICE_SWAP_LIMIT = 3;
export const REFRESH_GRACE_MS = 30 * 1000; // covers two tabs refreshing at once

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * DAY_MS;
const DEVICE_SWAP_WINDOW_MS = 30 * DAY_MS;
const DEVICE_COOKIE_MAX_AGE_MS = 365 * DAY_MS;

export const DEVICE_COOKIE = 'breedx_device';
export const REFRESH_COOKIE = 'breedx_refresh';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/api/v1/auth',
};

export const clearRefreshCookie = (res: Response): void => {
  res.clearCookie(REFRESH_COOKIE, cookieOptions);
};

export const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');

// Refresh tokens are "<sessionId>.<secret>" so a stale token still finds its session
export const parseRefreshToken = (token: unknown): string | null => {
  if (typeof token !== 'string') return null;
  const [sessionId] = token.split('.');
  return sessionId || null;
};

const rotateRefreshToken = (session: ISession, res: Response): void => {
  const token = `${session._id}.${crypto.randomBytes(32).toString('base64url')}`;
  session.refreshTokenHash = hashToken(token);
  session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  res.cookie(REFRESH_COOKIE, token, { ...cookieOptions, maxAge: SESSION_TTL_MS });
};

export const refreshSession = async (session: ISession, req: Request, res: Response): Promise<void> => {
  session.previousTokenHash = session.refreshTokenHash;
  session.rotatedAt = new Date();
  session.lastSeenAt = new Date();
  session.ip = req.ip;
  rotateRefreshToken(session, res);
  await session.save();
};

export const toPublicUser = (user: IUser) => ({
  id: user._id,
  name: `${user.firstName} ${user.lastName}`.trim(),
  firstName: user.firstName,
  lastName: user.lastName,
  email: user.email,
  country: user.country,
  role: user.role,
  authProvider: user.authProvider,
  isVerified: user.isVerified,
  onboardingStatus: user.onboardingStatus,
  academicProfile: user.toObject().academicProfile ?? {},
  learningStyle: user.toObject().learningStyle ?? {},
  createdAt: user.createdAt,
});

const describeDevice = (userAgent = ''): string => {
  const browser =
    [['Edg/', 'Edge'], ['OPR/', 'Opera'], ['Chrome/', 'Chrome'], ['CriOS/', 'Chrome'], ['Firefox/', 'Firefox'], ['Safari/', 'Safari']]
      .find(([token]) => userAgent.includes(token))?.[1] ?? 'Browser';
  const os =
    [['iPhone', 'iPhone'], ['iPad', 'iPad'], ['Android', 'Android'], ['Mac OS', 'Mac'], ['Windows', 'Windows'], ['Linux', 'Linux']]
      .find(([token]) => userAgent.includes(token))?.[1] ?? 'unknown device';
  return `${browser} on ${os}`;
};

export const getDeviceId = (req: Request): string | null => {
  const deviceId = req.cookies?.[DEVICE_COOKIE];
  return typeof deviceId === 'string' && UUID_REGEX.test(deviceId) ? deviceId : null;
};

export const getOrCreateDeviceId = (req: Request, res: Response): string => {
  const deviceId = getDeviceId(req) ?? crypto.randomUUID();
  res.cookie(DEVICE_COOKIE, deviceId, { ...cookieOptions, maxAge: DEVICE_COOKIE_MAX_AGE_MS });
  return deviceId;
};

// Creates the device's session, or reactivates it after a logout
export const issueSession = async (
  req: Request,
  res: Response,
  user: IUser,
  deviceId: string
): Promise<string> => {
  const session =
    (await Session.findOne({ user: user._id, deviceId })) ??
    new Session({ user: user._id, deviceId });

  session.deviceName = describeDevice(req.get('user-agent'));
  session.ip = req.ip;
  session.lastSeenAt = new Date();
  session.revokedAt = undefined;
  session.previousTokenHash = undefined;
  session.rotatedAt = undefined;
  rotateRefreshToken(session, res);
  await session.save();

  return signAccessToken(user.id, user.role, String(session._id));
};

const registeredDevices = (userId: unknown) =>
  Session.find({ user: userId, expiresAt: { $gt: new Date() } }).sort({ lastSeenAt: -1 });

export const listDevices = async (userId: unknown, currentSessionId?: string) => {
  const sessions = await registeredDevices(userId);
  return sessions.map((session) => ({
    id: session._id,
    deviceName: session.deviceName,
    lastSeenAt: session.lastSeenAt,
    createdAt: session.createdAt,
    current: String(session._id) === currentSessionId,
  }));
};

const recentSwaps = (user: IUser): Date[] =>
  user.deviceSwaps.filter((swap) => swap.getTime() > Date.now() - DEVICE_SWAP_WINDOW_MS);

export const swapsRemaining = async (userId: unknown): Promise<number> => {
  const user = await User.findById(userId).select('+deviceSwaps');
  return user ? Math.max(0, DEVICE_SWAP_LIMIT - recentSwaps(user).length) : 0;
};

// Returns false once the monthly limit is used up
export const recordDeviceSwap = async (userId: unknown): Promise<boolean> => {
  const user = await User.findById(userId).select('+deviceSwaps');
  if (!user) return false;

  const swaps = recentSwaps(user);
  if (swaps.length >= DEVICE_SWAP_LIMIT) return false;

  user.deviceSwaps = [...swaps, new Date()];
  await user.save();
  return true;
};

// Final login step for a verified device: enforce the limit, then sign in
export const finishLogin = async (
  req: Request,
  res: Response,
  user: IUser,
  deviceId: string,
  message = 'Login successful'
): Promise<void> => {
  const devices = await listDevices(user._id);
  const isRegistered = (await Session.exists({ user: user._id, deviceId, expiresAt: { $gt: new Date() } })) !== null;

  if (!isRegistered && devices.length >= DEVICE_LIMIT) {
    sendError(res, `Your plan allows ${DEVICE_LIMIT} devices. Replace one to continue`, 409, {
      code: 'DEVICE_LIMIT',
      data: {
        swapToken: signDeviceSwapToken(user.id, user.role, deviceId),
        devices,
        swapsRemaining: await swapsRemaining(user._id),
      },
    });
    return;
  }

  const accessToken = await issueSession(req, res, user, deviceId);
  sendSuccess(res, { accessToken, user: toPublicUser(user) }, message);
};

export const sendDeviceChallenge = async (req: Request, user: IUser, deviceId: string): Promise<void> => {
  const code = generateOTP();
  await DeviceChallenge.findOneAndUpdate(
    { user: user._id, deviceId },
    {
      codeHash: hashOTP(code),
      attempts: 0,
      lastSentAt: new Date(),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    },
    { upsert: true }
  );
  await sendDeviceCode(user.email, code, describeDevice(req.get('user-agent')), user.firstName);
};

export const isChallengeInCooldown = (lastSentAt: Date): boolean =>
  lastSentAt.getTime() + OTP_RESEND_COOLDOWN_MS > Date.now();

// First login step after the password (or Google) check
export const beginLogin = async (req: Request, res: Response, user: IUser): Promise<void> => {
  const deviceId = getOrCreateDeviceId(req, res);
  const isKnown = await Session.exists({ user: user._id, deviceId, expiresAt: { $gt: new Date() } });

  if (isKnown) {
    await finishLogin(req, res, user, deviceId);
    return;
  }

  const challenge = await DeviceChallenge.findOne({
    user: user._id,
    deviceId,
    expiresAt: { $gt: new Date() },
  });

  // Logging in twice quickly reuses the code already sent
  if (!challenge || !isChallengeInCooldown(challenge.lastSentAt)) {
    await sendDeviceChallenge(req, user, deviceId);
  }

  sendSuccess(
    res,
    {
      status: 'DEVICE_VERIFICATION_REQUIRED',
      challengeToken: signDeviceChallengeToken(user.id, user.role, deviceId),
    },
    'Enter the code we sent to your email to verify this device',
    202
  );
};
