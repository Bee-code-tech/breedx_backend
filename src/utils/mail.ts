import { Resend } from 'resend';
import env from '../config/env';
import { renderEmail } from './emailTemplates';
import type { IPartnershipRequest } from '../models/partnership.model';

const resend = new Resend(env.RESEND_API_KEY);

type SendOptions = { from?: string; text?: string; replyTo?: string; scheduledAt?: string };

const send = async (email: string, subject: string, html: string, options: SendOptions = {}) => {
  try {
    const { data, error } = await resend.emails.send({
      from: options.from ?? env.MAIL_FROM,
      to: [email],
      subject,
      html,
      ...(options.text && { text: options.text }),
      ...(options.replyTo && { replyTo: options.replyTo }),
      ...(options.scheduledAt && { scheduledAt: options.scheduledAt }),
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

const WELCOME_DELAY_MS = 5 * 60 * 1000;

const welcomeText = (firstName: string) => `Hi ${firstName},

Welcome to The Breed. You're officially in, and we're so hyped to have you. 🔥

I'm Al-Ameen, a student and co-founder of BreedX. My co-founder, Ahmad, graduated from university and chose to build this with me: the way he would have loved to learn. Between us, we've seen both sides: the late-night cramming, and the "if only I'd studied smarter" that comes after.

So we built BreedX to make studying hit different. Turn your course materials into quizzes and flashcards in seconds. Ask questions and get answers straight from your notes. Study with your coursemates instead of alone. And every bit of effort you put in gets rewarded, not just the top grades.

Your first move: open BreedX, add one course material and take a quick quiz on it. It takes two minutes, and you'll see exactly what we mean.

Take your first quiz: https://breedx.org/home

One quick question: what made you join? Hit reply and tell me. I read every single reply.

Let's get to work,
Al-Ameen
Co-founder, BreedX`;

// Personal note sent 5 minutes after signup. Resend holds the schedule, so a
// server restart can't lose it. Never blocks signup: a failure only gets logged
export const sendWelcomeEmail = (email: string, firstName: string): void => {
  send(email, 'Welcome to The Breed 🔥', renderEmail('welcome', { firstName }), {
    from: 'Al-Ameen from BreedX <info@breedx.org>',
    replyTo: 'info@breedx.org',
    text: welcomeText(firstName),
    scheduledAt: new Date(Date.now() + WELCOME_DELAY_MS).toISOString(),
  }).catch((error) => {
    console.error('Welcome email failed:', error);
  });
};

// Never blocks joining: a failed waitlist email only gets logged
export const sendWaitlistEmail = (email: string): void => {
  send(email, "You're on the BreedX waitlist", renderEmail('waitlist', {})).catch((error) => {
    console.error('Waitlist email failed:', error);
  });
};

const PARTNERSHIP_TYPE_LABELS: Record<IPartnershipRequest['type'], string> = {
  companies: 'Company',
  agencies: 'Agency',
  organizations: 'Organization',
  individuals: 'Individual',
};

const NOT_PROVIDED = 'Not provided';

// Thanks the sender and notifies the team. Never blocks the request: the
// request is already saved, so a failed email only gets logged
export const sendPartnershipEmails = (request: IPartnershipRequest): void => {
  const firstName = request.name.split(/\s+/)[0];
  const type = PARTNERSHIP_TYPE_LABELS[request.type];
  const organization = request.organization || NOT_PROVIDED;
  const topic = request.topic || NOT_PROVIDED;

  send(
    request.email,
    'We got your partnership request',
    renderEmail('partnership-received', { firstName, type, organization, topic }),
    { replyTo: env.PARTNERSHIPS_INBOX }
  ).catch((error) => {
    console.error('Partnership thank-you email failed:', error);
  });

  // dateStyle can't be combined with timeZoneName, so the zone is spelled out
  const receivedAt = `${new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Africa/Lagos',
  }).format(request.createdAt)} WAT`;

  send(
    env.PARTNERSHIPS_INBOX,
    `New partnership request: ${request.organization || request.name}`,
    renderEmail('partnership-request', {
      name: request.name,
      firstName,
      organization: request.organization || request.name,
      type,
      email: request.email,
      phone: request.phone || NOT_PROVIDED,
      website: request.website || NOT_PROVIDED,
      topic,
      message: request.message,
      receivedAt,
    }),
    { replyTo: request.email }
  ).catch((error) => {
    console.error('Partnership notification email failed:', error);
  });
};
