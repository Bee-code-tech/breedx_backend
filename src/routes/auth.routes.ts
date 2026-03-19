import { Router } from 'express';
import { register, verifyOTP, resendOTP } from '../controllers/auth.controller';

const router = Router();

router.post('/register', register);
router.post('/verify-otp', verifyOTP);
router.post('/resend-otp', resendOTP);

export default router;
