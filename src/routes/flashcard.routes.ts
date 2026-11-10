import { Router } from 'express';
import {
  addCard,
  createDeck,
  deleteDeck,
  generateDeck,
  getDeck,
  listDecks,
  removeCard,
  reviewCard,
  updateCard,
  updateDeck,
} from '../controllers/flashcard.controller';
import { protect } from '../middleware/auth';
import { aiLimiter } from '../middleware/rateLimit';

const router = Router();

router.use(protect);

router.get('/', listDecks);
// Streams (Server-Sent Events): steps, then `result` with the deck
router.post('/generate', aiLimiter, generateDeck);
router.post('/', createDeck);

router.get('/:id', getDeck);
router.patch('/:id', updateDeck);
router.delete('/:id', deleteDeck);

router.post('/:id/cards', addCard);
router.patch('/:id/cards/:cardId', updateCard);
router.delete('/:id/cards/:cardId', removeCard);
router.post('/:id/cards/:cardId/review', reviewCard);

export default router;
