import { Router } from 'express';
import { getRecord, saveLevels, setScale } from '../controllers/cgpa.controller';
import { protect } from '../middleware/auth';

const router = Router();

router.get('/', protect, getRecord);
router.put('/levels', protect, saveLevels);
router.patch('/scale', protect, setScale);

export default router;
