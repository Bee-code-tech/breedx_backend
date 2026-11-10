import { Schema, model } from 'mongoose';
import { DIFFICULTIES, IQuiz, QUESTION_TYPES } from '../types/quiz';

const questionSchema = new Schema(
  {
    id: { type: String, required: true },
    type: { type: String, enum: QUESTION_TYPES, required: true },
    prompt: { type: String, required: true },
    choices: { type: [String], required: true },
    correct: { type: Number, required: true },
    explanation: { type: String, default: '' },
    hint: { type: String, default: '' },
    image: { type: String, default: null },
    choiceImages: { type: [{ type: String, default: null }], default: [] },
    quote: { type: String, default: '' },
    sourceTitle: { type: String, default: '' },
    spaceMaterial: { type: Schema.Types.ObjectId, default: null },
    libraryId: { type: Schema.Types.ObjectId, default: null },
    bankItem: { type: Schema.Types.ObjectId, ref: 'QuizBankItem', default: null },
    fileId: { type: Schema.Types.ObjectId, ref: 'LibraryFile', default: null },
    pageStart: { type: Number, default: null },
    pageEnd: { type: Number, default: null },
  },
  { _id: false }
);

const quizSchema = new Schema<IQuiz>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    space: { type: Schema.Types.ObjectId, ref: 'Space', default: null },
    title: { type: String, required: true, trim: true },
    method: { type: String, enum: ['ai', 'manual', 'import', 'warmup'], required: true },
    difficulty: { type: String, enum: DIFFICULTIES, default: 'medium' },
    types: { type: [String], enum: QUESTION_TYPES, default: ['mcqs'] },
    sourceName: { type: String, default: '' },
    files: { type: [Schema.Types.ObjectId], ref: 'LibraryFile', default: [] },
    questions: { type: [questionSchema], default: [] },
    settings: {
      timeLimit: { type: Number, default: null },
      retakes: { type: Number, default: null },
      randomize: { type: Boolean, default: true },
      showResults: { type: Boolean, default: true },
      hints: { type: Boolean, default: false },
      visibility: { type: String, enum: ['anyone', 'private'], default: 'anyone' },
    },
  },
  { timestamps: true }
);

quizSchema.index({ owner: 1, createdAt: -1 });

const Quiz = model<IQuiz>('Quiz', quizSchema);
export default Quiz;
