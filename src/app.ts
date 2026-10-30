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

// Middleware imports
import { errorHandler } from './middleware/errorHandler';

const app: Application = express();

// Nginx sits in front of the app: trust it for the real client IP
app.set('trust proxy', 1);

// ── Security & parsing middleware ──────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: env.CLIENT_ORIGINS, credentials: true }));
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

// ── Global error handler (must be last) ───────────────────────────────────────
app.use(errorHandler);

export default app;
