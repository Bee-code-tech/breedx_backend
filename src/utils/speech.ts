import crypto from 'crypto';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import env from '../config/env';
import { PLAN_LIMITS } from '../config/plans';
import { SpeechDay, SpeechMonth } from '../models/speechUsage.model';
import { planFor } from './plan';
import { getObject, saveObject } from './storage';

// Signs in like the bucket: your gcloud login locally, the VM's service account in production
const client = new TextToSpeechClient({ projectId: env.GCP_PROJECT });

/** Longest text read in one request. The app sends longer answers in pieces, first sentence first. */
export const SPEECH_MAX_CHARS = 3000;

export const VOICES = ['warm', 'calm'] as const;
export type VoiceId = (typeof VOICES)[number];

// British English: there's no Nigerian-English voice, and it's the closest to what students are used to
const VOICE_NAMES: Record<VoiceId, { hd: string; wavenet: string }> = {
  warm: { hd: 'en-GB-Chirp3-HD-Aoede', wavenet: 'en-GB-Wavenet-F' },
  calm: { hd: 'en-GB-Chirp3-HD-Charon', wavenet: 'en-GB-Wavenet-D' },
};

type Tier = 'hd' | 'wavenet';

/**
 * Turns an answer into something pleasant to hear: no Markdown, no citation
 * numbers, no stray symbols, and maths read out in words.
 */
