import { Router } from 'express';
import {
  getAllUsers,
  getUserById,
  deleteUser,
} from '../controllers/user.controller';
import { protect } from '../middleware/auth';

const router = Router();

// Public routes (add auth later as needed)
router.get('/', protect, getAllUsers);
router.get('/:id', protect, getUserById);
router.delete('/:id', protect, deleteUser);

export default router;
