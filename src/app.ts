import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import env from './config/env';

// Route imports
import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';

// Middleware imports
import { errorHandler } from './middleware/errorHandler';

const app: Application = express();

// ── Security & parsing middleware ──────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── HTTP logging ───────────────────────────────────────────────────────────────
if (env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', env: env.NODE_ENV });
});

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);

// ── Global error handler (must be last) ───────────────────────────────────────
app.use(errorHandler);

export default app;
