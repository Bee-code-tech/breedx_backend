import env from './env';
import { PlanId } from './plans';

// BreedX's own AI models. Students pick these by name; the real model behind
// each one is ours to change and is never sent to the frontend.
export const AI_MODEL_IDS = ['vega', 'lyra', 'orion', 'polaris'] as const;

export type AiModelId = (typeof AI_MODEL_IDS)[number];

/** How a model may be used on a plan. `null` daily means as often as energy allows. */
export interface ModelAccess {
  daily: number | null;
}

export interface AiModel {
  id: AiModelId;
  name: string;
  tagline: string;
  /** 1 (fastest) to 4 (strongest), for ordering in the picker. */
  tier: number;
  /** Energy drained per token, compared with Vega. */
  energy: number;
  /** Plans that can use it. A plan missing here sees the model locked. */
  access: Partial<Record<PlanId, ModelAccess>>;
}

export const AI_MODELS: Record<AiModelId, AiModel> = {
  vega: {
    id: 'vega',
    name: 'Vega',
    tagline: 'Fastest for quick answers',
    tier: 1,
    energy: 1,
    access: { free: { daily: null }, scholar: { daily: null }, elite: { daily: null } },
  },
  lyra: {
    id: 'lyra',
    name: 'Lyra',
    tagline: 'Best for everyday studying',
    tier: 2,
    energy: 3,
    access: { free: { daily: 5 }, scholar: { daily: null }, elite: { daily: null } },
  },
  orion: {
    id: 'orion',
    name: 'Orion',
    tagline: 'For complex maths & reasoning',
    tier: 3,
    energy: 10,
    access: { scholar: { daily: null }, elite: { daily: null } },
  },
  polaris: {
    id: 'polaris',
    name: 'Polaris',
    tagline: 'Thinks deeply. For your toughest questions',
    tier: 4,
    energy: 20,
    access: { elite: { daily: null } },
  },
};

/** The model a plan starts on when the student hasn't picked one. */
export const DEFAULT_MODEL: Record<PlanId, AiModelId> = {
  free: 'vega',
  scholar: 'lyra',
  elite: 'lyra',
};

export const isModelId = (value: unknown): value is AiModelId =>
  typeof value === 'string' && (AI_MODEL_IDS as readonly string[]).includes(value);

/** The real model and settings behind a BreedX model. Server-side only. */
export interface Engine {
  model: string;
  /** Thinking tokens allowed before answering. 0 turns thinking off, -1 lets the model decide. */
  thinkingBudget: number | null;
}

// Newer models think before answering unless told not to, which costs extra
const FAST: Engine = { model: env.AI_ENGINE_FAST, thinkingBudget: 0 };

export const engineFor = (id: AiModelId, plan: PlanId): Engine => {
  switch (id) {
    case 'vega':
      return FAST;
    case 'lyra':
      // Free students always run on the cheap model; Lyra adds better prompts
      return plan === 'free'
        ? FAST
        : { model: env.AI_ENGINE_BALANCED, thinkingBudget: 0 };
    case 'orion':
      return { model: env.AI_ENGINE_STRONG, thinkingBudget: 2048 };
    case 'polaris':
      return { model: env.AI_ENGINE_STRONG, thinkingBudget: -1 };
  }
};

/** Behind-the-scenes jobs (topic maps, scanned-page reading) always use the cheap model. */
export const BACKGROUND_ENGINE: Engine = FAST;
