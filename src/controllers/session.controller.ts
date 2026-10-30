import { Request, Response, NextFunction } from 'express';
import { isValidObjectId } from 'mongoose';
import DeviceChallenge from '../models/deviceChallenge.model';
import Session from '../models/session.model';
import User from '../models/user.model';
import { AuthRequest, TokenPayload, TokenPurpose } from '../types/auth';
import { hashOTP, OTP_MAX_ATTEMPTS } from '../utils/otp';
import { sendSuccess, sendError } from '../utils/response';
import {
  clearRefreshCookie,
  DEVICE_SWAP_LIMIT,
  finishLogin,
  getDeviceId,
  hashToken,
  isChallengeInCooldown,
  listDevices,
  parseRefreshToken,
  recordDeviceSwap,
  REFRESH_COOKIE,
  REFRESH_GRACE_MS,
  refreshSession,
  sendDeviceChallenge,
} from '../utils/session';
import { signAccessToken, verifyToken } from '../utils/token';

const SWAP_LIMIT_MESSAGE = `You can only change devices ${DEVICE_SWAP_LIMIT} times in 30 days. Please contact support`;

// Device tokens only work from the browser they were issued to
const verifyDeviceToken = (
  req: Request,
  token: unknown,
  purpose: TokenPurpose
): (TokenPayload & { deviceId: string }) | null => {
  const payload = typeof token === 'string' ? verifyToken(token, purpose) : null;
  const deviceId = getDeviceId(req);
  return payload && deviceId && payload.deviceId === deviceId ? { ...payload, deviceId } : null;
};

// POST /api/v1/auth/device/verify
export const verifyDevice = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { challengeToken } = req.body;
    const code = String(req.body.code ?? '').trim();

    if (!challengeToken || !code) {
      sendError(res, 'Challenge token and code are required', 400);
      return;
    }

    const payload = verifyDeviceToken(req, challengeToken, 'device-challenge');

    if (!payload) {
      sendError(res, 'Verification has expired. Please log in again', 401);
      return;
    }

    const challenge = await DeviceChallenge.findOne({
      user: payload.id,
      deviceId: payload.deviceId,
      expiresAt: { $gt: new Date() },
    });

    if (!challenge) {
      sendError(res, 'Invalid or expired code', 400);
      return;
    }

    if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
      sendError(res, 'Too many incorrect attempts. Please request a new code', 429);
      return;
    }

    if (challenge.codeHash !== hashOTP(code)) {
      challenge.attempts += 1;
      await challenge.save();
      sendError(res, 'Invalid or expired code', 400);
      return;
    }

    const user = await User.findById(payload.id);

    if (!user) {
      sendError(res, 'Verification has expired. Please log in again', 401);
      return;
    }

    await challenge.deleteOne();
    await finishLogin(req, res, user, payload.deviceId, 'Device verified');
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/auth/device/resend
export const resendDeviceCode = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const payload = verifyDeviceToken(req, req.body.challengeToken, 'device-challenge');
    const user = payload && (await User.findById(payload.id));

    if (!payload || !user) {
      sendError(res, 'Verification has expired. Please log in again', 401);
      return;
    }

    const challenge = await DeviceChallenge.findOne({ user: user._id, deviceId: payload.deviceId });

    if (challenge && isChallengeInCooldown(challenge.lastSentAt)) {
      sendError(res, 'Please wait a minute before requesting a new code', 429);
      return;
    }

    await sendDeviceChallenge(req, user, payload.deviceId);
    sendSuccess(res, null, 'New verification code sent to your email');
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/auth/device/replace
export const replaceDevice = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { swapToken, sessionId } = req.body;

    if (!swapToken || !sessionId) {
      sendError(res, 'Swap token and session ID are required', 400);
      return;
    }

    const payload = verifyDeviceToken(req, swapToken, 'device-swap');
    const user = payload && (await User.findById(payload.id));

    if (!payload || !user) {
      sendError(res, 'This request has expired. Please log in again', 401);
      return;
    }

    const session = isValidObjectId(sessionId)
      ? await Session.findOne({ _id: sessionId, user: user._id, deviceId: { $ne: payload.deviceId } })
      : null;

    if (!session) {
      sendError(res, 'Device not found', 404);
      return;
    }

    if (!(await recordDeviceSwap(user._id))) {
      sendError(res, SWAP_LIMIT_MESSAGE, 429, { code: 'DEVICE_SWAP_LIMIT' });
      return;
    }

    await session.deleteOne();
    await finishLogin(req, res, user, payload.deviceId, 'Device replaced');
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/auth/refresh
export const refresh = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const token = req.cookies?.[REFRESH_COOKIE];
    const sessionId = parseRefreshToken(token);
    const session = sessionId && isValidObjectId(sessionId) ? await Session.findById(sessionId) : null;

    if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) {
      clearRefreshCookie(res);
      sendError(res, 'Session has expired. Please log in again', 401);
      return;
    }

    const tokenHash = hashToken(token);
    const isCurrent = tokenHash === session.refreshTokenHash;
    const isInGrace =
      tokenHash === session.previousTokenHash &&
      !!session.rotatedAt &&
      session.rotatedAt.getTime() + REFRESH_GRACE_MS > Date.now();

    // An old token outside the grace window means it was copied: end the session
    if (!isCurrent && !isInGrace) {
      await session.deleteOne();
      clearRefreshCookie(res);
      sendError(res, 'Session has expired. Please log in again', 401);
      return;
    }

    const user = await User.findById(session.user);

    if (!user) {
      await session.deleteOne();
      clearRefreshCookie(res);
      sendError(res, 'Session has expired. Please log in again', 401);
      return;
    }

    if (isCurrent) {
      await refreshSession(session, req, res);
    }

    sendSuccess(res, { accessToken: signAccessToken(user.id, user.role, String(session._id)) }, 'Token refreshed');
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/auth/logout
export const logout = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const token = req.cookies?.[REFRESH_COOKIE];
    const sessionId = parseRefreshToken(token);
    const session = sessionId && isValidObjectId(sessionId) ? await Session.findById(sessionId) : null;

    // The device stays registered, so logging out can't dodge the device limit
    if (session && [session.refreshTokenHash, session.previousTokenHash].includes(hashToken(token))) {
      session.revokedAt = new Date();
      await session.save();
    }

    clearRefreshCookie(res);
    sendSuccess(res, null, 'Logged out');
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/auth/sessions
export const listSessions = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    sendSuccess(res, await listDevices(req.user?.id, req.user?.sid), 'Devices fetched successfully');
  } catch (error) {
    next(error);
  }
};

// DELETE /api/v1/auth/sessions/:id
export const removeSession = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const session = isValidObjectId(id) ? await Session.findOne({ _id: id, user: req.user?.id }) : null;

    if (!session) {
      sendError(res, 'Device not found', 404);
      return;
    }

    if (id === req.user?.sid) {
      sendError(res, 'Use logout to sign out of this device', 400);
      return;
    }

    if (!(await recordDeviceSwap(req.user?.id))) {
      sendError(res, SWAP_LIMIT_MESSAGE, 429, { code: 'DEVICE_SWAP_LIMIT' });
      return;
    }

    await session.deleteOne();
    sendSuccess(res, null, 'Device removed');
  } catch (error) {
    next(error);
  }
};
