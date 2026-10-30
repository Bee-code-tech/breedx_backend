import { Document } from 'mongoose';

export type UserRole = 'user' | 'admin';

export type AuthProvider = 'local' | 'google';

export type OnboardingStatus = 'pending' | 'complete';

export interface AcademicProfile {
  school?: string;
  department?: string;
  programme?: string;
  level?: string;
  startYear?: string;
  gradYear?: string;
  interests?: string[];
}

export interface LearningStyle {
  approach?: string;
  time?: string;
  preference?: string;
  planning?: string;
  barriers?: string[];
}

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
  onboardingStatus: OnboardingStatus;
  academicProfile: AcademicProfile;
  learningStyle: LearningStyle;
  otp?: string;
  otpExpires?: Date;
  otpAttempts: number;
  deviceSwaps: Date[];
  createdAt: Date;
  updatedAt: Date;
}
