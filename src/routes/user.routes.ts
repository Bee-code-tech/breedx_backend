import { Router } from 'express';
import {
  completeOnboarding,
  getAllUsers,
  getUserById,
  deleteUser,
} from '../controllers/user.controller';
import { protect } from '../middleware/auth';

const router = Router();

// Public routes (add auth later as needed)
router.post('/onboarding', protect, completeOnboarding);
router.get('/', protect, getAllUsers);
router.get('/:id', protect, getUserById);
router.delete('/:id', protect, deleteUser);

export default router;
