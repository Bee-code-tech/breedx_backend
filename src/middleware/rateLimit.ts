import rateLimit from 'express-rate-limit';
import env from '../config/env';

const limiter = (limit: number) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => env.NODE_ENV === 'test',
    message: { success: false, message: 'Too many attempts. Please try again later' },
  });

export const loginLimiter = limiter(10);
export const authLimiter = limiter(30);
export const refreshLimiter = limiter(300);
