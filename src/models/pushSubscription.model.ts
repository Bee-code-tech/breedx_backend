import { Schema, model, Types } from 'mongoose';

export interface IPushSubscription {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: Date;
}

// One row per browser or installed app that allowed notifications
const pushSubscriptionSchema = new Schema<IPushSubscription>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
  },
  { timestamps: true }
);

export default model<IPushSubscription>('PushSubscription', pushSubscriptionSchema);
