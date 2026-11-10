import crypto from 'crypto';
import { NextFunction, Response } from 'express';
import { Types } from 'mongoose';
import FlashcardDeck from '../models/flashcardDeck.model';
import { AuthRequest } from '../types/auth';
import { CARD_TAGS, CardTag, DIFFICULTIES, Difficulty, Flashcard, IFlashcardDeck, ReviewRating } from '../types/quiz';
import { pickCards } from '../utils/ai/bank';
import { readySources } from '../utils/ai/scope';
import { recordActivity } from '../utils/activity';
import { applyCardReview } from '../utils/mastery';
import { sendError, sendSuccess } from '../utils/response';
import { openStream, Stream } from '../utils/sse';

const TITLE_MAX = 120;
// Matches the frontend's largest custom count
const MAX_CARDS = 99;
const MAX_DECK = 500;
const FOCUS_MAX = 300;
const FRONT_MAX = 500;
const OPTION_MAX = 300;
const ANSWER_MAX = 2000;

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const MIN_EASE = 1.3;

const isId = (value: unknown): value is string => typeof value === 'string' && Types.ObjectId.isValid(value);
const idList = (value: unknown): string[] | null =>
  value === undefined || value === null ? null : Array.isArray(value) ? [...new Set(value.filter(isId))] : [];
const isDifficulty = (value: unknown): value is Difficulty =>
  typeof value === 'string' && (DIFFICULTIES as readonly string[]).includes(value);
const isTag = (value: unknown): value is CardTag => typeof value === 'string' && (CARD_TAGS as readonly string[]).includes(value);

const toPublicCard = (card: Flashcard) => ({
  id: card.id,
  front: card.front,
  a1: card.a1,
  a2: card.a2,
  correct: card.correct,
  answer: card.answer,
  difficulty: card.difficulty,
  tag: card.tag,
  fileId: card.fileId,
  pageStart: card.pageStart,
  pageEnd: card.pageEnd,
  dueAt: card.dueAt,
  reviews: card.reviews,
});

const dueCount = (deck: IFlashcardDeck) => deck.cards.filter((card) => card.dueAt.getTime() <= Date.now()).length;

const toPublicDeck = (deck: IFlashcardDeck, withCards = false) => ({
  id: deck._id,
  title: deck.title,
  fileIds: deck.files,
  cardCount: deck.cards.length,
  dueCount: dueCount(deck),
  createdAt: deck.createdAt,
  updatedAt: deck.updatedAt,
  ...(withCards && { cards: deck.cards.map(toPublicCard) }),
});

const findOwnDeck = (userId: string, id: unknown) =>
  isId(id) ? FlashcardDeck.findOne({ _id: id, owner: userId }) : Promise.resolve(null);

/** Checks the editable fields of a card. Returns what's wrong, or null. */
const readCardFields = (input: Record<string, unknown>, card: Partial<Flashcard>): string | null => {
  const text = (key: 'front' | 'a1' | 'a2' | 'answer', max: number, required: boolean) => {
    if (input[key] === undefined) return null;
    const value = typeof input[key] === 'string' ? (input[key] as string).trim() : '';
    if ((required && !value) || value.length > max) return `${key} must be ${required ? '1' : '0'} to ${max} characters`;
    card[key] = value;
    return null;
  };
  const problem = text('front', FRONT_MAX, true) ?? text('a1', OPTION_MAX, false) ?? text('a2', OPTION_MAX, false) ?? text('answer', ANSWER_MAX, false);
  if (problem) return problem;
  if (input.correct !== undefined) {
    if (input.correct !== 1 && input.correct !== 2) return 'correct must be 1 or 2';
    card.correct = input.correct;
  }
  if (input.difficulty !== undefined) {
    if (!isDifficulty(input.difficulty)) return 'Difficulty must be easy, medium or hard';
    card.difficulty = input.difficulty;
  }
  if (input.tag !== undefined) {
    if (!isTag(input.tag)) return 'Tag must be navy, lime, blue or white';
    card.tag = input.tag;
  }
  return null;
};

// ── Decks ─────────────────────────────────────────────────────────────────────

export const listDecks = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const decks = await FlashcardDeck.find({ owner: req.user!.id }).sort({ updatedAt: -1 });
    sendSuccess(res, { decks: decks.map((deck) => toPublicDeck(deck)) });
  } catch (error) {
    next(error);
  }
};

/** A deck with its cards. `?due=true` returns only cards due for review now. */
export const getDeck = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const deck = await findOwnDeck(req.user!.id, req.params.id);
    if (!deck) {
      sendError(res, 'Deck not found', 404);
      return;
    }
    const data = toPublicDeck(deck, true);
    if (req.query.due === 'true') {
      data.cards = data.cards!.filter((card) => card.dueAt.getTime() <= Date.now());
    }
    sendSuccess(res, { deck: data });
  } catch (error) {
    next(error);
  }
};

