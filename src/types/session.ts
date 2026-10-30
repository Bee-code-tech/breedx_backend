import { Document, Types } from 'mongoose';

export interface ISession extends Document<Types.ObjectId> {
  user: Types.ObjectId;
  deviceId: string;
  deviceName: string;
  refreshTokenHash: string;
  previousTokenHash?: string;
  rotatedAt?: Date;
  ip?: string;
  lastSeenAt: Date;
  revokedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IDeviceChallenge extends Document<Types.ObjectId> {
  user: Types.ObjectId;
  deviceId: string;
  codeHash: string;
  attempts: number;
  lastSentAt: Date;
  expiresAt: Date;
}
