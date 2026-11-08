import { Response, NextFunction } from 'express';
import env from '../config/env';
import PushSubscription from '../models/pushSubscription.model';
import { AuthRequest } from '../types/auth';
import { pushEnabled } from '../utils/push';
import { sendError, sendSuccess } from '../utils/response';

// GET /api/v1/push/key — the public key browsers subscribe with
export const getPushKey = (_req: AuthRequest, res: Response): void => {
  sendSuccess(res, { enabled: pushEnabled, publicKey: pushEnabled ? env.VAPID_PUBLIC_KEY : null });
};

// POST /api/v1/push/subscriptions { endpoint, keys: { p256dh, auth } }
export const subscribe = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    const p256dh = req.body?.keys?.p256dh;
    const auth = req.body?.keys?.auth;
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || typeof p256dh !== 'string' || typeof auth !== 'string') {
      return sendError(res, 'That subscription is not valid', 400);
    }
    // The same browser signing in as someone else moves to them
    await PushSubscription.updateOne(
      { endpoint },
      { $set: { user: req.user!.id, keys: { p256dh, auth } } },
      { upsert: true }
    );
    sendSuccess(res, { subscribed: true }, 'Notifications are on', 201);
  } catch (error) {
    next(error);
  }
};

// DELETE /api/v1/push/subscriptions { endpoint }
export const unsubscribe = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    await PushSubscription.deleteOne({ endpoint, user: req.user!.id });
    sendSuccess(res, { subscribed: false }, 'Notifications are off');
  } catch (error) {
    next(error);
  }
};
