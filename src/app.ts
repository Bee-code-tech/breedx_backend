import path from 'path';
import express, { Application } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import morgan from 'morgan';
import env from './config/env';

// Route imports
import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import waitlistRoutes from './routes/waitlist.routes';
import partnershipRoutes from './routes/partnership.routes';
import spaceRoutes from './routes/space.routes';
import scheduleRoutes from './routes/schedule.routes';
import pushRoutes from './routes/push.routes';
import cgpaRoutes from './routes/cgpa.routes';
import libraryRoutes from './routes/library.routes';
import aiRoutes from './routes/ai.routes';
import quizRoutes from './routes/quiz.routes';
import flashcardRoutes from './routes/flashcard.routes';
import homeRoutes from './routes/home.routes';
import progressRoutes from './routes/progress.routes';
import billingRoutes from './routes/billing.routes';
import notificationRoutes from './routes/notification.routes';

// Middleware imports
import { errorHandler } from './middleware/errorHandler';

const app: Application = express();

// Nginx sits in front of the app: trust it for the real client IP
app.set('trust proxy', 1);

// ── Security & parsing middleware ──────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: env.CLIENT_ORIGINS, credentials: true }));
// Quizzes can carry pictures, so they get a bigger body limit than everything else
// Bachs signs the exact bytes it sends, so its webhook keeps the raw body
app.use('/api/v1/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }));
app.use('/api/v1/quizzes', express.json({ limit: '12mb' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── HTTP logging ───────────────────────────────────────────────────────────────
if (env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', env: env.NODE_ENV });
});

// ── Email images ───────────────────────────────────────────────────────────────
// Loaded by email apps from other sites, so they need the relaxed policy
app.use(
  '/email-assets',
  (_req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  },
  express.static(path.resolve(__dirname, '../templates/assets'))
);

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/waitlist', waitlistRoutes);
app.use('/api/v1/partnerships', partnershipRoutes);
app.use('/api/v1/spaces', spaceRoutes);
app.use('/api/v1/schedule', scheduleRoutes);
app.use('/api/v1/push', pushRoutes);
app.use('/api/v1/cgpa', cgpaRoutes);
app.use('/api/v1/libraries', libraryRoutes);
app.use('/api/v1/ai', aiRoutes);
app.use('/api/v1/quizzes', quizRoutes);
app.use('/api/v1/flashcards', flashcardRoutes);
app.use('/api/v1/home', homeRoutes);
app.use('/api/v1/progress', progressRoutes);
app.use('/api/v1/billing', billingRoutes);
app.use('/api/v1/notifications', notificationRoutes);

// ── Global error handler (must be last) ───────────────────────────────────────
app.use(errorHandler);

export default app;
