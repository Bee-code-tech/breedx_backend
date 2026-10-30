import crypto from 'crypto';
import env from '../config/env';

export const OTP_TTL_MS = 10 * 60 * 1000; // 10 mins
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

export const generateOTP = (): string => {
  // Cryptographically secure 6-digit code (100000–999999)
  return crypto.randomInt(100000, 1000000).toString();
};

// Keyed hash: a plain hash of a 6-digit code could be reversed by trying them all
export const hashOTP = (otp: string): string =>
  crypto.createHmac('sha256', env.JWT_SECRET).update(otp).digest('hex');
