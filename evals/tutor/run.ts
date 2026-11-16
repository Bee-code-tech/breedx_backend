/**
 * BreedX Tutor evaluation: simulated students of different kinds go through
 * real tutor sessions on different subjects. Each run measures learning
 * (pre-test vs post-test), checks the rules automatically and has a judge AI
 * grade the transcript. Nothing here is deployed.
 *
 *   npx ts-node -T evals/tutor/run.ts
 *   PERSONAS=bluffer,misconception MATERIALS=cs,ee BEATS=10 CONCURRENCY=3 npx ts-node -T evals/tutor/run.ts
 *
 * Uses the tutor's own settings (TUTOR_PROVIDER etc.) and the database in .env.
 * Test users, files and sessions are deleted afterwards. A report is saved to
 * evals/tutor/results/.
 */
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { AddressInfo } from 'net';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { GoogleGenAI } from '@google/genai';

const SRC = path.resolve(__dirname, '../../src');
/* eslint-disable @typescript-eslint/no-require-imports */
const env = require(`${SRC}/config/env`).default;
const app = require(`${SRC}/app`).default;
const model = (name: string) => require(`${SRC}/models/${name}.model`).default;
const T = require(`${SRC}/models/tutor.model`);
const { signAccessToken } = require(`${SRC}/utils/token`);
const { releaseMaterials } = require(`${SRC}/utils/materials`);
/* eslint-enable @typescript-eslint/no-require-imports */
const [User, Session, Library, LibraryFile, AiUsage, StudyDay] = ['user', 'session', 'library', 'libraryFile', 'aiUsage', 'studyDay'].map(model);

const gemini = new GoogleGenAI({ vertexai: true, project: env.GCP_PROJECT, location: 'global' });
const STUDENT_MODEL = process.env.EVAL_STUDENT_MODEL || 'gemini-3.5-flash';
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || 'gemini-3.1-pro-preview';

// ── Subjects ───────────────────────────────────────────────────────────────────

type Question = { q: string; options: string[]; answer: number };
interface Material {
  name: string;
  topic: RegExp;
  pages: [string, string][];
  misconception: string;
  test: Question[];
}

const MATERIALS: Record<string, Material> = {
  cs: {
    name: 'CSC 201 Lecture 4 - Merge sort',
    topic: /merg/i,
    pages: [
      ['Lecture 4: Merge sort', 'Merge sort splits the list into two halves, sorts each half recursively and merges the sorted halves. A list of length 0 or 1 is the base case because it is already sorted. The list can be halved log n times and each level of merging does O(n) work, so merge sort always takes O(n log n) time, even when the list is already sorted. Merging needs O(n) extra memory.'],
      ['Lecture 4: Merging and stability', 'To merge two sorted halves, compare the front items of each half and move the smaller one to the output, repeating until one half is empty, then copy the rest. Merge sort is stable: when two items are equal, the one from the left half is placed first, so equal items keep their original order.'],
      ['Lecture 4: Merge sort versus quicksort', 'Quicksort sorts in place and is usually faster in practice, but its worst case is O(n^2) when pivots are chosen badly. Merge sort guarantees O(n log n) in every case but needs an auxiliary array of size n. Merge sort is preferred for linked lists and for external sorting.'],
    ],
    misconception: 'You believe merge sort is faster on an already-sorted list because it "skips" parts that are already in order.',
    test: [
      { q: 'How long does merge sort take on a list that is already sorted?', options: ['O(n)', 'O(n log n)', 'O(n^2)', 'O(1)'], answer: 1 },
      { q: 'What is the base case of merge sort?', options: ['A list of length 0 or 1', 'A list of length 2', 'A sorted list', 'An empty half'], answer: 0 },
      { q: 'When two equal items are merged, which goes first?', options: ['The one from the right half', 'Either, at random', 'The one from the left half', 'The larger index'], answer: 2 },
      { q: 'How much extra memory does merging need?', options: ['None', 'O(log n)', 'O(n)', 'O(n^2)'], answer: 2 },
    ],
  },
  ee: {
    name: 'EEE 305 - Induction motors: slip',
    topic: /slip|speed|synchron/i,
    pages: [
      ['Synchronous speed', 'The stator of a three-phase induction motor produces a rotating magnetic field. Its speed, the synchronous speed, is Ns = 120f / P rpm, where f is the supply frequency in Hz and P is the number of poles. For a 4-pole motor on a 50 Hz supply, Ns = 120 x 50 / 4 = 1500 rpm.'],
      ['Slip', 'The rotor always turns slower than the rotating field. Slip is the difference expressed as a fraction of synchronous speed: s = (Ns - Nr) / Ns, where Nr is the rotor speed. So the rotor speed is Nr = (1 - s) Ns. A 4-pole, 50 Hz motor with a slip of 0.04 runs at Nr = 0.96 x 1500 = 1440 rpm.'],
      ['Why slip is needed', 'Torque is produced only because the rotor conductors cut the rotating field and have currents induced in them. If the rotor turned at synchronous speed, s = 0, there would be no relative motion, no induced current and no torque. As load increases, the rotor slows down and slip increases, producing more torque.'],
    ],
    misconception: 'You believe an ideal induction motor runs exactly at synchronous speed, and that slip is just friction loss that better bearings would remove.',
    test: [
      { q: 'What is the synchronous speed of a 6-pole motor on a 50 Hz supply?', options: ['1500 rpm', '1000 rpm', '3000 rpm', '750 rpm'], answer: 1 },
      { q: 'A 4-pole, 50 Hz motor has slip 0.02. What is its rotor speed?', options: ['1470 rpm', '1500 rpm', '1440 rpm', '1530 rpm'], answer: 0 },
      { q: 'What torque does the motor produce at s = 0?', options: ['Maximum torque', 'Rated torque', 'No torque', 'Negative torque'], answer: 2 },
      { q: 'What happens to slip as the load on the motor increases?', options: ['It decreases', 'It stays the same', 'It becomes zero', 'It increases'], answer: 3 },
    ],
  },
};