export const speakable = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, ' ') // code blocks aren't worth reading out
    .replace(/\[(\d{1,2})\]/g, '') // [1], [2] citations
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links keep their words
    .replace(/\$([^$]+)\$/g, '$1') // LaTeX delimiters
    .replace(/\\log\b/g, 'log')
    .replace(/O\(([^)]+)\)/g, 'O of $1')
    .replace(/\^2\b/g, ' squared')
    .replace(/\^(\w+)/g, ' to the power $1')
    .replace(/(\*\*|__|\*|_|`|#+\s|>\s)/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s*\n\s*/g, '. ')
    .replace(/\.\s*\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();

const month = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);
const clipPath = (voiceName: string, text: string) =>
  `speech/${crypto.createHash('sha256').update(`${voiceName}|${text}`).digest('hex')}.mp3`;

/**
 * Takes `chars` from this month's allowance for a tier, only if it fits under
 * the cap. Atomic, so two requests can't both squeeze past it.
 */
const reserveMonthly = async (tier: Tier, chars: number) => {
  const cap = tier === 'hd' ? env.SPEECH_HD_MONTHLY : env.SPEECH_WAVENET_MONTHLY;
  await SpeechMonth.updateOne({ month: month() }, { $setOnInsert: { hd: 0, wavenet: 0 } }, { upsert: true });
  const taken = await SpeechMonth.updateOne({ month: month(), [tier]: { $lte: cap - chars } }, { $inc: { [tier]: chars } });
  return taken.modifiedCount === 1;
};

const releaseMonthly = (tier: Tier, chars: number) =>
  SpeechMonth.updateOne({ month: month() }, { $inc: { [tier]: -chars } }).catch(() => undefined);

/** Takes `chars` from the student's daily allowance, if it fits. */
const reserveDaily = async (userId: string, chars: number, limit: number) => {
  await SpeechDay.updateOne({ user: userId, day: today() }, { $setOnInsert: { chars: 0 } }, { upsert: true });
  const taken = await SpeechDay.updateOne({ user: userId, day: today(), chars: { $lte: limit - chars } }, { $inc: { chars } });
  return taken.modifiedCount === 1;
};

const releaseDaily = (userId: string, chars: number) =>
  SpeechDay.updateOne({ user: userId, day: today() }, { $inc: { chars: -chars } }).catch(() => undefined);

export type SpeechResult =
  | { audio: { path: string } | { data: Buffer }; tier: Tier; cached: boolean }
  | { useDeviceVoice: true; reason: 'daily' | 'monthly' };

/**
 * A human-voice clip for `text`, or a sign to use the phone's own voice.
 * Clips made before (by anyone) replay free. A new clip uses the most human
 * voice still within Google's free monthly allowance, and the student's daily
 * allowance; past both, the answer is "use the device voice", never a bill.
 */
export const speak = async (userId: string, text: string, voice: VoiceId): Promise<SpeechResult> => {
  const names = VOICE_NAMES[voice];

  // Made before? Free, whoever made it
  for (const tier of ['hd', 'wavenet'] as Tier[]) {
    const path = clipPath(names[tier], text);
    if (await getObject(path)) return { audio: { path }, tier, cached: true };
  }

  const { plan } = await planFor(userId);
  const chars = text.length;
  if (!(await reserveDaily(userId, chars, PLAN_LIMITS[plan].speechPerDay))) {
    return { useDeviceVoice: true, reason: 'daily' };
  }
  const tier: Tier | null = (await reserveMonthly('hd', chars))
    ? 'hd'
    : (await reserveMonthly('wavenet', chars))
      ? 'wavenet'
      : null;
  if (!tier) {
    await releaseDaily(userId, chars);
    return { useDeviceVoice: true, reason: 'monthly' };
  }

  try {
    const [response] = await client.synthesizeSpeech({
      input: { text },
      voice: { languageCode: 'en-GB', name: names[tier] },
      audioConfig: { audioEncoding: 'MP3' },
    });
    const data = Buffer.from(response.audioContent as Uint8Array);
    // Saved for next time; a failed save just means it's made again later
    void saveObject(clipPath(names[tier], text), data, 'audio/mpeg').catch((error) =>
      console.error('Saving a speech clip failed:', error)
    );
    return { audio: { data }, tier, cached: false };
  } catch (error) {
    // Nothing was made, so nothing is used up
    await Promise.all([releaseMonthly(tier, chars), releaseDaily(userId, chars)]);
    throw error;
  }
};

/** A saved clip's id (from its path), for the app to fetch it by. */
const clipIdOf = (path: string) => path.slice('speech/'.length, -'.mp3'.length);
export const clipPathOf = (id: string) => (/^[a-f0-9]{64}$/.test(id) ? `speech/${id}.mp3` : null);

/**
 * A saved clip for one tutor line, or null when this month's free voice
 * allowance is used up (the app then speaks it with the device's voice).
 * Tutor sessions have their own limits, so no daily allowance applies. The
 * clip is saved before returning, so the app can fetch it straight away and
 * replays reuse it.
 */
export const tutorClip = async (rawText: string, voice: VoiceId): Promise<{ id: string; tier: Tier } | null> => {
  const text = speakable(rawText).slice(0, SPEECH_MAX_CHARS);
  if (!text) return null;
  const names = VOICE_NAMES[voice];
  // TUTOR_VOICE=fast uses WaveNet first: about a second quicker per line, a little less human
  const order: Tier[] = process.env.TUTOR_VOICE === 'fast' ? ['wavenet', 'hd'] : ['hd', 'wavenet'];

  // Made before (by anyone)? Checked in parallel
  const saved = await Promise.all(
    order.map(async (tier) => {
      const path = clipPath(names[tier], text);
      return recentClips.has(clipIdOf(path)) || (await getObject(path)) ? { id: clipIdOf(path), tier } : null;
    })
  );
  const found = saved.find(Boolean);
  if (found) return found;

  const chars = text.length;
  let tier: Tier | null = null;
  for (const candidate of order) {
    if (await reserveMonthly(candidate, chars)) {
      tier = candidate;
      break;
    }
  }
  if (!tier) return null;
  try {
    const [response] = await client.synthesizeSpeech({
      input: { text },
      voice: { languageCode: 'en-GB', name: names[tier] },
      audioConfig: { audioEncoding: 'MP3' },
    });
    const path = clipPath(names[tier], text);
    const data = Buffer.from(response.audioContent as Uint8Array);
    // Served from memory straight away; the lasting copy is saved meanwhile
    remember(clipIdOf(path), data);
    void saveObject(path, data, 'audio/mpeg').catch((error) => console.error('Saving a tutor clip failed:', error));
    return { id: clipIdOf(path), tier };
  } catch (error) {
    await releaseMonthly(tier, chars);
    console.error('Tutor voice failed:', error);
    return null;
  }
};

/**
 * Like `tutorClip`, but returns the clip's id at once and makes the audio
 * meanwhile: the app can show the line and ask for the audio straight away,
 * and `GET /tutor/audio/:id` waits for it. Null when this month's free voice
 * is used up.
 */
export const startTutorClip = async (rawText: string, voice: VoiceId): Promise<{ id: string; tier: Tier } | null> => {
  const text = speakable(rawText).slice(0, SPEECH_MAX_CHARS);
  if (!text) return null;
  const names = VOICE_NAMES[voice];
  const order: Tier[] = process.env.TUTOR_VOICE === 'fast' ? ['wavenet', 'hd'] : ['hd', 'wavenet'];
  for (const tier of order) {
    const id = clipIdOf(clipPath(names[tier], text));
    if (recentClips.has(id) || pendingClips.has(id)) return { id, tier };
  }
  const chars = text.length;
  let tier: Tier | null = null;
  for (const candidate of order) {
    if (await reserveMonthly(candidate, chars)) {
      tier = candidate;
      break;
    }
  }
  if (!tier) return null;
  const chosen = tier;
  const path = clipPath(names[chosen], text);
  const id = clipIdOf(path);
  const making = client
    .synthesizeSpeech({ input: { text }, voice: { languageCode: 'en-GB', name: names[chosen] }, audioConfig: { audioEncoding: 'MP3' } })
    .then(([response]) => {
      const data = Buffer.from(response.audioContent as Uint8Array);
      remember(id, data);
      void saveObject(path, data, 'audio/mpeg').catch((error) => console.error('Saving a tutor clip failed:', error));
      return data;
    })
    .catch(async (error) => {
      await releaseMonthly(chosen, chars);
      console.error('Tutor voice failed:', error);
      return null;
    })
    .finally(() => setTimeout(() => pendingClips.delete(id), 60_000));
  pendingClips.set(id, making);
  return { id, tier: chosen };
};

// Clips still being made, so a request for one can wait for it
const pendingClips = new Map<string, Promise<Buffer | null>>();

/** A clip that's being made right now: wait for it (null if it failed). */
export const pendingClip = (id: string) => pendingClips.get(id) ?? null;

// The newest clips, kept in memory so the app can play them before they reach storage
const RECENT_CLIPS = 300;
const recentClips = new Map<string, Buffer>();
const remember = (id: string, data: Buffer) => {
  recentClips.set(id, data);
  if (recentClips.size > RECENT_CLIPS) recentClips.delete(recentClips.keys().next().value as string);
};

/** A clip just made, from memory, or null to read it from storage. */
export const recentClip = (id: string) => recentClips.get(id) ?? null;

/**
 * Opens the connection to Google when the server starts, so the first student
 * to press "Read aloud" doesn't wait for it. Costs nothing.
 */
export const warmUpSpeech = () => {
  client.listVoices({ languageCode: 'en-GB' }).catch(() => undefined);
};

/** How much of this month's free voice allowance is used, for the admin dashboard. */
export const speechThisMonth = async () => {
  const usage = await SpeechMonth.findOne({ month: month() }).lean();
  return {
    month: month(),
    hd: { used: usage?.hd ?? 0, cap: env.SPEECH_HD_MONTHLY },
    wavenet: { used: usage?.wavenet ?? 0, cap: env.SPEECH_WAVENET_MONTHLY },
  };
};
