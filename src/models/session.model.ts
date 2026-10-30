import { Schema, model } from 'mongoose';
import { ISession } from '@interfaces/session';

// One document per user + device. It counts as a registered device until it
// expires or is removed; logging out only sets revokedAt.
const sessionSchema = new Schema<ISession>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deviceId: { type: String, required: true },
    deviceName: { type: String, required: true },
    refreshTokenHash: { type: String, required: true },
    previousTokenHash: String,
    rotatedAt: Date,
    ip: String,
    lastSeenAt: { type: Date, required: true },
    revokedAt: Date,
    expiresAt: { type: Date, required: true },
  },
  {
    timestamps: true,
  }
);

sessionSchema.index({ user: 1, deviceId: 1 }, { unique: true });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Session = model<ISession>('Session', sessionSchema);
export default Session;