// ── Students ───────────────────────────────────────────────────────────────────

interface Persona {
  id: string;
  /** How they behave in the session. */
  style: string;
  /** Holds the subject's misconception. */
  misconception: boolean;
  /** Knows the topic well already. */
  strong: boolean;
  /** Cuts the tutor off on this beat with a question. */
  interruptAt?: number;
}

const PERSONAS: Record<string, Persona> = {
  bluffer: { id: 'bluffer', style: 'You often say "yeah I get it" without really explaining. Only when pushed do you give a real, partly correct answer.', misconception: false, strong: false },
  misconception: { id: 'misconception', style: 'You answer honestly and confidently, and you defend your belief until the tutor shows you a concrete case that breaks it.', misconception: true, strong: false },
  lost: { id: 'lost', style: 'You are weak at this subject and often confused. Say when you do not understand. Answer with partial, uncertain guesses.', misconception: false, strong: false },
  fast: { id: 'fast', style: 'You already understand most of this. Answer correctly and briefly, and get a bit impatient with slow explanations.', misconception: false, strong: true },
  terse: { id: 'terse', style: 'You answer with one to three words only, never full sentences, unless directly asked to explain more.', misconception: false, strong: false },
  pidgin: { id: 'pidgin', style: 'You speak Nigerian Pidgin English mixed with English ("abeg", "na so", "wahala", "e be like say"). Your understanding is average.', misconception: true, strong: false },
  interrupter: { id: 'interrupter', style: 'You are curious and ask "why" questions. Your understanding is average.', misconception: false, strong: false, interruptAt: 2 },
  offtopic: { id: 'offtopic', style: 'You get distracted: sometimes ask for the exam answers directly, or mention football. You still answer when the tutor brings you back.', misconception: false, strong: false },
};

const personaPrompt = (persona: Persona, material: Material) =>
  `You role-play a Nigerian university student in a one-on-one tutoring session on "${material.name}". Stay in character. ` +
  `${persona.style} ` +
  (persona.misconception ? `${material.misconception} ` : '') +
  (persona.strong ? 'You already know this topic well. ' : 'Before this session you had only skimmed the topic. ') +
  'Reply with only what you would say out loud: 1 to 2 short sentences.';

const ask = async (system: string, prompt: string, json = false) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await gemini.models.generateContent({
        model: json ? JUDGE_MODEL : STUDENT_MODEL,
        contents: prompt,
        config: {
          systemInstruction: system,
          thinkingConfig: { thinkingBudget: json ? 2048 : 0 },
          ...(json ? { responseMimeType: 'application/json' } : {}),
        },
      });
      return (response.text ?? '').trim();
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  return '';
};

