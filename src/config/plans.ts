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
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: { libraries: 2, storageBytes: 500 * MB, maxFileBytes: 25 * MB, spaces: 1 },
  scholar: { libraries: 10, storageBytes: 5 * GB, maxFileBytes: 100 * MB, spaces: 5 },
  elite: { libraries: null, storageBytes: 20 * GB, maxFileBytes: 250 * MB, spaces: null },
};
