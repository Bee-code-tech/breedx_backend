import crypto from 'crypto';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import env from '../config/env';
import { PLAN_LIMITS } from '../config/plans';
import { SpeechDay, SpeechMonth } from '../models/speechUsage.model';
import { planFor } from './plan';
import { downloadObject, getObject, saveObject } from './storage';

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
// ── Gemini voice (NotebookLM-style): performed, not read ──────────────────────

/** Which voice the tutor speaks with: "gemini" (default), or Google's "hd" / "fast" voices. */
export const tutorVoiceMode = () => (process.env.TUTOR_VOICE === 'hd' || process.env.TUTOR_VOICE === 'fast' ? process.env.TUTOR_VOICE : 'gemini');

/**
 * Gemini voice models to spread lines over. Each has its own per-minute quota
 * (5 a minute on a new project), so Flash then Pro (same voices, Pro even richer) double what we can
 * say. Set TUTOR_TTS_MODELS (comma separated) once quotas are raised.
 */
const ttsModels = () =>
  (process.env.TUTOR_TTS_MODELS || process.env.TUTOR_TTS_MODEL || 'gemini-2.5-flash-tts,gemini-2.5-pro-tts')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);

/** The tutor's voice: male (Charon) or female (Kore), speaking English with the student's own accent. */
export const TUTOR_VOICES = ['male', 'female'] as const;
export type TutorVoiceId = (typeof TUTOR_VOICES)[number];
export interface TutorVoice {
  voice: TutorVoiceId;
  /** ISO country code whose English accent to use, e.g. "NG". Empty for a neutral accent. */
  accent: string;
}

