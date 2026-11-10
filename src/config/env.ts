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
  // Bachs payments. Sandbox by default; a live key needs the live API URL
  BACHS_API_URL: (process.env.BACHS_API_URL || 'https://sandbox-api.bachs.io').replace(/\/$/, ''),
  BACHS_API_KEY: process.env.BACHS_API_KEY || '',
  BACHS_WEBHOOK_SECRET: process.env.BACHS_WEBHOOK_SECRET || '',
  // Where Bachs sends students back after paying. Must be public, not localhost
  APP_URL: (process.env.APP_URL || 'https://breedx.org').replace(/\/$/, ''),
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  // The domain must be verified in Resend
  MAIL_FROM: process.env.MAIL_FROM || 'BreedX Technologies <info@breedx.org>',
  // Where partnership requests are delivered
  PARTNERSHIPS_INBOX: process.env.PARTNERSHIPS_INBOX || 'info@breedx.org',
  // Web push for schedule reminders; without keys, push is simply off
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || '',
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY || '',
  VAPID_SUBJECT: process.env.VAPID_SUBJECT || 'mailto:info@breedx.org',
  // Google Cloud Storage bucket for library files. Locally, sign in once with
  // `gcloud auth application-default login`; on the VM its service account is used
  GCS_BUCKET: process.env.GCS_BUCKET || 'breedx-materials',
  // Vertex AI. Signs in the same way as the bucket (gcloud locally, the VM's
  // service account in production), so there is no API key
  GCP_PROJECT: process.env.GCP_PROJECT || 'breedx',
  GCP_LOCATION: process.env.GCP_LOCATION || 'global',
  // The real models behind Vega, Lyra, Orion and Polaris. Students never see these
  AI_ENGINE_FAST: process.env.AI_ENGINE_FAST || 'gemini-3.5-flash-lite',
  AI_ENGINE_BALANCED: process.env.AI_ENGINE_BALANCED || 'gemini-3.5-flash',
  AI_ENGINE_STRONG: process.env.AI_ENGINE_STRONG || 'gemini-3.1-pro-preview',
  AI_EMBED_MODEL: process.env.AI_EMBED_MODEL || 'gemini-embedding-001',
  // Human voices stop just short of Google's free monthly allowance, so read-aloud costs $0.
  // Then the app falls back to the phone's own voice. Raise these once paid voices are budgeted
  SPEECH_HD_MONTHLY: Number(process.env.SPEECH_HD_MONTHLY || 950_000),
  SPEECH_WAVENET_MONTHLY: Number(process.env.SPEECH_WAVENET_MONTHLY || 3_800_000),
} as const;

export default env;
