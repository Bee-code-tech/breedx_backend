import { Router } from 'express';
import {
  register,
  verifyOTP,
  resendOTP,
  setPassword,
  login,
  googleAuth,
  forgotPassword,
  verifyResetCode,
  resetPassword,
  getMe,
} from '../controllers/auth.controller';
import {
  verifyDevice,
  resendDeviceCode,
  replaceDevice,
  refresh,
  logout,
  listSessions,
  removeSession,
} from '../controllers/session.controller';
import { protect } from '../middleware/auth';
import { authLimiter, loginLimiter, refreshLimiter } from '../middleware/rateLimit';

const router = Router();

// Manual signup: register → verify-otp → set-password
router.post('/register', authLimiter, register);
router.post('/verify-otp', authLimiter, verifyOTP);
router.post('/resend-otp', authLimiter, resendOTP);
router.post('/set-password', authLimiter, setPassword);

// Login: login → (device/verify if new device) → (device/replace if at the limit)
router.post('/login', loginLimiter, login);
router.post('/google', loginLimiter, googleAuth);
router.post('/device/verify', authLimiter, verifyDevice);
router.post('/device/resend', authLimiter, resendDeviceCode);
router.post('/device/replace', authLimiter, replaceDevice);

// Forgot password: forgot-password → verify-reset-code → reset-password
router.post('/forgot-password', loginLimiter, forgotPassword);
router.post('/verify-reset-code', authLimiter, verifyResetCode);
router.post('/reset-password', authLimiter, resetPassword);

router.post('/refresh', refreshLimiter, refresh);
router.post('/logout', refreshLimiter, logout);

router.get('/me', protect, getMe);
router.get('/sessions', protect, listSessions);
router.delete('/sessions/:id', protect, removeSession);

export default router;
