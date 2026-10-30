import { Document } from 'mongoose';

export type UserRole = 'user' | 'admin';

export type AuthProvider = 'local' | 'google';

export interface IUser extends Document {
  firstName: string;
  lastName: string;
  email: string;
  country: string;
  password?: string;
  authProvider: AuthProvider;
  googleId?: string;
  role: UserRole;
  isVerified: boolean;
  otp?: string;
  otpExpires?: Date;
  otpAttempts: number;
  deviceSwaps: Date[];
  createdAt: Date;
  updatedAt: Date;
}