/** The student's test score (0-100), answering as they would at that moment. */
const takeTest = async (persona: Persona, material: Material, transcript: string[] | null) => {
  const questions = material.test.map((item, i) => `${i + 1}. ${item.q}\n${item.options.map((o, j) => `   ${String.fromCharCode(65 + j)}) ${o}`).join('\n')}`).join('\n');
  const reply = await ask(
    personaPrompt(persona, material) +
      ' Now take a short quiz. Answer only from what you, this student, believe' +
      (transcript ? ' after the session below: keep any belief the tutor did not convince you to drop.' : ' before any tutoring.') +
      ' Do not use outside knowledge you would not have. Reply with only the letters, comma separated, e.g. "A,C,B,D".',
    (transcript ? `Session transcript:\n${transcript.join('\n')}\n\n` : '') + `Quiz:\n${questions}`
  );
  const letters = reply.toUpperCase().match(/[A-D]/g) ?? [];
  const right = material.test.filter((item, i) => letters[i] === String.fromCharCode(65 + item.answer)).length;
  return Math.round((right / material.test.length) * 100);
};

// ── One run ────────────────────────────────────────────────────────────────────

const pdfOf = async (pages: [string, string][]) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [heading, body] of pages) {
    const page = doc.addPage();
    page.drawText(heading, { x: 40, y: 740, size: 18, font });
    page.drawText(body, { x: 40, y: 700, size: 10, font, maxWidth: 520, lineHeight: 14 });
  }
  return Buffer.from(await doc.save());
};

const readStream = async (response: globalThis.Response) => {
  const out: { ops: Record<string, unknown>[]; [key: string]: unknown } = { ops: [] };
  for (const raw of (await response.text()).split('\n\n')) {
    const name = raw.match(/^event: (.+)$/m)?.[1];
    const data = raw.match(/^data: (.+)$/m)?.[1];
    if (!name || !data) continue;
    if (name === 'op') out.ops.push(JSON.parse(data));
    else out[name] = JSON.parse(data);
  }
  return out;
};

interface RunResult {
  persona: string;
  material: string;
  pre: number;
  post: number;
  gain: number;
  beats: number;
  avgBeatMs: number;
  silentBeats: number;
  longSays: number;
  errors: number;
  goalsAdvanced: number;
  stage: string;
  termsSaved: number;
  judge: Record<string, unknown> | null;
  transcript: string[];
}

