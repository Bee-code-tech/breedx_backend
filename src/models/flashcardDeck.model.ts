import { Schema, model } from 'mongoose';
import { CARD_TAGS, DIFFICULTIES, IFlashcardDeck } from '../types/quiz';

const cardSchema = new Schema(
  {
    id: { type: String, required: true },
    front: { type: String, required: true },
    a1: { type: String, default: '' },
    a2: { type: String, default: '' },
    correct: { type: Number, enum: [1, 2], default: 1 },
    answer: { type: String, default: '' },
    difficulty: { type: String, enum: DIFFICULTIES, default: 'medium' },
    tag: { type: String, enum: CARD_TAGS, default: 'navy' },
    bankItem: { type: Schema.Types.ObjectId, ref: 'FlashcardBankItem', default: null },
    fileId: { type: Schema.Types.ObjectId, ref: 'LibraryFile', default: null },
    pageStart: { type: Number, default: null },
    pageEnd: { type: Number, default: null },
    dueAt: { type: Date, default: Date.now },
    interval: { type: Number, default: 0 },
    ease: { type: Number, default: 2.5 },
    reviews: { type: Number, default: 0 },
  },
  { _id: false }
);

const flashcardDeckSchema = new Schema<IFlashcardDeck>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true },
    files: { type: [Schema.Types.ObjectId], ref: 'LibraryFile', default: [] },
    cards: { type: [cardSchema], default: [] },
  },
  { timestamps: true }
);

flashcardDeckSchema.index({ owner: 1, updatedAt: -1 });

const FlashcardDeck = model<IFlashcardDeck>('FlashcardDeck', flashcardDeckSchema);
export default FlashcardDeck;
