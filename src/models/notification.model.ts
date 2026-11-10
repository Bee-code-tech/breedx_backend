import { Schema, model } from 'mongoose';
import { INotification, NOTIFICATION_CATEGORIES } from '../types/notification';

// Kept for 90 days
const KEEP_SECONDS = 90 * 24 * 60 * 60;

const notificationSchema = new Schema<INotification>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    category: { type: String, enum: NOTIFICATION_CATEGORIES, required: true },
    kind: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    link: { type: String, default: '/home' },
    image: { type: String, default: null },
    groupKey: { type: String, default: null },
    count: { type: Number, default: 1 },
    readAt: { type: Date, default: null },
    pushedAt: { type: Date, default: null },
    emailedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, updatedAt: -1 });
notificationSchema.index({ user: 1, readAt: 1 });
notificationSchema.index({ user: 1, groupKey: 1, readAt: 1 });
notificationSchema.index({ user: 1, pushedAt: -1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: KEEP_SECONDS });

const Notification = model<INotification>('Notification', notificationSchema);
export default Notification;
