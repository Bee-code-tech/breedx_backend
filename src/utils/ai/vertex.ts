import { GenerateContentConfig, GoogleGenAI, Part } from '@google/genai';
import env from '../../config/env';
import { Engine } from '../../config/models';

// Signs in with your gcloud login locally and the VM's service account in production
const ai = new GoogleGenAI({ vertexai: true, project: env.GCP_PROJECT, location: env.GCP_LOCATION });

/** Embeddings are stored at this size: smaller than the model's full size, nearly as accurate. */
export const EMBED_DIMENSIONS = 768;
// Texts sent per embedding request
const EMBED_BATCH = 50;

export interface TokenCount {
  inputTokens: number;
  outputTokens: number;
}

export const ZERO_TOKENS: TokenCount = { inputTokens: 0, outputTokens: 0 };

export const addTokens = (a: TokenCount, b: TokenCount): TokenCount => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
});

interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
}

// Thinking is billed as output, so it counts as output here too
const tokensFrom = (usage?: UsageMetadata): TokenCount => ({
  inputTokens: usage?.promptTokenCount ?? 0,
  outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
});

export interface GenerateOptions {
  engine: Engine;
  system?: string;
  /** Plain text, or parts such as an inline PDF. */
  prompt: string | Part[];
  /** Earlier turns of a conversation, oldest first. */
  history?: { role: 'user' | 'model'; text: string }[];
  /** Ask for JSON matching this schema. */
  json?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

const configFor = (options: GenerateOptions): GenerateContentConfig => ({
  systemInstruction: options.system,
  temperature: options.temperature,
  maxOutputTokens: options.maxOutputTokens,
  abortSignal: options.signal,
  ...(options.json && { responseMimeType: 'application/json', responseJsonSchema: options.json }),
  ...(options.engine.thinkingBudget !== null && {
    thinkingConfig: { thinkingBudget: options.engine.thinkingBudget },
  }),
});

const contentsFor = (options: GenerateOptions) => [
  ...(options.history ?? []).map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
  { role: 'user', parts: typeof options.prompt === 'string' ? [{ text: options.prompt }] : options.prompt },
];

/** One full answer at once. */
export const generate = async (options: GenerateOptions): Promise<{ text: string; tokens: TokenCount }> => {
  const response = await ai.models.generateContent({
    model: options.engine.model,
    contents: contentsFor(options),
    config: configFor(options),
  });
  return { text: response.text ?? '', tokens: tokensFrom(response.usageMetadata) };
};

/** Like `generate`, but parses the JSON answer. */
export const generateJson = async <T>(options: GenerateOptions & { json: Record<string, unknown> }) => {
  const { text, tokens } = await generate(options);
  return { data: JSON.parse(text) as T, tokens };
};

/**
 * The answer piece by piece as it's written, for streaming to the student.
 * `onText` gets each new piece; the total tokens come back at the end.
 */
export const generateStream = async (
  options: GenerateOptions,
  onText: (text: string) => void
): Promise<{ text: string; tokens: TokenCount }> => {
  const stream = await ai.models.generateContentStream({
    model: options.engine.model,
    contents: contentsFor(options),
    config: configFor(options),
  });

  let text = '';
  let usage: UsageMetadata | undefined;
  for await (const chunk of stream) {
    const piece = chunk.text ?? '';
    if (piece) {
      text += piece;
      onText(piece);
    }
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
  }
  return { text, tokens: tokensFrom(usage) };
};

export type EmbedTask = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

// Embedding usage isn't always reported; about four characters make a token
const estimateTokens = (texts: string[]) => Math.ceil(texts.reduce((sum, text) => sum + text.length, 0) / 4);

/** Turns texts into vectors for searching by meaning, in batches. */
export const embed = async (
  texts: string[],
  task: EmbedTask,
  options: { signal?: AbortSignal; onBatch?: (done: number) => void } = {}
): Promise<{ vectors: number[][]; tokens: TokenCount }> => {
  const vectors: number[][] = [];
  let inputTokens = 0;

  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    const batch = texts.slice(start, start + EMBED_BATCH);
    const response = await ai.models.embedContent({
      model: env.AI_EMBED_MODEL,
      contents: batch,
      config: { taskType: task, outputDimensionality: EMBED_DIMENSIONS, abortSignal: options.signal },
    });

    const embeddings = response.embeddings ?? [];
    if (embeddings.length !== batch.length) throw new Error('Embedding count does not match the texts sent');
    for (const embedding of embeddings) vectors.push(embedding.values ?? []);

    const reported = embeddings.reduce((sum, embedding) => sum + (embedding.statistics?.tokenCount ?? 0), 0);
    inputTokens += reported || estimateTokens(batch);
    options.onBatch?.(vectors.length);
  }

  return { vectors, tokens: { inputTokens, outputTokens: 0 } };
};