const runOne = async (base: string, persona: Persona, materialId: string, beatsMax: number): Promise<RunResult> => {
  const material = MATERIALS[materialId];
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const user = await User.create({ firstName: 'Eval', lastName: persona.id, email: `eval-${persona.id}-${stamp}@breedx.test`, country: 'NG' });
  const login = await Session.create({ user: user._id, deviceId: 'eval', deviceName: 'eval', refreshTokenHash: 'x', lastSeenAt: new Date(), expiresAt: new Date(Date.now() + 3600e3) });
  const token = signAccessToken(String(user._id), 'user', String(login._id));
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const call = async (method: string, route: string, body?: unknown) =>
    (await fetch(base + route, { method, headers, body: body ? JSON.stringify(body) : undefined })).json();
  const library = await Library.create({ owner: user._id, name: 'Eval', theme: 'lime', icon: 'folder' });
  let materialRef = '';
  let sessionId = '';
  const transcript: string[] = [];
  const result: RunResult = {
    persona: persona.id, material: materialId, pre: 0, post: 0, gain: 0, beats: 0, avgBeatMs: 0, silentBeats: 0,
    longSays: 0, errors: 0, goalsAdvanced: 0, stage: '', termsSaved: 0, judge: null, transcript,
  };
  try {
    const pdf = await pdfOf(material.pages);
    const upload = await call('POST', `/libraries/${library._id}/uploads`, { name: `${material.name}.pdf`, size: pdf.length, contentType: 'application/pdf', category: 'pdfs' });
    await fetch(upload.data.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: pdf });
    const fileId = upload.data.file.id;
    await call('POST', `/libraries/${library._id}/files/${fileId}/complete`);
    materialRef = String((await LibraryFile.findById(fileId).lean()).material);
    const topics = (await call('GET', `/tutor/topics?fileId=${fileId}`)).data.topics as { key: string; title: string }[];
    const topic = topics.find((item) => material.topic.test(item.title)) ?? topics[0];
    sessionId = (await call('POST', '/tutor/sessions', { fileId, topicKey: topic.key })).data.session.id;

    result.pre = await takeTest(persona, material, null);
    let event: Record<string, unknown> = { type: 'start' };
    let totalMs = 0;
    for (let beat = 1; beat <= beatsMax; beat++) {
      const started = Date.now();
      const out = await readStream(await fetch(`${base}/tutor/sessions/${sessionId}/events`, { method: 'POST', headers, body: JSON.stringify(event) }));
      totalMs += Date.now() - started;
      result.beats++;
      if (out.error) {
        result.errors++;
        transcript.push(`[error: ${(out.error as { message?: string }).message}]`);
        break;
      }
      const says = out.ops.filter((op) => op.op === 'say');
      if (!says.length && !out.ended) result.silentBeats++;
      for (const op of out.ops) {
        if (op.op === 'say') {
          transcript.push(`Tutor: ${op.text}`);
          if (String(op.text).split(/\s+/).length > 60) result.longSays++;
        } else if (op.op === 'draw') {
          transcript.push(`[board: ${(op.elements as Record<string, unknown>[]).map((e) => `${e.kind}${e.text ? ` "${e.text}"` : ''}${e.latex ? ` ${e.latex}` : ''}`).join('; ')}]`);
        } else if (op.op === 'ask') {
          transcript.push(`Tutor asks (${op.level}): ${op.question}`);
        } else if (op.op === 'stage') {
          transcript.push(`[stage: ${op.stage}]`);
        }
      }
      if (out.ended) break;
      const question = out.ops.find((op) => op.op === 'ask');
      const lastSay = says[says.length - 1] as { clips?: { text: string }[] } | undefined;
      if (persona.interruptAt === beat && lastSay?.clips?.length) {
        const text = await ask(personaPrompt(persona, material), `Session so far:\n${transcript.slice(-10).join('\n')}\n\nYou cut the tutor off mid-sentence with a why-question. What do you say?`);
        transcript.push(`Student (interrupts): ${text}`);
        event = { type: 'interrupt', text, clip: 0 };
        continue;
      }
      if (question) {
        const text = await ask(personaPrompt(persona, material), `Session so far:\n${transcript.slice(-14).join('\n')}\n\nYour reply to the tutor's question:`);
        transcript.push(`Student: ${text}`);
        event = { type: 'answer', text };
      } else {
        event = { type: 'beat_done' };
      }
    }
    result.avgBeatMs = Math.round(totalMs / Math.max(1, result.beats));
    result.post = await takeTest(persona, material, transcript);
    result.gain = result.post - result.pre;

    const session = await T.TutorSession.findById(sessionId).lean();
    result.goalsAdvanced = session?.goalIndex ?? 0;
    result.stage = session?.stage ?? '';
    result.termsSaved = (await T.StudentProfile.findOne({ user: user._id }).lean())?.terms?.length ?? 0;

    const judged = await ask(
      'You are an expert in teaching and learning science, grading an AI tutor. Be strict and concrete. Return only JSON.',
      `Course material (the ONLY source of truth):\n${material.pages.map(([h, b]) => `${h}: ${b}`).join('\n')}\n\n` +
        `Student type: ${persona.style}${persona.misconception ? ` Misconception: ${material.misconception}` : ''}\n\n` +
        `Transcript:\n${transcript.join('\n')}\n\n` +
        'Return JSON: {"invented_facts": [facts the tutor stated that the material does not support], ' +
        '"misconception_addressed": true|false|null (null if the student had none), ' +
        '"checked_understanding": 1-5 (asked the student to show it, did not accept vague agreement), ' +
        '"adapted_to_student": 1-5 (changed approach for this kind of student), ' +
        '"used_student_words": 1-5, "clarity": 1-5, "warmth": 1-5, "one_idea_per_beat": 1-5, ' +
        '"stayed_on_task": 1-5, "overall": 1-10, "biggest_problem": "one sentence", "best_moment": "one sentence"}',
      true
    );
    try {
      result.judge = JSON.parse(judged);
    } catch {
      result.judge = { raw: judged };
    }
  } catch (error) {
    result.errors++;
    transcript.push(`[run failed: ${(error as Error).message}]`);
  } finally {
    await Promise.all([
      T.TutorEvent.deleteMany({ session: sessionId || null }),
      T.TutorSession.deleteMany({ user: user._id }),
      T.StudentProfile.deleteMany({ user: user._id }),
      AiUsage.deleteMany({ user: user._id }),
      StudyDay.deleteMany({ user: user._id }),
      LibraryFile.deleteMany({ owner: user._id }),
      Library.deleteMany({ owner: user._id }),
      Session.deleteOne({ _id: login._id }),
      User.deleteOne({ _id: user._id }),
    ]);
    // The material and its teacher guide stay, so later runs reuse them; released when nothing uses them
    if (materialRef && process.env.EVAL_KEEP_FILES !== '1') await releaseMaterials([materialRef]);
  }
  return result;
};

