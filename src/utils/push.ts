import webpush from 'web-push';
import { Types } from 'mongoose';
import env from '../config/env';
import PushSubscription from '../models/pushSubscription.model';

export const pushEnabled = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

if (pushEnabled) {
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
}

export type PushMessage = {
  title: string;
  body: string;
  /** Path to open when the notification is tapped, e.g. /classes/csc-301-ab12 */
  url: string;
  /** Notifications with the same tag replace each other instead of stacking. */
  tag?: string;
};

// Sends to every device these people allowed. Devices that unsubscribed are
// removed. Never throws: a failed push only gets logged
export const pushToUsers = async (userIds: (string | Types.ObjectId)[], message: PushMessage): Promise<void> => {
  if (!pushEnabled || !userIds.length) return;
  try {
    const subscriptions = await PushSubscription.find({ user: { $in: userIds } }).lean();
    const payload = JSON.stringify(message);
    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, payload, {
            TTL: 60 * 60,
          });
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await PushSubscription.deleteOne({ _id: subscription._id });
          } else {
            console.error('Push failed:', status ?? error);
          }
        }
      })
    );
  } catch (error) {
    console.error('Push error:', error);
  }
};
