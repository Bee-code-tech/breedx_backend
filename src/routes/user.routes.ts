import { Router } from 'express';
import {
  completeOnboarding,
  getAllUsers,
  getUserById,
  deleteUser,
  updateMe,
  updateAvatar,
  removeAvatar,
} from '../controllers/user.controller';
import { protect } from '../middleware/auth';

const router = Router();

// Public routes (add auth later as needed)
router.post('/onboarding', protect, completeOnboarding);
// /me before /:id so "me" is never read as an id
router.patch('/me', protect, updateMe);
router.put('/me/avatar', protect, updateAvatar);
router.delete('/me/avatar', protect, removeAvatar);
router.get('/', protect, getAllUsers);
router.get('/:id', protect, getUserById);
router.delete('/:id', protect, deleteUser);

export default router;
