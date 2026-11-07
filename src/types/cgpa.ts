import { Document, Types } from 'mongoose';

export const CGPA_LEVELS = ['100L', '200L', '300L', '400L', '500L', '600L'] as const;
export const CGPA_SCALES = ['4.0', '5.0'] as const;
export const SEMESTERS = ['first', 'second'] as const;

export type CgpaLevelName = (typeof CGPA_LEVELS)[number];
export type CgpaScale = (typeof CGPA_SCALES)[number];
export type SemesterName = (typeof SEMESTERS)[number];

// Credits and grade stay as typed, so a half-filled row survives a save.
export interface CgpaCourse {
  id: string;
  code: string;
  title: string;
  credits: string;
  grade: string;
}

export interface CgpaLevel {
  id: string;
  level: CgpaLevelName;
  session: string;
  semesters: Record<SemesterName, CgpaCourse[]>;
}

// One document per student: their whole academic record and grading scale.
export interface ICgpaRecord extends Document<Types.ObjectId> {
  user: Types.ObjectId;
  scale: CgpaScale;
  levels: CgpaLevel[];
  createdAt: Date;
  updatedAt: Date;
}
