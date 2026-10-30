import { Request } from 'express';
import { UserRole } from './user';

export type TokenPurpose = 'access' | 'password-setup' | 'password-reset' | 'device-challenge' | 'device-swap';

export interface TokenPayload {
  id: string;
  role: UserRole;
  purpose: TokenPurpose;
  sid?: string; // session, on access tokens
  deviceId?: string; // device being signed in, on device tokens
  passwordStamp?: string; // ties a reset token to the password it replaces
}

// Request after `protect` has run
export interface AuthRequest extends Request {
  user?: TokenPayload;
}