// ── All runs ───────────────────────────────────────────────────────────────────

const pool = async <I, O>(items: I[], size: number, work: (item: I) => Promise<O>) => {
  const results: O[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]);
      }
    })
  );
  return results;
};

(async () => {
  const personas = (process.env.PERSONAS || Object.keys(PERSONAS).join(',')).split(',').map((id) => PERSONAS[id.trim()]).filter(Boolean);
  const materials = (process.env.MATERIALS || Object.keys(MATERIALS).join(',')).split(',').map((id) => id.trim()).filter((id) => MATERIALS[id]);
  const beats = Number(process.env.BEATS || 10);
  const concurrency = Number(process.env.CONCURRENCY || 3);

  await mongoose.connect(env.MONGODB_URI);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const jobs = materials.flatMap((material) => personas.map((persona) => ({ persona, material })));
  console.log(`Running ${jobs.length} sessions (${beats} beats each, ${concurrency} at a time) on ${process.env.TUTOR_PROVIDER || 'gemini'}…`);

  const results = await pool(jobs, concurrency, async ({ persona, material }) => {
    const result = await runOne(base, persona, material, beats);
    const j = result.judge ?? {};
    console.log(
      `${material.padEnd(3)} ${persona.id.padEnd(13)} learning ${result.pre}→${result.post} (${result.gain >= 0 ? '+' : ''}${result.gain}) · ` +
        `judge ${j.overall ?? '?'}/10 · invented ${Array.isArray(j.invented_facts) ? j.invented_facts.length : '?'} · ` +
        `goals ${result.goalsAdvanced} · ${result.avgBeatMs}ms/beat · silent ${result.silentBeats} · errors ${result.errors}`
    );
    return result;
  });

  const avg = (values: number[]) => (values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : 0);
  const judged = results.filter((r) => typeof r.judge?.overall === 'number');
  const summary = {
    sessions: results.length,
    learningGain: avg(results.map((r) => r.gain)),
    preScore: avg(results.map((r) => r.pre)),
    postScore: avg(results.map((r) => r.post)),
    judgeOverall: avg(judged.map((r) => r.judge!.overall as number)),
    inventedFacts: judged.reduce((n, r) => n + ((r.judge!.invented_facts as unknown[] | undefined)?.length ?? 0), 0),
    misconceptionsAddressed: `${judged.filter((r) => r.judge!.misconception_addressed === true).length}/${judged.filter((r) => r.judge!.misconception_addressed !== null && r.judge!.misconception_addressed !== undefined).length}`,
    checkedUnderstanding: avg(judged.map((r) => r.judge!.checked_understanding as number)),
    adapted: avg(judged.map((r) => r.judge!.adapted_to_student as number)),
    usedStudentWords: avg(judged.map((r) => r.judge!.used_student_words as number)),
    clarity: avg(judged.map((r) => r.judge!.clarity as number)),
    warmth: avg(judged.map((r) => r.judge!.warmth as number)),
    stayedOnTask: avg(judged.map((r) => r.judge!.stayed_on_task as number)),
    avgBeatMs: avg(results.map((r) => r.avgBeatMs)),
    silentBeats: results.reduce((n, r) => n + r.silentBeats, 0),
    longSays: results.reduce((n, r) => n + r.longSays, 0),
    errors: results.reduce((n, r) => n + r.errors, 0),
  };
  console.log('\nSUMMARY', JSON.stringify(summary, null, 2));
  console.log('\nBIGGEST PROBLEMS:');
  for (const r of judged) console.log(`- ${r.material}/${r.persona}: ${r.judge!.biggest_problem}`);

  const dir = path.join(__dirname, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ summary, results, settings: { provider: process.env.TUTOR_PROVIDER || 'gemini', beats } }, null, 2));
  console.log(`\nReport: ${file}`);
  server.close();
  await mongoose.disconnect();
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
