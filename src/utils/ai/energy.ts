import { Types } from 'mongoose';
import { AI_MODEL_IDS, AI_MODELS, AiModelId, DEFAULT_MODEL } from '../../config/models';
import { PLAN_IDS, PLAN_LIMITS, PlanId } from '../../config/plans';
import AiUsage from '../../models/aiUsage.model';
import User from '../../models/user.model';
import { AiFeature } from '../../types/ai';
import { IUser } from '../../types/user';
import { activePlan } from '../plan';
import { TokenCount } from './vertex';

const DAY = 24 * 60 * 60 * 1000;
const PLAN_NAMES: Record<PlanId, string> = { free: 'Free', scholar: 'Scholar', elite: 'Elite' };
// Below this share of the tank, the student is told their energy is low
const LOW_SHARE = 0.1;

type EnergyFields = Pick<IUser, 'plan' | 'planExpiresAt' | 'aiEnergy' | 'aiEnergyAt' | 'aiReserve'>;
const ENERGY_FIELDS = 'plan planExpiresAt aiEnergy aiEnergyAt aiReserve';

/** Energy in the tank right now: the last balance plus what has refilled since, up to a full tank. */
const levelOf = (user: EnergyFields, plan: PlanId, now: number) => {
  const { tank, refillPerDay } = PLAN_LIMITS[plan].ai;
  if (user.aiEnergy === null || user.aiEnergy === undefined || !user.aiEnergyAt) return tank;
  const refilled = user.aiEnergy + ((now - user.aiEnergyAt.getTime()) / DAY) * refillPerDay;
  return Math.min(tank, refilled);
};

/** When the tank will hold `target` energy again, or now if it already does. */
const timeUntil = (level: number, target: number, refillPerDay: number, now: number) =>
  new Date(now + Math.max(0, ((target - level) / refillPerDay) * DAY));

export const startOfToday = () => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return today;
};

const usedToday = async (userId: string, model: AiModelId) =>
  AiUsage.countDocuments({ user: userId, aiModel: model, energy: { $gt: 0 }, createdAt: { $gte: startOfToday() } });

/** Everything the frontend needs for the energy bar. */
export const energyFor = async (userId: string) => {
  const user = await User.findById(userId).select(ENERGY_FIELDS).lean<EnergyFields>();
  const plan = user ? activePlan(user) : 'free';
  const { tank, refillPerDay } = PLAN_LIMITS[plan].ai;
  const now = Date.now();
  const level = user ? levelOf(user, plan, now) : tank;
  const balance = Math.max(0, Math.floor(level));

  return {
    plan,
    balance,
    tank,
    percent: Math.round((balance / tank) * 100),
    refillPerDay,
    reserve: user?.aiReserve ?? 0,
    low: level <= tank * LOW_SHARE,
    empty: level <= 0 && !(user?.aiReserve ?? 0),
    fullAt: timeUntil(level, tank, refillPerDay, now),
  };
};

/** The model picker: every model, whether this student can use it, and how many uses are left today. */
export const modelsFor = async (userId: string, plan: PlanId) =>
  Promise.all(
    AI_MODEL_IDS.map(async (id) => {
      const model = AI_MODELS[id];
      const access = model.access[plan];
      const daily = access?.daily ?? null;
      return {
        id,
        name: model.name,
        tagline: model.tagline,
        tier: model.tier,
        energyRate: model.energy,
        available: Boolean(access),
        // The cheapest plan that unlocks it, for the upgrade badge
        requiresPlan: access ? null : PLAN_IDS.find((candidate) => model.access[candidate]) ?? null,
        dailyLimit: daily,
        dailyLeft: daily === null ? null : Math.max(0, daily - (await usedToday(userId, id))),
        default: DEFAULT_MODEL[plan] === id,
      };
    })
  );

export type AiBlock =
  | { code: 'MODEL_LOCKED'; message: string; requiresPlan: PlanId | null }
  | { code: 'MODEL_DAILY_LIMIT'; message: string; resetsAt: Date }
  | { code: 'AI_ENERGY_EMPTY'; message: string; readyAt: Date; fullAt: Date };

