import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { Content, GoogleGenAI, Part } from '@google/genai';
import env from '../../config/env';
import { claude, claudeProvider } from '../ai/claude';

/**
 * Which AI runs the tutor, chosen by env alone; nothing else in the tutor
 * knows. TUTOR_PROVIDER=gemini (default) uses Gemini on Vertex (paid by Google
 * Cloud credits). TUTOR_PROVIDER=claude uses Claude: from Anthropic directly
 * when ANTHROPIC_API_KEY is set, otherwise from Vertex AI.
 *
 * Model per job, each overridable: TUTOR_BEAT_MODEL, TUTOR_RETEACH_MODEL,
 * TUTOR_GUIDE_MODEL, TUTOR_LISTENER_MODEL.
 */
export type TutorProvider = 'gemini' | 'claude';

export const currentProvider = (): TutorProvider => (process.env.TUTOR_PROVIDER === 'claude' ? 'claude' : 'gemini');

const DEFAULTS: Record<TutorProvider, { beat: string; backup: string; reteach: string; guide: string; listener: string }> = {
  gemini: {
    beat: 'gemini-3.5-flash',
    // Used only when the beat model stays busy, so the student isn't kept waiting
    backup: 'gemini-3.5-flash-lite',
    // Same fast model, more thinking: Pro took ~15 s a beat, too slow to feel live
    reteach: 'gemini-3.5-flash',
    guide: 'gemini-3.1-pro-preview',
    listener: 'gemini-3.5-flash-lite',
  },
  claude: {
    beat: 'claude-sonnet-5-5',
    backup: 'claude-haiku-5-5',
    reteach: 'claude-sonnet-5-5',
    guide: 'claude-opus-5-5',
    listener: 'claude-haiku-5-5',
  },
};

export const modelsFor = (provider: TutorProvider) => ({
  beat: process.env.TUTOR_BEAT_MODEL || DEFAULTS[provider].beat,
  backup: process.env.TUTOR_BACKUP_MODEL || DEFAULTS[provider].backup,
  reteach: process.env.TUTOR_RETEACH_MODEL || DEFAULTS[provider].reteach,
  guide: process.env.TUTOR_GUIDE_MODEL || DEFAULTS[provider].guide,
  listener: process.env.TUTOR_LISTENER_MODEL || DEFAULTS[provider].listener,
});

/** Which service the usage is billed to, for the records. */
export const providerLabel = (provider: TutorProvider) => (provider === 'claude' ? `claude-${claudeProvider}` : 'gemini-vertex');

const gemini = new GoogleGenAI({ vertexai: true, project: env.GCP_PROJECT, location: 'global' });

// Thinking per job on Gemini: a little for live beats (speed), more where quality matters
const GEMINI_THINKING = {
  // Teaching beats are prepared while the previous one plays, so they can afford some thinking
  beat: Number(process.env.TUTOR_BEAT_THINKING ?? 1024),
  // A reply to what the student just said: they're waiting, so less
  reply: Number(process.env.TUTOR_REPLY_THINKING ?? 256),
  reteach: 1024,
  guide: 4096,
  listener: 0,
} as const;

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const ZERO: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Gemini's JSON schema support is narrower: drop what it may reject. */
const forGemini = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(forGemini);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(
    Object.entries(schema as Record<string, unknown>)
      .filter(([key]) => key !== 'additionalProperties')
      .map(([key, value]) => [key, forGemini(value)])
  );
};

const geminiUsage = (usage?: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}): Usage => ({
  input: (usage?.promptTokenCount ?? 0) - (usage?.cachedContentTokenCount ?? 0),
  output: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
  cacheRead: usage?.cachedContentTokenCount ?? 0,
  cacheWrite: 0,
});

const claudeUsage = (usage: Anthropic.Usage): Usage => ({
  input: usage.input_tokens,
  output: usage.output_tokens,
  cacheRead: usage.cache_read_input_tokens ?? 0,
  cacheWrite: usage.cache_creation_input_tokens ?? 0,
});

// ── Retries ────────────────────────────────────────────────────────────────────

// Waits before each retry when the AI is busy (Gemini's shared capacity, or a rate limit)
const RETRY_DELAYS_MS = [800, 2000, 4500];
// A live beat retries less, then moves to the backup model instead of keeping the student waiting
const BEAT_RETRY_DELAYS_MS = [600, 1500];

