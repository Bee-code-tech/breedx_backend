import { Router } from 'express';
import { adminOverview, adminPartners, adminUpdateUser, adminUserInsights, adminUsers } from '../controllers/admin.controller';
import { protect } from '../middleware/auth';
import { requireAdmin } from '../middleware/roles';

const router = Router();
router.use(protect, requireAdmin);

router.get('/overview', adminOverview);
router.get('/users/insights', adminUserInsights);
router.get('/users', adminUsers);
router.patch('/users/:id', adminUpdateUser);
router.get('/partners', adminPartners);

export default router;
