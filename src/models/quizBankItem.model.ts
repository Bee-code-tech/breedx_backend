import { Schema, model } from 'mongoose';
import { DIFFICULTIES, IQuizBankItem, QUESTION_TYPES } from '../types/quiz';

const quizBankItemSchema = new Schema<IQuizBankItem>(
  {
    material: { type: Schema.Types.ObjectId, ref: 'Material', required: true },
    topicKey: { type: String, required: true },
    chapterTitle: { type: String, default: '' },
    topicTitle: { type: String, default: '' },
    pageStart: { type: Number, required: true },
    pageEnd: { type: Number, required: true },
    type: { type: String, enum: QUESTION_TYPES, required: true },
    difficulty: { type: String, enum: DIFFICULTIES, required: true },
    prompt: { type: String, required: true },
    choices: { type: [String], required: true },
    correct: { type: Number, required: true },
    explanation: { type: String, default: '' },
    hint: { type: String, default: '' },
    depth: { type: String, enum: ['basic', 'deep'], default: 'basic' },
    quote: { type: String, default: '' },
    skill: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

quizBankItemSchema.index({ material: 1, topicKey: 1, difficulty: 1, type: 1 });
quizBankItemSchema.index({ material: 1, topicKey: 1, depth: 1 });

const QuizBankItem = model<IQuizBankItem>('QuizBankItem', quizBankItemSchema);
export default QuizBankItem;
