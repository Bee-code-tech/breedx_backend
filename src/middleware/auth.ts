import { Request, Response, NextFunction } from 'express';
import env from '../config/env';

/**
 * Protect routes — verify Bearer JWT.
 * Replace the stub below with real JWT verification (e.g. jsonwebtoken).
 */
export const protect = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, message: 'Unauthorized — no token' });
    return;
  }

  const token = authHeader.split(' ')[1];

  // TODO: replace this with real JWT verification using env.JWT_SECRET
  if (!token) {
    res.status(401).json({ success: false, message: 'Unauthorized — invalid token' });
    return;
  }

  // Attach decoded user to request here once JWT is wired up
  // (req as any).user = decoded;

  console.log(`[auth] protect middleware - JWT_SECRET exists: ${!!env.JWT_SECRET}`);
  next();
};
