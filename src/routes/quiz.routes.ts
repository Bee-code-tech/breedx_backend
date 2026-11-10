import { Router } from 'express';
import {
  createQuiz,
  deleteQuiz,
  generateQuiz,
  getQuiz,
  getQuizUsage,
  listAttempts,
  listParticipants,
  listQuizzes,
  submitAttempt,
  updateQuiz,
  getPublicQuiz,
  submitGuestAttempt,
  claimAttempt,
} from '../controllers/quiz.controller';
import { protect } from '../middleware/auth';
import { aiLimiter, authLimiter } from '../middleware/rateLimit';

const router = Router();

// The public link (/q/:id): anyone can open it and take it without an account
router.get('/public/:id', getPublicQuiz);
router.post('/public/:id/attempts', authLimiter, submitGuestAttempt);

router.use(protect);

router.post('/attempts/:attemptId/claim', claimAttempt);
router.get('/', listQuizzes);
router.get('/usage', getQuizUsage);
// Streams (Server-Sent Events): steps, then `result` with the quiz
router.post('/generate', aiLimiter, generateQuiz);
router.post('/', createQuiz);

router.get('/:id', getQuiz);
router.patch('/:id', updateQuiz);
router.delete('/:id', deleteQuiz);
router.post('/:id/attempts', submitAttempt);
router.get('/:id/attempts', listAttempts);
router.get('/:id/participants', listParticipants);

export default router;
