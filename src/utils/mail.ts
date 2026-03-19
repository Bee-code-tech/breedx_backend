import { Resend } from 'resend';
import env from '../config/env';

const resend = new Resend(env.RESEND_API_KEY);

export const sendOTP = async (email: string, otp: string) => {
  try {
    const { data, error } = await resend.emails.send({
      from: 'Lodgr <onboarding@resend.dev>', // In production, replace with your verified domain
      to: [email],
      subject: 'Verify your Lodgr account',
      html: `
        <h1>Welcome to Lodgr!</h1>
        <p>Your verification code is: <strong>${otp}</strong></p>
        <p>This code will expire in 10 minutes.</p>
      `,
    });

    if (error) {
      console.error('Resend Error:', error);
      throw new Error('Failed to send verification email');
    }

    return data;
  } catch (error) {
    console.error('Mail Util Error:', error);
    throw error;
  }
};
