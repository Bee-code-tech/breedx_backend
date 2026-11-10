import { Router } from 'express';
import {
  announce,
  deleteNotification,
  getPreferences,
  getUnreadCount,
  listNotifications,
  markRead,
  updatePreferences,
} from '../controllers/notification.controller';
import { protect } from '../middleware/auth';

const router = Router();

router.use(protect);

router.get('/', listNotifications);
router.get('/unread-count', getUnreadCount);
router.post('/read', markRead);
router.get('/preferences', getPreferences);
router.put('/preferences', updatePreferences);
router.post('/announce', announce);
router.delete('/:id', deleteNotification);

export default router;
