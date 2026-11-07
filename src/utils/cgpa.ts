import {
  CGPA_LEVELS,
  CgpaCourse,
  CgpaLevel,
  CgpaScale,
  SEMESTERS,
  SemesterName,
} from '../types/cgpa';

const MAX_LEVELS = CGPA_LEVELS.length;
const MAX_COURSES = 40;
const MAX_CREDITS = 30;
const MAX_TEXT = 120;
const MAX_SHORT = 32;
const MAX_ID = 64;

export const GRADE_POINTS: Record<CgpaScale, Record<string, number>> = {
  '5.0': { A: 5, B: 4, C: 3, D: 2, E: 1, F: 0 },
  '4.0': { A: 4, B: 3, C: 2, D: 1, F: 0 },
};

const isString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;

// Checks and trims a record sent by the app. Returns an error message when
// something is out of shape, so the controller can answer 400 with it.
export function parseLevels(
  input: unknown,
  scale: CgpaScale
): { levels: CgpaLevel[] } | { error: string } {
  if (!Array.isArray(input) || input.length > MAX_LEVELS) {
    return { error: `Send up to ${MAX_LEVELS} levels` };
  }

  const grades = GRADE_POINTS[scale];
  const seen = new Set<string>();
  const levels: CgpaLevel[] = [];

  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return { error: 'Each level must be an object' };
    const { id, level, session, semesters } = raw as Record<string, unknown>;

    if (!isString(id, MAX_ID) || id.trim() === '') return { error: 'Each level needs an id' };
    if (!CGPA_LEVELS.includes(level as CgpaLevel['level'])) {
      return { error: `Level must be one of ${CGPA_LEVELS.join(', ')}` };
    }
    if (seen.has(level as string)) return { error: `${level} appears more than once` };
    seen.add(level as string);
    if (session !== undefined && !isString(session, MAX_SHORT)) {
      return { error: 'Session is too long' };
    }

    const parsed = {} as Record<SemesterName, CgpaCourse[]>;
    for (const name of SEMESTERS) {
      const courses = (semesters as Record<string, unknown> | undefined)?.[name] ?? [];
      if (!Array.isArray(courses) || courses.length > MAX_COURSES) {
        return { error: `Send up to ${MAX_COURSES} courses per semester` };
      }
      parsed[name] = [];
      for (const course of courses) {
        const c = (course ?? {}) as Record<string, unknown>;
        const credits = c.credits ?? '';
        const grade = c.grade ?? '';
        if (
          !isString(c.id, MAX_ID) ||
          !isString(c.code ?? '', MAX_SHORT) ||
          !isString(c.title ?? '', MAX_TEXT) ||
          !isString(credits, 4) ||
          !isString(grade, 1)
        ) {
          return { error: 'A course has a missing or invalid field' };
        }
        const units = Number(credits);
        if (credits !== '' && (!Number.isInteger(units) || units < 0 || units > MAX_CREDITS)) {
          return { error: `Credit units must be whole numbers from 0 to ${MAX_CREDITS}` };
        }
        if (grade !== '' && grades[grade] === undefined) {
          return { error: `${grade} is not a grade on the ${scale} scale` };
        }
        parsed[name].push({
          id: c.id,
          code: (c.code as string | undefined ?? '').trim(),
          title: (c.title as string | undefined ?? '').trim(),
          credits,
          grade,
        });
      }
    }

    levels.push({
      id: id.trim(),
      level: level as CgpaLevel['level'],
      session: ((session as string | undefined) ?? '').trim(),
      semesters: parsed,
    });
  }

  return { levels };
}

// Grades the 4.0 scale has no point for, so a switch to it can be refused.
export function gradesOutsideScale(levels: CgpaLevel[], scale: CgpaScale): number {
  const grades = GRADE_POINTS[scale];
  return levels.reduce(
    (count, level) =>
      count +
      SEMESTERS.reduce(
        (sum, name) =>
          sum +
          level.semesters[name].filter(
            (course) => course.grade !== '' && grades[course.grade] === undefined
          ).length,
        0
      ),
    0
  );
}

function tally(courses: CgpaCourse[], points: Record<string, number>) {
  let quality = 0;
  let credits = 0;
  let counted = 0;
  for (const course of courses) {
    const units = Number(course.credits);
    const point = points[course.grade];
    // Rows without credits or a grade are drafts and don't count yet.
    if (course.credits === '' || !Number.isFinite(units) || units <= 0 || point === undefined) {
      continue;
    }
    quality += point * units;
    credits += units;
    counted += 1;
  }
  return { quality, credits, counted, gpa: credits > 0 ? quality / credits : 0 };
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * GPA for each semester and the CGPA after it, in level order. CGPA is total
 * quality points over total credit units across every graded semester so far.
 */
export function summarize(levels: CgpaLevel[], scale: CgpaScale) {
  const points = GRADE_POINTS[scale];
  const ordered = [...levels].sort(
    (a, b) => CGPA_LEVELS.indexOf(a.level) - CGPA_LEVELS.indexOf(b.level)
  );

  let quality = 0;
  let credits = 0;
  let current: { level: string; which: SemesterName; session: string } | null = null;
  const semesters: {
    levelId: string;
    level: string;
    which: SemesterName;
    session: string;
    courses: number;
    credits: number;
    gpa: number;
    cgpa: number;
  }[] = [];

  for (const level of ordered) {
    for (const which of SEMESTERS) {
      const result = tally(level.semesters[which], points);
      if (result.credits <= 0) continue;
      quality += result.quality;
      credits += result.credits;
      current = { level: level.level, which, session: level.session };
      semesters.push({
        levelId: level.id,
        level: level.level,
        which,
        session: level.session,
        courses: result.counted,
        credits: result.credits,
        gpa: round(result.gpa),
        cgpa: round(quality / credits),
      });
    }
  }

  return {
    cgpa: credits > 0 ? round(quality / credits) : 0,
    credits,
    periods: semesters.length,
    current,
    semesters,
  };
}
