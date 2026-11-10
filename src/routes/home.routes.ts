import { Router } from 'express';
import { getHome } from '../controllers/home.controller';
import { protect } from '../middleware/auth';

const router = Router();

router.use(protect);

router.get('/', getHome);

export default router;
