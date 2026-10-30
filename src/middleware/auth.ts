import { Response, NextFunction } from 'express';
import Session from '../models/session.model';
import { AuthRequest } from '../types/auth';
import { verifyToken } from '../utils/token';

/**
 * Protect routes — verify Bearer access token and its session, then attach it
 * to req.user. Checking the session means a removed device is cut off at once.
 */
export const protect = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, message: 'Unauthorized — no token' });
      return;
    }

    const payload = verifyToken(authHeader.split(' ')[1], 'access');
    const session = payload?.sid && (await Session.exists({
      _id: payload.sid,
      revokedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
    }));

    if (!payload || !session) {
      res.status(401).json({ success: false, message: 'Unauthorized — invalid or expired token' });
      return;
    }

    req.user = payload;
    next();
  } catch (error) {
    next(error);
  }
};