/**
 * Makes flashcards from the student's files with AI. Streams steps, then
 * `result` with the deck. Cards come from the shared bank: no energy used.
 */
export const generateDeck = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const userId = req.user!.id;
  const body = req.body ?? {};
  const fileIds = idList(body.fileIds);
  const libraryIds = idList(body.libraryIds);
  const count = Number(body.count ?? 15);
  const difficulty = body.difficulty ?? 'medium';
  const tag = body.tag ?? 'navy';
  const focus = typeof body.focus === 'string' ? body.focus.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';

  if (!fileIds?.length && !libraryIds?.length) {
    sendError(res, 'Choose at least one file or library', 400);
    return;
  }
  if (!Number.isInteger(count) || count < 1 || count > MAX_CARDS) {
    sendError(res, `Ask for 1 to ${MAX_CARDS} cards`, 400);
    return;
  }
  if (!isDifficulty(difficulty)) {
    sendError(res, 'Difficulty must be easy, medium or hard', 400);
    return;
  }
  if (!isTag(tag)) {
    sendError(res, 'Tag must be navy, lime, blue or white', 400);
    return;
  }
  if (focus.length > FOCUS_MAX || title.length > TITLE_MAX) {
    sendError(res, `Keep the focus under ${FOCUS_MAX} and the title under ${TITLE_MAX} characters`, 400);
    return;
  }

  let stream: Stream | null = null;
  try {
    stream = openStream(req, res);
    const live = stream;
    live.step('reading', 'Reading your materials…', { status: 'active' });
    const sources = await readySources(live, userId, { fileIds, libraryIds });
    if (live.closed) return;
    if (!sources.length) {
      live.fail("None of these files could be read. Try a PDF, Word, PowerPoint or text file.");
      return;
    }
    live.step('reading', `Read ${sources.length} file${sources.length === 1 ? '' : 's'}`, { status: 'done' });

    const seen = new Set((await FlashcardDeck.distinct('cards.bankItem', { owner: userId })).filter(Boolean).map(String));
    live.step('creating', 'Writing cards…', { status: 'active' });
    const picked = await pickCards({
      userId,
      sources,
      count,
      difficulty,
      focus,
      seen,
      onProgress: (progress) => {
        live.step('creating', `Writing cards (${progress.done}/${progress.total} topics)…`, {
          status: progress.done === progress.total ? 'done' : 'active',
        });
        if (progress.written) {
          live.step('reviewing', `Checked ${progress.written} new cards against your notes, kept ${progress.kept}`, {
            status: progress.done === progress.total ? 'done' : 'active',
          });
        }
      },
    });
    if (live.closed) return;
    if (!picked.length) {
      live.fail("We couldn't make cards from these files. Try another file or difficulty.");
      return;
    }
    live.step('creating', `Made ${picked.length} cards`, { status: 'done' });

    const now = new Date();
    const deck = await FlashcardDeck.create({
      owner: userId,
      title: title || `${sources.length === 1 ? sources[0].file.name.replace(/\.[^.]+$/, '') : 'Mixed'} Flashcards`,
      files: sources.map((source) => source.file._id),
      cards: picked.map(({ item, file }) => ({
        id: crypto.randomUUID(),
        front: item.front,
        a1: item.a1,
        a2: item.a2,
        correct: item.correct,
        answer: item.answer,
        difficulty: item.difficulty,
        tag,
        bankItem: item._id,
        fileId: file._id,
        pageStart: item.pageStart,
        pageEnd: item.pageEnd,
        dueAt: now,
      })),
    });
    live.send('result', { deck: toPublicDeck(deck, true) });
    live.end();
  } catch (error) {
    if (!stream) return next(error);
    if (stream.closed) return;
    console.error('Flashcard generation failed:', error);
    stream.fail('Something went wrong while making your cards. Please try again.');
  }
};

/** A deck written by hand. */
export const createDeck = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body ?? {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > TITLE_MAX) {
      sendError(res, `Title must be 1 to ${TITLE_MAX} characters`, 400);
      return;
    }
    const input = Array.isArray(body.cards) ? body.cards : [];
    if (input.length > MAX_DECK) {
      sendError(res, `A deck can have up to ${MAX_DECK} cards`, 400);
      return;
    }
    const now = new Date();
    const cards: Partial<Flashcard>[] = [];
    for (const [index, raw] of input.entries()) {
      const card: Partial<Flashcard> = { id: crypto.randomUUID(), dueAt: now };
      const problem = raw && typeof raw === 'object' ? readCardFields({ front: '', ...raw }, card) : 'not valid';
      if (problem) {
        sendError(res, `Card ${index + 1}: ${problem}`, 400);
        return;
      }
      cards.push(card);
    }
    const deck = await FlashcardDeck.create({ owner: req.user!.id, title, cards });
    sendSuccess(res, { deck: toPublicDeck(deck, true) }, 'Deck created', 201);
  } catch (error) {
    next(error);
  }
};

