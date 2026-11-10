import { Router } from 'express';
import {
  getProgress,
  getWarmup,
  listCourses,
  listWarmups,
  setCourseWarmups,
  updateSettings,
} from '../controllers/progress.controller';
import { protect } from '../middleware/auth';

const router = Router();

router.use(protect);

router.get('/', getProgress);
router.patch('/settings', updateSettings);
router.get('/courses', listCourses);
router.put('/courses/:spaceId/:courseId', setCourseWarmups);
router.get('/warmups', listWarmups);
router.get('/warmups/:id', getWarmup);

export default router;
