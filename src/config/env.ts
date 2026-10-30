import dotenv from 'dotenv';

dotenv.config();

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is not defined in environment variables');
}

const env = {
  PORT: process.env.PORT || '5000',
  NODE_ENV: process.env.NODE_ENV || 'development',
  MONGODB_URI: process.env.MONGODB_URI || '',
  JWT_SECRET: process.env.JWT_SECRET,
  // Comma-separated list of frontends allowed to call the API with cookies
  CLIENT_ORIGINS: (process.env.CLIENT_ORIGINS || 'https://breedx.org').split(',').map((origin) => origin.trim()),
  // Public address of this API; email images load from here
  API_URL: process.env.API_URL || 'https://api.breedx.org',
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  // The domain must be verified in Resend
  MAIL_FROM: process.env.MAIL_FROM || 'BreedX <info@breedx.org>',
} as const;

export default env;
