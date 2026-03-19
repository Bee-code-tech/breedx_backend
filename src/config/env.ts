import dotenv from 'dotenv';

dotenv.config();

const env = {
  PORT: process.env.PORT || '5000',
  NODE_ENV: process.env.NODE_ENV || 'development',
  MONGODB_URI: process.env.MONGODB_URI || '',
  JWT_SECRET: process.env.JWT_SECRET || 'changeme',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
} as const;

export default env;
