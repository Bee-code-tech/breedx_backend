import { Router } from 'express';
import { getPushKey, subscribe, unsubscribe } from '../controllers/push.controller';
import { protect } from '../middleware/auth';

const router = Router();

router.use(protect);
router.get('/key', getPushKey);
router.post('/subscriptions', subscribe);
router.delete('/subscriptions', unsubscribe);

export default router;
