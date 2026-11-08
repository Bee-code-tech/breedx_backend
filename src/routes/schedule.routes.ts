import { Router } from 'express';
import { getHomeSchedule } from '../controllers/schedule.controller';
import { protect } from '../middleware/auth';

const router = Router();

router.use(protect);
router.get('/home', getHomeSchedule);

export default router;
