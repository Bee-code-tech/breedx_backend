import { Schema, model } from 'mongoose';
import { DIFFICULTIES, IFlashcardBankItem } from '../types/quiz';

const flashcardBankItemSchema = new Schema<IFlashcardBankItem>(
  {
    material: { type: Schema.Types.ObjectId, ref: 'Material', required: true },
    topicKey: { type: String, required: true },
    chapterTitle: { type: String, default: '' },
    topicTitle: { type: String, default: '' },
    pageStart: { type: Number, required: true },
    pageEnd: { type: Number, required: true },
    difficulty: { type: String, enum: DIFFICULTIES, required: true },
    front: { type: String, required: true },
    a1: { type: String, required: true },
    a2: { type: String, required: true },
    correct: { type: Number, enum: [1, 2], required: true },
    answer: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

flashcardBankItemSchema.index({ material: 1, topicKey: 1, difficulty: 1 });

const FlashcardBankItem = model<IFlashcardBankItem>('FlashcardBankItem', flashcardBankItemSchema);
export default FlashcardBankItem;
