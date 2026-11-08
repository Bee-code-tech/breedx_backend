import env from './config/env';
import connectDB from './config/db';
import app from './app';
import { startReminders } from './utils/reminders';

const PORT = Number(env.PORT);

const start = async (): Promise<void> => {
  await connectDB();

  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT} [${env.NODE_ENV}]`);
  });
  startReminders();
};

start();
