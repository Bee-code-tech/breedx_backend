import { Router } from 'express';
import { submitPartnership } from '../controllers/partnership.controller';
import { formLimiter } from '../middleware/rateLimit';

const router = Router();

router.post('/', formLimiter, submitPartnership);

export default router;
