import { Schema, model } from 'mongoose';
import { IUser } from '@interfaces/user';
import { PLAN_IDS } from '../config/plans';

const userSchema = new Schema<IUser>(
  {
    firstName: {
      type: String,
      required: [true, 'First name is required'],
      trim: true,
    },
    lastName: {
      type: String,
      // Some Google accounts have no last name; /register requires it for manual signups
      default: '',
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    country: {
      type: String,
      required: [true, 'Country is required'],
      trim: true,
    },
    // Unset until the user completes signup via /auth/set-password
    password: {
      type: String,
      select: false,
    },
    avatar: String,
    authProvider: {
      type: String,
      enum: ['local', 'google'],
      default: 'local',
    },
    googleId: {
      type: String,
      unique: true,
      sparse: true,
      select: false,
    },
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
    },
    // Paid plans fall back to free once planExpiresAt passes
    plan: {
      type: String,
      enum: PLAN_IDS,
      default: 'free',
    },
    planExpiresAt: { type: Date, default: null },
    // AI energy tank (see config/plans.ts). New students start full
    aiEnergy: { type: Number, default: null },
    aiEnergyAt: { type: Date, default: null },
    aiReserve: { type: Number, default: 0 },
    // Sent by the app; streak days and weeks are counted in it
    timezone: { type: String, default: null },
    warmups: { type: Boolean, default: true },
    notificationPrefs: { type: Schema.Types.Mixed, default: undefined },
    isVerified: {
      type: Boolean,
      default: false,
    },
    onboardingStatus: {
      type: String,
      enum: ['pending', 'complete'],
      default: 'pending',
    },
    academicProfile: {
      school: String,
      faculty: String,
      department: String,
      programme: String,
      level: String,
      startYear: String,
      gradYear: String,
      interests: { type: [String], default: undefined },
    },
    learningStyle: {
      approach: String,
      time: String,
      preference: String,
      planning: String,
      barriers: { type: [String], default: undefined },
    },
    otp: { type: String, select: false },
    otpExpires: { type: Date, select: false },
    otpAttempts: { type: Number, default: 0, select: false },
    // When devices were replaced or removed, for the monthly swap limit
    deviceSwaps: { type: [Date], default: [], select: false },
  },
  {
    timestamps: true,
  }
);

const User = model<IUser>('User', userSchema);
export default User;
