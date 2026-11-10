import { Router } from 'express';
import {
  find,
  getFileAi,
  getUsage,
  listModels,
  prepareFile,
  readAloud,
  readAloudUsage,
  simplify,
} from '../controllers/ai.controller';
import {
  ask,
  createSession,
  deleteSession,
  getSession,
  listSessions,
  setFeedback,
  updateSession,
} from '../controllers/aiSession.controller';
import { protect } from '../middleware/auth';
import { aiLimiter } from '../middleware/rateLimit';

const router = Router();

router.use(protect);

router.get('/usage', getUsage);
router.get('/models', listModels);

// Streams (Server-Sent Events): thought steps, then a result
router.post('/find', aiLimiter, find);
router.post('/files/:fileId/prepare', aiLimiter, prepareFile);
router.post('/simplify', aiLimiter, simplify);
// Read aloud in a human voice, within Google's free monthly allowance
router.post('/speech', aiLimiter, readAloud);
router.get('/speech/usage', readAloudUsage);

router.get('/files/:fileId', getFileAi);

// Ask: saved chats with the student's files
router.get('/sessions', listSessions);
router.post('/sessions', createSession);
router.get('/sessions/:id', getSession);
router.patch('/sessions/:id', updateSession);
router.delete('/sessions/:id', deleteSession);
router.post('/sessions/:id/ask', aiLimiter, ask);
router.post('/messages/:id/feedback', setFeedback);

export default router;
