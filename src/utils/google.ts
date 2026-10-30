import { OAuth2Client } from 'google-auth-library';
import env from '../config/env';

export interface GoogleProfile {
  googleId: string;
  email: string;
  firstName: string;
  lastName: string;
}

const client = new OAuth2Client();

// Checks the signature, expiry and that the token was issued for our client ID
export const verifyGoogleCredential = async (credential: string): Promise<GoogleProfile | null> => {
  try {
    const ticket = await client.verifyIdToken({ idToken: credential, audience: env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();

    if (!payload?.sub || !payload.email || !payload.email_verified) return null;

    return {
      googleId: payload.sub,
      email: payload.email.toLowerCase(),
      firstName: payload.given_name || payload.name || payload.email.split('@')[0],
      lastName: payload.family_name || '',
    };
  } catch {
    return null;
  }
};
