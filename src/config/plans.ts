// What each plan allows. Storage and libraries are account-wide: a student can
// put all their storage in one library or spread it across them.
export const PLAN_IDS = ['free', 'scholar', 'elite'] as const;

export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanLimits {
  /** How many libraries the student can own. `null` means unlimited. */
  libraries: number | null;
  /** Total storage across every library, in bytes. Each file counts once. */
  storageBytes: number;
  /** Largest single file, in bytes. */
  maxFileBytes: number;
  /** How many spaces the student can own. Joining others' spaces is free. */
  spaces: number | null;
  ai: AiAllowance;
  quizzes: QuizAllowance;
  /** Characters a day read aloud in a human voice (cached clips are free). Then the phone's own voice. */
  speechPerDay: number;
}

/** Daily quiz limits, counted per UTC day. `null` means unlimited. */
export interface QuizAllowance {
  /** Quizzes created a day, by AI, by hand or imported. */
  createsPerDay: number | null;
  /** Attempts a day at quizzes the student made. */
  privateTakesPerDay: number | null;
  /** Attempts a day at quizzes other people shared. */
  publicTakesPerDay: number | null;
}

/**
 * AI energy works like a tank that refills a little every moment. Students can
 * save up for a heavy study night, and an empty tank means hours of waiting,
 * never a month. One unit of energy is one token on Vega; stronger models
 * drain it faster (see config/models.ts).
 */
export interface AiAllowance {
  /** Most energy the tank holds, about three days of refills. */
  tank: number;
  /** Energy added per day, spread evenly over the day. Monthly total ≈ × 30. */
  refillPerDay: number;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: {
    libraries: 2,
    storageBytes: 2 * GB,
    maxFileBytes: 25 * MB,
    spaces: 1,
    ai: { tank: 30_000, refillPerDay: 10_000 }, // ≈ 300k a month
    quizzes: { createsPerDay: 2, privateTakesPerDay: 1, publicTakesPerDay: 4 },
    speechPerDay: 2_500, // about 3 answers
  },
  scholar: {
    libraries: 10,
    storageBytes: 10 * GB,
    maxFileBytes: 100 * MB,
    spaces: 5,
    ai: { tank: 150_000, refillPerDay: 50_000 }, // ≈ 1.5M a month
    quizzes: { createsPerDay: 10, privateTakesPerDay: 10, publicTakesPerDay: null },
    speechPerDay: 25_000, // about 30 answers
  },
  elite: {
    libraries: null,
    storageBytes: 50 * GB,
    maxFileBytes: 250 * MB,
    spaces: null,
    ai: { tank: 400_000, refillPerDay: 135_000 }, // ≈ 4M a month
    quizzes: { createsPerDay: null, privateTakesPerDay: null, publicTakesPerDay: null },
    speechPerDay: 60_000, // about 75 answers
  },
};
