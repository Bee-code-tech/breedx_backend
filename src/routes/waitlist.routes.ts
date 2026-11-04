import { Router } from 'express';
import { getWaitlistCount, joinWaitlist } from '../controllers/waitlist.controller';
import { authLimiter, refreshLimiter } from '../middleware/rateLimit';

const router = Router();

router.post('/', authLimiter, joinWaitlist);
router.get('/count', refreshLimiter, getWaitlistCount);

export default router;