/** Checks a student may run a model now. Returns why not, or null when they can. */
export const checkModel = async (userId: string, modelId: AiModelId): Promise<AiBlock | null> => {
  const user = await User.findById(userId).select(ENERGY_FIELDS).lean<EnergyFields>();
  const plan = user ? activePlan(user) : 'free';
  const model = AI_MODELS[modelId];
  const access = model.access[plan];

  if (!access) {
    const requiresPlan = PLAN_IDS.find((candidate) => model.access[candidate]) ?? null;
    return { code: 'MODEL_LOCKED', message: `${model.name} is available on the ${requiresPlan ? PLAN_NAMES[requiresPlan] : 'higher'} plan. Upgrade to use it.`, requiresPlan };
  }

  if (access.daily !== null && (await usedToday(userId, modelId)) >= access.daily) {
    return {
      code: 'MODEL_DAILY_LIMIT',
      message: `You've used ${model.name} ${access.daily} times today. Try Vega, or come back tomorrow.`,
      resetsAt: new Date(startOfToday().getTime() + DAY),
    };
  }

  const { tank, refillPerDay } = PLAN_LIMITS[plan].ai;
  const now = Date.now();
  const level = user ? levelOf(user, plan, now) : tank;
  if (level <= 0 && !(user?.aiReserve ?? 0)) {
    // Ready again once there's enough for a typical question
    const readyAt = timeUntil(level, tank * 0.05, refillPerDay, now);
    return {
      code: 'AI_ENERGY_EMPTY',
      message: 'Your AI energy is recharging. Flashcards and quizzes still work, or top up to keep going.',
      readyAt,
      fullAt: timeUntil(level, tank, refillPerDay, now),
    };
  }
  return null;
};

export interface Charge {
  before: number;
  after: number;
  tank: number;
  /** True the moment the tank first drops into the low zone, to warn once. */
  crossedLow: boolean;
}

/**
 * Takes energy after a request has finished. The tank goes first, then bought
 * top-ups. A request that started with energy always finishes, so the tank may
 * dip a little below zero; it refills from there.
 */
const charge = async (userId: string, amount: number): Promise<Charge | null> => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const user = await User.findById(userId).select(ENERGY_FIELDS).lean<EnergyFields>();
    if (!user) return null;
    const plan = activePlan(user);
    const { tank } = PLAN_LIMITS[plan].ai;
    const now = Date.now();
    const before = levelOf(user, plan, now);

    const fromTank = Math.min(amount, Math.max(before, 0));
    const fromReserve = Math.min(amount - fromTank, user.aiReserve ?? 0);
    const after = before - (amount - fromReserve);

    // Only applies if nothing else charged in between; otherwise try again
    const updated = await User.updateOne(
      {
        _id: userId,
        aiEnergyAt: user.aiEnergyAt ?? null,
        // Older accounts have no reserve field yet, which counts as 0
        aiReserve: user.aiReserve ? user.aiReserve : { $in: [0, null] },
      },
      { $set: { aiEnergy: after, aiEnergyAt: new Date(now), aiReserve: (user.aiReserve ?? 0) - fromReserve } }
    );
    if (updated.modifiedCount) {
      return { before, after, tank, crossedLow: before > tank * LOW_SHARE && after <= tank * LOW_SHARE };
    }
  }
  console.error(`Could not charge ${amount} AI energy to user ${userId}`);
  return null;
};

export interface UsageRecord {
  userId: string;
  feature: AiFeature;
  engine: string;
  tokens: TokenCount;
  /** The student's model. Leave out for work that costs them no energy. */
  model?: AiModelId;
  material?: Types.ObjectId | string;
  session?: Types.ObjectId | string;
}

/**
 * Records what a request cost. With a model, the student pays energy for it
 * (tokens × the model's rate); without one it's free for them but still logged.
 */
export const recordUsage = async (record: UsageRecord): Promise<{ energy: number; charge: Charge | null }> => {
  const { inputTokens, outputTokens } = record.tokens;
  if (!inputTokens && !outputTokens) return { energy: 0, charge: null };
  const energy = record.model ? (inputTokens + outputTokens) * AI_MODELS[record.model].energy : 0;

  await AiUsage.create({
    user: record.userId,
    feature: record.feature,
    aiModel: record.model ?? null,
    engine: record.engine,
    inputTokens,
    outputTokens,
    energy,
    material: record.material ?? null,
    session: record.session ?? null,
  });
  return { energy, charge: energy ? await charge(record.userId, energy) : null };
};