const isBusy = (error: unknown) => {
  const status = (error as { status?: number }).status;
  return status === 429 || status === 503 || status === 529 || /RESOURCE_EXHAUSTED|overloaded/i.test(String((error as Error).message));
};

/** Runs it, retrying a few times while the AI is busy. Never retries after an abort. */
const withRetry = async <T>(run: () => Promise<T>, signal?: AbortSignal, delays = RETRY_DELAYS_MS): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (signal?.aborted || !isBusy(error) || attempt >= delays.length) throw error;
      if (process.env.TUTOR_DEBUG === '1') console.log(`[tutor] AI busy, retry ${attempt + 1}`);
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
};

// ── One JSON answer (teacher guide, grading) ───────────────────────────────────

export const generateStructured = <T>(
  provider: TutorProvider,
  job: 'guide' | 'listener',
  options: { system: string; prompt: string; schema: Record<string, unknown>; maxTokens: number }
): Promise<{ data: T | null; model: string; usage: Usage; refused: boolean }> => withRetry(() => structuredOnce<T>(provider, job, options));

const structuredOnce = async <T>(
  provider: TutorProvider,
  job: 'guide' | 'listener',
  options: { system: string; prompt: string; schema: Record<string, unknown>; maxTokens: number }
): Promise<{ data: T | null; model: string; usage: Usage; refused: boolean }> => {
  const model = modelsFor(provider)[job];
  if (provider === 'claude') {
    const response = await claude.messages.parse({
      model,
      max_tokens: options.maxTokens,
      output_config: {
        effort: job === 'guide' ? 'medium' : 'low',
        format: jsonSchemaOutputFormat(options.schema as { type: 'object' }),
      },
      system: options.system,
      messages: [{ role: 'user', content: options.prompt }],
    });
    return {
      data: (response.parsed_output as T) ?? null,
      model,
      usage: claudeUsage(response.usage),
      refused: response.stop_reason === 'refusal',
    };
  }
  const response = await gemini.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: options.prompt }] }],
    config: {
      systemInstruction: options.system,
      maxOutputTokens: options.maxTokens,
      responseMimeType: 'application/json',
      responseJsonSchema: forGemini(options.schema),
      thinkingConfig: { thinkingBudget: GEMINI_THINKING[job] },
    },
  });
  let data: T | null = null;
  try {
    data = JSON.parse(response.text ?? '') as T;
  } catch {
    data = null;
  }
  return { data, model, usage: geminiUsage(response.usageMetadata), refused: false };
};

// ── One live beat with tools ───────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  result: string;
  isError?: boolean;
}

export interface BeatResult {
  /** The whole conversation so far, in the provider's own format, to store as is. */
  history: unknown[];
  calls: ToolCall[];
  /** Any plain text the model wrote instead of using tools. */
  text: string;
  refused: boolean;
  model: string;
  usage: Usage;
}

export interface BeatOptions {
  job: 'beat' | 'reply' | 'reteach';
  system: string;
  /** Earlier turns, exactly as a previous beat returned them. */
  history: unknown[];
  /** Results of the last beat's tool calls, then this turn's state. */
  toolResults: ToolResult[];
  text: string;
  tools: Anthropic.Tool[];
  maxTokens: number;
  signal: AbortSignal;
  /** Each finished tool call, in order, while the rest is still being written. */
  onToolCall: (call: ToolCall) => void;
}

const claudeBeat = async (options: BeatOptions, model: string): Promise<BeatResult> => {
  const content: Anthropic.ContentBlockParam[] = [
    ...options.toolResults.map(
      (result): Anthropic.ToolResultBlockParam => ({
        type: 'tool_result',
        tool_use_id: result.id,
        content: result.result,
        ...(result.isError ? { is_error: true } : {}),
      })
    ),
    { type: 'text', text: options.text },
  ];
  const messages = [...(options.history as Anthropic.MessageParam[]), { role: 'user' as const, content }];
  const stream = claude.messages.stream(
    {
      model,
      max_tokens: options.maxTokens,
      output_config: { effort: 'low' },
      cache_control: { type: 'ephemeral' },
      system: [{ type: 'text', text: options.system, cache_control: { type: 'ephemeral' } }],
      tools: options.tools,
      messages,
    },
    { signal: options.signal }
  );
  const calls: ToolCall[] = [];
  stream.on('contentBlock', (block) => {
    if (block.type !== 'tool_use') return;
    const call = { id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> };
    calls.push(call);
    options.onToolCall(call);
  });
  const message = await stream.finalMessage();
  return {
    history: [...messages, { role: 'assistant', content: message.content }],
    calls,
    text: message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .trim(),
    refused: message.stop_reason === 'refusal',
    model,
    usage: claudeUsage(message.usage),
  };
};

