import { Router } from 'express';
import { bachsWebhook, checkCoupon, getBilling, getPayment, getUsage, startCheckout } from '../controllers/billing.controller';
import { protect } from '../middleware/auth';

const router = Router();

// From Bachs, not a student: checked by signature instead of a session
router.post('/webhook', bachsWebhook);

router.use(protect);
router.get('/', getBilling);
router.get('/usage', getUsage);
router.post('/coupon', checkCoupon);
router.post('/checkout', startCheckout);
router.get('/payments/:id', getPayment);

export default router;
