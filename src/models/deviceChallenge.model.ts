import { Schema, model } from 'mongoose';
import { IDeviceChallenge } from '@interfaces/session';

const deviceChallengeSchema = new Schema<IDeviceChallenge>({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  deviceId: { type: String, required: true },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  lastSentAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
});

deviceChallengeSchema.index({ user: 1, deviceId: 1 }, { unique: true });
deviceChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const DeviceChallenge = model<IDeviceChallenge>('DeviceChallenge', deviceChallengeSchema);
export default DeviceChallenge;