export const updateDeck = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const deck = await findOwnDeck(req.user!.id, req.params.id);
    if (!deck) {
      sendError(res, 'Deck not found', 404);
      return;
    }
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title || title.length > TITLE_MAX) {
      sendError(res, `Title must be 1 to ${TITLE_MAX} characters`, 400);
      return;
    }
    deck.title = title;
    await deck.save();
    sendSuccess(res, { deck: toPublicDeck(deck) }, 'Deck updated');
  } catch (error) {
    next(error);
  }
};

export const deleteDeck = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const deck = await findOwnDeck(req.user!.id, req.params.id);
    if (!deck) {
      sendError(res, 'Deck not found', 404);
      return;
    }
    await deck.deleteOne();
    sendSuccess(res, null, 'Deck deleted');
  } catch (error) {
    next(error);
  }
};

// ── Cards ─────────────────────────────────────────────────────────────────────

export const addCard = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const deck = await findOwnDeck(req.user!.id, req.params.id);
    if (!deck) {
      sendError(res, 'Deck not found', 404);
      return;
    }
    if (deck.cards.length >= MAX_DECK) {
      sendError(res, `A deck can have up to ${MAX_DECK} cards`, 400);
      return;
    }
    const card: Partial<Flashcard> = { id: crypto.randomUUID(), dueAt: new Date() };
    const problem = readCardFields({ front: '', ...(req.body ?? {}) }, card);
    if (problem) {
      sendError(res, problem, 400);
      return;
    }
    deck.cards.push(card as Flashcard);
    await deck.save();
    sendSuccess(res, { card: toPublicCard(deck.cards[deck.cards.length - 1]) }, 'Card added', 201);
  } catch (error) {
    next(error);
  }
};

export const updateCard = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const deck = await findOwnDeck(req.user!.id, req.params.id);
    const card = deck?.cards.find((entry) => entry.id === req.params.cardId);
    if (!deck || !card) {
      sendError(res, 'Card not found', 404);
      return;
    }
    const problem = readCardFields(req.body ?? {}, card);
    if (problem) {
      sendError(res, problem, 400);
      return;
    }
    deck.markModified('cards');
    await deck.save();
    sendSuccess(res, { card: toPublicCard(card) }, 'Card updated');
  } catch (error) {
    next(error);
  }
};

export const removeCard = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const deck = await findOwnDeck(req.user!.id, req.params.id);
    if (!deck || !deck.cards.some((card) => card.id === req.params.cardId)) {
      sendError(res, 'Card not found', 404);
      return;
    }
    deck.cards = deck.cards.filter((card) => card.id !== req.params.cardId);
    await deck.save();
    sendSuccess(res, { deck: toPublicDeck(deck) }, 'Card removed');
  } catch (error) {
    next(error);
  }
};

/**
 * Spaced repetition: after each card the student says how it went, and the
 * card comes back sooner if it was hard, later if it was easy.
 */
const schedule = (card: Flashcard, rating: ReviewRating, now: number) => {
  let { interval, ease } = card;
  switch (rating) {
    case 'again':
      return { interval: 0, ease: Math.max(MIN_EASE, ease - 0.2), dueAt: new Date(now + 10 * MINUTE) };
    case 'hard':
      interval = Math.max(1, Math.round(interval * 1.2));
      ease = Math.max(MIN_EASE, ease - 0.15);
      break;
    case 'good':
      interval = interval === 0 ? 1 : interval === 1 ? 3 : Math.round(interval * ease);
      break;
    case 'easy':
      interval = interval === 0 ? 3 : Math.round(interval * ease * 1.3);
      ease += 0.15;
      break;
  }
  return { interval, ease, dueAt: new Date(now + interval * DAY) };
};

export const reviewCard = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const rating = req.body?.rating as ReviewRating;
    if (!['again', 'hard', 'good', 'easy'].includes(rating)) {
      sendError(res, 'Rating must be again, hard, good or easy', 400);
      return;
    }
    const deck = await findOwnDeck(req.user!.id, req.params.id);
    const card = deck?.cards.find((entry) => entry.id === req.params.cardId);
    if (!deck || !card) {
      sendError(res, 'Card not found', 404);
      return;
    }
    Object.assign(card, schedule(card, rating, Date.now()), { reviews: card.reviews + 1 });
    deck.markModified('cards');
    await deck.save();
    void recordActivity(req.user!.id, 'flashcards');
    void applyCardReview(req.user!.id, card.bankItem, rating);
    sendSuccess(res, { card: toPublicCard(card), dueCount: dueCount(deck) });
  } catch (error) {
    next(error);
  }
};