const geminiBeat = async (options: BeatOptions, model: string): Promise<BeatResult> => {
  const parts: Part[] = [
    ...options.toolResults.map(
      (result): Part => ({
        functionResponse: {
          ...(result.id.startsWith('call_') ? {} : { id: result.id }),
          name: result.name,
          response: result.isError ? { error: result.result } : { output: result.result },
        },
      })
    ),
    { text: options.text },
  ];
  const contents: Content[] = [...(options.history as Content[]), { role: 'user', parts }];
  if (process.env.TUTOR_DEBUG === '1') {
    console.log('[tutor] sending', contents.map((c) => `${c.role}(${(c.parts ?? []).map((p) => Object.keys(p).filter((k) => k !== 'thoughtSignature').join('+')).join(',')})`).join(' '));
  }
  const stream = await gemini.models.generateContentStream({
    model,
    contents,
    config: {
      systemInstruction: options.system,
      maxOutputTokens: options.maxTokens,
      abortSignal: options.signal,
      tools: [
        {
          functionDeclarations: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parametersJsonSchema: forGemini(tool.input_schema),
          })),
        },
      ],
      // The tutor only acts through tools
      toolConfig: { functionCallingConfig: { mode: 'ANY' as never } },
      thinkingConfig: { thinkingBudget: GEMINI_THINKING[options.job] },
    },
  });

  // Keep every part as returned (thought signatures included): Gemini needs them back
  const modelParts: Part[] = [];
  const calls: ToolCall[] = [];
  let text = '';
  let usage: Usage = ZERO;
  for await (const chunk of stream) {
    for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
      modelParts.push(part);
      if (part.functionCall?.name) {
        const call = {
          id: part.functionCall.id || `call_${calls.length}_${Date.now()}`,
          name: part.functionCall.name,
          input: (part.functionCall.args ?? {}) as Record<string, unknown>,
        };
        calls.push(call);
        options.onToolCall(call);
      } else if (part.text && !part.thought) {
        text += part.text;
      }
    }
    if (chunk.usageMetadata) usage = geminiUsage(chunk.usageMetadata);
  }
  return {
    history: [...contents, { role: 'model', parts: modelParts }],
    calls,
    text: text.trim(),
    refused: false,
    model,
    usage,
  };
};

/**
 * One beat. Reteach beats use the stronger model; if it fails, the beat
 * is retried on the usual one so the student never waits on an error.
 */
export const runBeat = async (provider: TutorProvider, options: BeatOptions): Promise<BeatResult> => {
  const models = modelsFor(provider);
  const once = provider === 'claude' ? claudeBeat : geminiBeat;
  // A busy error comes before anything streams, so retrying can't repeat a tool call
  const run = (opts: BeatOptions, model: string) => withRetry(() => once(opts, model), opts.signal, BEAT_RETRY_DELAYS_MS);
  if (options.job === 'reteach' && models.reteach !== models.beat) {
    try {
      return await run(options, models.reteach);
    } catch (error) {
      if (options.signal.aborted) throw error;
      console.error('Reteach model failed, using the usual one:', (error as Error).message);
    }
  }
  try {
    return await run(options, models.beat);
  } catch (error) {
    // Still busy: the backup model answers now rather than the student waiting
    if (options.signal.aborted || !isBusy(error)) throw error;
    if (models.backup !== models.beat) {
      console.error(`${models.beat} busy, using ${models.backup} for this beat`);
      try {
        return await once(options, models.backup);
      } catch (backupError) {
        // The backup can't always continue another model's conversation (Gemini Flash-Lite can't): keep waiting on the usual one
        if (options.signal.aborted) throw backupError;
        console.error(`${models.backup} failed too (${(backupError as Error).message.slice(0, 80)}), waiting for ${models.beat}`);
      }
    }
    return withRetry(() => once(options, models.beat), options.signal, RETRY_DELAYS_MS);
  }
};
