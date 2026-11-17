import { Router } from 'express';
import {
  createSession,
  deleteProfile,
  endSession,
  getAllowance,
  getAudio,
  getProfile,
  getReplay,
  getSession,
  listSessions,
  listTopics,
  listVoices,
  previewVoice,
  sendEvent,
} from '../controllers/tutor.controller';
import { protect } from '../middleware/auth';
import { aiLimiter } from '../middleware/rateLimit';

const router = Router();

router.use(protect);

router.get('/allowance', getAllowance);
router.get('/voices', listVoices);
router.post('/voices/preview', aiLimiter, previewVoice);
router.get('/topics', listTopics);
router.get('/profile', getProfile);
router.delete('/profile', deleteProfile);
router.get('/audio/:clipId', getAudio);
router.get('/sessions', listSessions);
router.post('/sessions', createSession);
router.get('/sessions/:id', getSession);
router.post('/sessions/:id/events', aiLimiter, sendEvent);
router.post('/sessions/:id/end', endSession);
router.get('/sessions/:id/replay', getReplay);

export default router;