const geminiVoiceFor = (voice: TutorVoiceId) =>
  voice === 'female' ? process.env.TUTOR_GEMINI_VOICE_FEMALE || 'Kore' : process.env.TUTOR_GEMINI_VOICE_MALE || 'Charon';

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
/** "NG" → "Nigeria", or null for anything that isn't a country code. */
export const countryName = (code: string) => {
  if (!/^[A-Z]{2}$/.test(code)) return null;
  try {
    const name = regionNames.of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
};
const accentLine = (code: string) => {
  const name = countryName(code);
  return name ? ` Speak with a natural English accent from ${name}, the way an educated tutor there would.` : '';
};

// How the tutor should sound. Changing it changes every clip, so bump the version too
const GEMINI_STYLE_VERSION = 'v2';
const GEMINI_STYLE =
  process.env.TUTOR_VOICE_STYLE ||
  'You are a warm, playful university tutor talking one-on-one with a student you like. Speak naturally, like a real person ' +
    'thinking out loud: relaxed pace, natural pauses at "…" and "—", a smile in your voice, light emphasis on key ideas, ' +
    'genuine curiosity in questions. Never sound like you are reading.';

/** Like `speakable`, but keeps "…" and "—": the Gemini voice performs them as pauses. */
const performable = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[(\d{1,2})\]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\$([^$]+)\$/g, '$1')
    .replace(/O\(([^)]+)\)/g, 'O of $1')
    .replace(/\^2\b/g, ' squared')
    .replace(/(\*\*|__|\*|`|#+\s|>\s)/g, '')
    .replace(/\.{3,}/g, '…')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

/** Short reactions in the tutor's voice, played the moment the student finishes speaking. */
export const REACTIONS = {
  answer: ['Mm, okay…', 'Alright, let\'s see…', 'Hmm, interesting…', 'Okay, okay…'],
  interrupt: ['Oh — good question!', 'Ooh, okay, hold that thought…', 'Ah, yes — let\'s look at that.'],
  speak: ['Mm-hmm…', 'Okay…'],
} as const;

// ── Gemini voice rate limit ────────────────────────────────────────────────────
// Google allows only so many Gemini voice requests a minute per project
// (quota: global_generate_content_requests_per_minute_per_project_per_base_model).
// Live speech goes first; background work (reactions) only uses half.
const ttsRpm = () => Math.max(1, Number(process.env.TUTOR_TTS_RPM || 5));
const ttsUsed = new Map<string, number[]>();
const ttsPausedUntil = new Map<string, number>();

/** A model with a free request this minute, or null. Background work only uses half of each. */
const takeTtsSlot = (background: boolean) => {
  const now = Date.now();
  for (const model of ttsModels()) {
    const used = ttsUsed.get(model) ?? [];
    while (used.length && now - used[0] > 60_000) used.shift();
    ttsUsed.set(model, used);
    if (now < (ttsPausedUntil.get(model) ?? 0)) continue;
    if (used.length >= (background ? Math.floor(ttsRpm() / 2) : ttsRpm())) continue;
    used.push(now);
    return model;
  }
  return null;
};

/** A model for a live line: waits briefly for one rather than switching voices mid-session. */
const waitForTtsSlot = async (background: boolean) => {
  if (background) return takeTtsSlot(true);
  for (let waited = 0; waited <= 4000; waited += 250) {
    const model = takeTtsSlot(false);
    if (model) return model;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
};

const startGeminiClip = async (rawText: string, tutorVoice: TutorVoice, background = false) => {
  const text = performable(rawText).slice(0, SPEECH_MAX_CHARS);
  if (!text) return null;
  const voiceName = geminiVoiceFor(tutorVoice.voice);
  const prompt = GEMINI_STYLE + accentLine(tutorVoice.accent);
  // Not tied to one model: any of the pool makes the same voice, so a saved clip is reused whichever made it
  const path = clipPath(`gemini-tts:${voiceName}:${tutorVoice.accent}:${GEMINI_STYLE_VERSION}`, text);
  const fallbackVoice: VoiceId = tutorVoice.voice === 'female' ? 'warm' : 'calm';
  const id = clipIdOf(path);
  if (recentClips.has(id) || pendingClips.has(id)) return { id, tier: 'hd' as Tier };
  const making = (async () => {
    // Made before (reactions, repeated lines): reuse it
    if (await getObject(path)) {
      const data = await downloadObject(path);
      remember(id, data);
      return data;
    }
    // Streamed: the app can start playing about a second in, while the rest is still being made
    const live: LiveClip = { chunks: [], done: false, failed: false, listeners: new Set() };
    liveClips.set(id, live);
    try {
      const model = await waitForTtsSlot(background);
      if (!model) {
        if (background) {
          live.failed = true;
          live.done = true;
          return null;
        }
        throw new Error('Gemini voice is at its limit this minute');
      }
      const pcm = await streamGemini(text, prompt, voiceName, model, live);
      const data = wavOf(pcm);
      remember(id, data);
      void saveObject(path, data, 'audio/wav').catch((error) => console.error('Saving a tutor clip failed:', error));
      return data;
    } catch (error) {
      live.failed = true;
      live.done = true;
      live.listeners.forEach((listener) => listener(null));
      // Out of quota: stop asking Google for a moment instead of failing every line
      const exhausted = /base model: ([\w.-]+)/.exec((error as Error).message)?.[1];
      if (/RESOURCE_EXHAUSTED|Quota exceeded/i.test((error as Error).message) && exhausted) {
        ttsPausedUntil.set(exhausted, Date.now() + 20_000);
      }
      if (background) return null;
      // The Gemini voice failed: Google's HD voice says it rather than silence
      console.error('Gemini voice failed, using the HD voice for this line:', (error as Error).message);
      try {
        const [response] = await client.synthesizeSpeech({
          input: { text: speakable(rawText).slice(0, SPEECH_MAX_CHARS) },
          voice: { languageCode: 'en-GB', name: VOICE_NAMES[fallbackVoice].hd },
          audioConfig: { audioEncoding: 'MP3' },
        });
        const data = Buffer.from(response.audioContent as Uint8Array);
        remember(id, data);
        return data;
      } catch {
        return null;
      }
    }
  })().finally(() =>
    setTimeout(() => {
      pendingClips.delete(id);
      liveClips.delete(id);
    }, 60_000)
  );
  pendingClips.set(id, making);
  return { id, tier: 'hd' as Tier };
};

// ── Streaming ──────────────────────────────────────────────────────────────────

/** Raw audio from streamed clips: 16-bit signed little-endian, mono, 24 kHz. */
export const PCM_RATE = 24_000;

/** A clip still being streamed from Google: its audio so far, and who's waiting for more. */
export interface LiveClip {
  chunks: Buffer[];
  done: boolean;
  failed: boolean;
  listeners: Set<(chunk: Buffer | null) => void>;
}
const liveClips = new Map<string, LiveClip>();

/** A clip being streamed right now (or just finished), to pass its audio on as it comes. */
export const liveClip = (id: string) => liveClips.get(id) ?? null;

const streamGemini = (text: string, prompt: string, voiceName: string, model: string, live: LiveClip) =>
  new Promise<Buffer>((resolve, reject) => {
    const stream = client.streamingSynthesize();
    stream.on('data', (response: { audioContent?: Uint8Array }) => {
      const chunk = Buffer.from(response.audioContent ?? []);
      if (!chunk.length) return;
      live.chunks.push(chunk);
      live.listeners.forEach((listener) => listener(chunk));
    });
    stream.on('error', reject);
    stream.on('end', () => {
      if (!live.chunks.length) return reject(new Error('No audio came back'));
      live.done = true;
      live.listeners.forEach((listener) => listener(null));
      resolve(Buffer.concat(live.chunks));
    });
    stream.write({
      streamingConfig: {
        voice: { languageCode: 'en-US', name: voiceName, modelName: model },
        streamingAudioConfig: { audioEncoding: 'PCM', sampleRateHertz: PCM_RATE },
      },
    });
    stream.write({ input: { text, prompt } });
    stream.end();
  });

/** Raw audio as a WAV file, for replays and apps that play whole files. */
const wavOf = (pcm: Buffer) => {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(PCM_RATE, 24);
  header.writeUInt32LE(PCM_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};

/** True for a WAV file (Gemini clips); MP3 otherwise. */
export const isWav = (data: Buffer) => data.subarray(0, 4).toString() === 'RIFF';

/**
 * Makes one student's reactions ahead (their voice and accent), in the
 * background and within the rate limit, so they play instantly. Saved for
 * good, so each accent is made once ever.
 */
export const warmUpReactions = async (tutorVoice: TutorVoice) => {
  if (tutorVoiceMode() !== 'gemini') return;
  for (const phrase of Object.values(REACTIONS).flat()) {
    const clip = await startGeminiClip(phrase, tutorVoice, true).catch(() => null);
    if (!clip) return;
    if (!(await pendingClip(clip.id))) return; // out of slots: try again with the next session
  }
};

/** A sample line for previewing a voice before a session. */
export const VOICE_PREVIEW = "Hi! I'm your BreedX tutor. Let's take this one step at a time… and make it actually click.";

export const startTutorClip = async (rawText: string, tutorVoice: TutorVoice): Promise<{ id: string; tier: Tier } | null> => {
  if (tutorVoiceMode() === 'gemini') return startGeminiClip(rawText, tutorVoice);
  const voice: VoiceId = tutorVoice.voice === 'female' ? 'warm' : 'calm';
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
