import { Resend } from 'resend';
import env from '../config/env';
import { renderEmail } from './emailTemplates';

const resend = new Resend(env.RESEND_API_KEY);

const send = async (email: string, subject: string, html: string) => {
  try {
    const { data, error } = await resend.emails.send({
      from: env.MAIL_FROM,
      to: [email],
      subject,
      html,
    });

    if (error) {
      console.error('Resend Error:', error);
      throw new Error('Failed to send email');
    }

    return data;
  } catch (error) {
    console.error('Mail Util Error:', error);
    throw error;
  }
};

export const sendOTP = (email: string, otp: string, firstName: string) =>
  send(email, 'Your BreedX verification code', renderEmail('verify-email', { firstName, code: otp }));

export const sendDeviceCode = (email: string, otp: string, device: string, firstName: string) =>
  send(email, 'New device sign-in to BreedX', renderEmail('new-device', { firstName, code: otp, device }));

export const sendPasswordResetCode = (email: string, otp: string, firstName: string) =>
  send(email, 'Reset your BreedX password', renderEmail('reset-password', { firstName, code: otp }));

// Never blocks signup: a failed welcome email only gets logged
export const sendWelcomeEmail = (email: string, firstName: string): void => {
  send(email, 'Welcome to BreedX', renderEmail('welcome', { firstName })).catch((error) => {
    console.error('Welcome email failed:', error);
  });
};
