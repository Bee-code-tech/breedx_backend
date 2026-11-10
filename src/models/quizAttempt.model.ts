import { Schema, model } from 'mongoose';
import { IQuizAttempt } from '../types/quiz';

const quizAttemptSchema = new Schema<IQuizAttempt>(
  {
    quiz: { type: Schema.Types.ObjectId, ref: 'Quiz', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    guestId: { type: String, default: null },
    claimToken: { type: String, default: null, select: false },
    own: { type: Boolean, required: true },
    warmup: { type: Boolean, default: false },
    answers: {
      type: [{ _id: false, questionId: String, choice: { type: Number, default: null }, correct: Boolean }],
      default: [],
    },
    correct: { type: Number, required: true },
    total: { type: Number, required: true },
    score: { type: Number, required: true },
    seconds: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

quizAttemptSchema.index({ quiz: 1, user: 1, createdAt: -1 });
quizAttemptSchema.index({ user: 1, own: 1, createdAt: -1 });
quizAttemptSchema.index({ quiz: 1, guestId: 1 }, { partialFilterExpression: { guestId: { $type: 'string' } } });

const QuizAttempt = model<IQuizAttempt>('QuizAttempt', quizAttemptSchema);
export default QuizAttempt;
