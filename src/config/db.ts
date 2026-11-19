import mongoose from 'mongoose';

// A brief network or DNS hiccup shouldn't take the server down: retry with growing waits
const RETRY_DELAYS_MS = [2000, 5000, 10000, 20000, 30000];

const connectDB = async (): Promise<void> => {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error('MONGODB_URI is not defined in environment variables');
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const conn = await mongoose.connect(uri);
      console.log(`✅ MongoDB connected: ${conn.connection.host}`);
      return;
    } catch (error) {
      const wait = RETRY_DELAYS_MS[attempt];
      if (wait === undefined) {
        console.error('❌ MongoDB connection failed, giving up:', error);
        process.exit(1);
      }
      console.error(
        `❌ MongoDB connection failed (${(error as { code?: string }).code ?? (error as Error).message}), retrying in ${wait / 1000}s…`
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
};

export default connectDB;
