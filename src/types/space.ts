import { Document, Types } from 'mongoose';

export const SPACE_ROLES = ['owner', 'admin', 'member'] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];

export const SPACE_PRIVACY = ['public', 'private'] as const;
export type SpacePrivacy = (typeof SPACE_PRIVACY)[number];

export const MATERIAL_FILE_TYPES = ['pdf', 'doc', 'ppt'] as const;
export type MaterialFileType = (typeof MATERIAL_FILE_TYPES)[number];

export const SCHEDULE_KINDS = ['timetable', 'test', 'exam', 'venue', 'deadline', 'cancelled', 'event'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export interface ISpaceRules {
  membersCanUpload: boolean;
  membersCanInvite: boolean;
  approveNewMembers: boolean;
}

export interface ISpaceMaterial {
  _id: Types.ObjectId;
  title: string;
  fileType: MaterialFileType;
  uploadedBy: Types.ObjectId;
  /** Kept so the name still shows after the uploader leaves. */
  uploadedByName: string;
  uploadedAt: Date;
}

export interface ISpaceCourse {
  _id: Types.ObjectId;
  title: string;
  code: string;
  materials: Types.DocumentArray<ISpaceMaterial & Document>;
}

export interface IScheduleUpdate {
  _id: Types.ObjectId;
  kind: ScheduleKind;
  title: string;
  detail: string;
  postedBy: string;
  at: Date;
}

export interface IUpcomingTest {
  _id: Types.ObjectId;
  title: string;
  source: string;
  date: Date;
}

export interface IQuizActivity {
  _id: Types.ObjectId;
  title: string;
  detail: string;
  at: Date;
}

export interface ISpace extends Document {
  _id: Types.ObjectId;
  name: string;
  /** Used in the page URL and the invite link. */
  slug: string;
  school: string;
  description: string;
  reason?: string;
  imageUrl?: string | null;
  privacy: SpacePrivacy;
  rules: ISpaceRules;
  owner: Types.ObjectId;
  /** IANA zone the timetable's times are in, e.g. Africa/Lagos. */
  timezone: string;
  courses: Types.DocumentArray<ISpaceCourse & Document>;
  scheduleUpdates: Types.DocumentArray<IScheduleUpdate & Document>;
  upcomingTests: Types.DocumentArray<IUpcomingTest & Document>;
  quizActivity: Types.DocumentArray<IQuizActivity & Document>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ISpaceMember extends Document {
  _id: Types.ObjectId;
  space: Types.ObjectId;
  /** Set once someone has joined. */
  user?: Types.ObjectId;
  /** Set for email invites that haven't been accepted yet. */
  email?: string;
  role: SpaceRole;
  status: 'active' | 'invited';
  /**
   * Home schedule choice: true for the space shown on Home (one per person),
   * false when they turned it off. Unset means they haven't chosen.
   */
  onHome?: boolean;
  /**
   * Per schedule kind: whether it shows on Home and whether reminders come.
   * Anything unset counts as on.
   */
  schedulePrefs?: Partial<Record<ScheduleEntryKind, { home?: boolean; remind?: boolean }>>;
  joinedAt: Date;
}

// Classes and study repeat weekly; tests and exams are dated. All belong to a
// course. Study is one member's own reading timetable: nobody else sees it
export const SCHEDULE_ENTRY_KINDS = ['class', 'test', 'exam', 'study'] as const;
export const WEEKLY_KINDS = ['class', 'study'] as const;
export type ScheduleEntryKind = (typeof SCHEDULE_ENTRY_KINDS)[number];

export interface IScheduleEntry extends Document {
  _id: Types.ObjectId;
  space: Types.ObjectId;
  kind: ScheduleEntryKind;
  /** Classes and study repeat weekly: 1 is Monday … 7 is Sunday. */
  day?: number;
  /** Tests and exams happen once, as YYYY-MM-DD. */
  date?: string;
  /** The space course it belongs to; its code and name are shown. */
  course?: Types.ObjectId;
  /** 24-hour HH:mm in the space's timezone. */
  startTime: string;
  endTime: string;
  courseCode: string;
  /** The course name. */
  title: string;
  venue: string;
  note: string;
  createdBy: Types.ObjectId;
  /** Study entries only: the member whose reading timetable this is. */
  owner?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}
