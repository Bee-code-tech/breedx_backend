import crypto from 'crypto';
import jwt, { SignOptions } from 'jsonwebtoken';
import env from '../config/env';
import { TokenPayload, TokenPurpose } from '../types/auth';
import { UserRole } from '../types/user';

const ACCESS_TOKEN_EXPIRES_IN = '15m';
const PASSWORD_SETUP_EXPIRES_IN = '15m';
const PASSWORD_RESET_EXPIRES_IN = '15m';
const DEVICE_CHALLENGE_EXPIRES_IN = '10m';
const DEVICE_SWAP_EXPIRES_IN = '5m';

const sign = (payload: TokenPayload, expiresIn: SignOptions['expiresIn']): string =>
  jwt.sign(payload, env.JWT_SECRET, { expiresIn });

export const signAccessToken = (id: string, role: UserRole, sid: string): string =>
  sign({ id, role, purpose: 'access', sid }, ACCESS_TOKEN_EXPIRES_IN);

export const signSetupToken = (id: string, role: UserRole): string =>
  sign({ id, role, purpose: 'password-setup' }, PASSWORD_SETUP_EXPIRES_IN);

// Changes whenever the password does, so a reset token only works once
export const passwordStamp = (passwordHash: string): string =>
  crypto.createHmac('sha256', env.JWT_SECRET).update(passwordHash).digest('hex').slice(0, 16);

export const signPasswordResetToken = (id: string, role: UserRole, passwordHash: string): string =>
  sign({ id, role, purpose: 'password-reset', passwordStamp: passwordStamp(passwordHash) }, PASSWORD_RESET_EXPIRES_IN);

export const signDeviceChallengeToken = (id: string, role: UserRole, deviceId: string): string =>
  sign({ id, role, purpose: 'device-challenge', deviceId }, DEVICE_CHALLENGE_EXPIRES_IN);

export const signDeviceSwapToken = (id: string, role: UserRole, deviceId: string): string =>
  sign({ id, role, purpose: 'device-swap', deviceId }, DEVICE_SWAP_EXPIRES_IN);

// Returns the payload only if the token is valid AND issued for `purpose`
export const verifyToken = (token: string, purpose: TokenPurpose): TokenPayload | null => {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as TokenPayload;
    return payload.purpose === purpose ? payload : null;
  } catch {
    return null;
  }
};
