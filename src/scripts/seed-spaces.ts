/**
 * One-time seed: test users plus four spaces around one real account.
 *
 *   npm run seed:spaces -- <yourUserId>
 *
 * Creates test1@breedx.org … test12@breedx.org (password Test@123). You own one
 * space and are a member of three others (admin in one), five members each.
 * It stops without changing anything if the test users already exist.
 */
import bcrypt from 'bcryptjs';
import mongoose, { Types } from 'mongoose';
import env from '../config/env';
import Space from '../models/space.model';
import SpaceMember from '../models/spaceMember.model';
import User from '../models/user.model';
import { MaterialFileType, ScheduleKind, SpaceRole, ISpaceRules } from '../types/space';

const PASSWORD = 'Test@123';
const SCHOOL = 'University of Ilorin';

const PEOPLE = [
  ['Chiamaka', 'Okafor'],
  ['Tunde', 'Adeyemi'],
  ['Aisha', 'Bello'],
  ['Emeka', 'Nwosu'],
  ['Fatima', 'Abdullahi'],
  ['Segun', 'Ogunleye'],
  ['Ngozi', 'Eze'],
  ['Ibrahim', 'Musa'],
  ['Temitope', 'Alabi'],
  ['Kelechi', 'Obi'],
  ['Zainab', 'Yusuf'],
  ['David', 'Akinola'],
] as const;

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000);

type Person = { id: Types.ObjectId; name: string; firstName: string };
type CourseSeed = { title: string; code: string; materials: [string, MaterialFileType][] };

type SpaceSeed = {
  name: string;
  slug: string;
  description: string;
  reason: string;
  privacy: 'public' | 'private';
  rules: ISpaceRules;
  /** Index into the people list; -1 is you. */
  owner: number;
  members: { who: number; role: SpaceRole }[];
  courses: CourseSeed[];
  schedule: { kind: ScheduleKind; title: string; detail: string; by: number; hours: number }[];
  tests: { title: string; days: number }[];
  quiz: { title: string; detail: string; hours: number }[];
};

const SPACES: SpaceSeed[] = [
  {
    name: 'Optometry 300L',
    slug: 'optometry-300l-k3p9',
    description: 'Notes, past questions and updates for 300 Level Optometry and Vision Science.',
    reason: 'A class or course',
    privacy: 'private',
    rules: { membersCanUpload: true, membersCanInvite: false, approveNewMembers: true },
    owner: -1,
    members: [
      { who: 0, role: 'admin' },
      { who: 1, role: 'member' },
      { who: 2, role: 'member' },
      { who: 3, role: 'member' },
    ],
    courses: [
      {
        title: 'Ocular Anatomy',
        code: 'OPT 301',
        materials: [
          ['Ocular Anatomy lecture 1 — the orbit.pdf', 'pdf'],
          ['Extraocular muscles slides.pptx', 'ppt'],
          ['Ocular Anatomy past questions 2024.pdf', 'pdf'],
        ],
      },
      {
        title: 'Visual Optics',
        code: 'OPT 303',
        materials: [
          ['Refraction at spherical surfaces.pdf', 'pdf'],
          ['Schematic eyes summary.docx', 'doc'],
          ['Visual Optics tutorial set 2.pdf', 'pdf'],
        ],
      },
      {
        title: 'Ocular Physiology',
        code: 'OPT 305',
        materials: [
          ['Tear film physiology notes.pdf', 'pdf'],
          ['Aqueous humour dynamics slides.pptx', 'ppt'],
        ],
      },
      {
        title: 'Geometric Optics',
        code: 'PHY 307',
        materials: [['Thin lenses and mirrors.pdf', 'pdf']],
      },
    ],
    schedule: [
      { kind: 'exam', title: 'OPT 301 test moved to Thursday', detail: '10:00 AM, Optometry Lecture Theatre', by: 0, hours: 2 },
      { kind: 'venue', title: 'Visual Optics now holds in LT 3', detail: 'From next Monday', by: 1, hours: 9 },
      { kind: 'deadline', title: 'Ocular Physiology assignment due Friday', detail: 'Submit in class before 12 noon', by: 0, hours: 27 },
    ],
    tests: [{ title: 'OPT 301 test', days: 4 }],
    quiz: [{ title: 'Chiamaka topped the OPT 301 leaderboard', detail: '88% average across 9 quizzes', hours: 5 }],
  },
  {
    name: 'Life Sciences Study Group',
    slug: 'life-sciences-study-group-7m2x',
    description: 'A small group that meets on Tuesdays and Saturdays to work through tough topics together.',
    reason: 'A study group',
    privacy: 'private',
    rules: { membersCanUpload: true, membersCanInvite: true, approveNewMembers: false },
    owner: 4,
    members: [
      { who: -1, role: 'member' },
      { who: 5, role: 'admin' },
      { who: 6, role: 'member' },
      { who: 7, role: 'member' },
    ],
    courses: [
      {
        title: 'Biochemistry',
        code: 'BCH 201',
        materials: [
          ['Enzyme kinetics made simple.pdf', 'pdf'],
          ['Metabolism summary chart.pdf', 'pdf'],
        ],
      },
      {
        title: 'Cell Biology',
        code: 'BIO 203',
        materials: [['Cell signalling lecture slides.pptx', 'ppt']],
      },
    ],
    schedule: [
      { kind: 'timetable', title: 'Saturday session starts at 4 PM', detail: 'Faculty of Life Sciences, Room 12', by: 4, hours: 20 },
      { kind: 'cancelled', title: 'No session this Tuesday', detail: 'We pick up on Saturday', by: 5, hours: 40 },
    ],
    tests: [],
    quiz: [{ title: 'Ibrahim finished the Biochemistry quiz', detail: 'Scored 9 out of 10', hours: 12 }],
  },
  {
    name: 'Vision Research Club',
    slug: 'vision-research-club-q8d1',
    description: 'Students reading and discussing research in eye care, from myopia to low vision.',
    reason: 'A project team',
    privacy: 'public',
    rules: { membersCanUpload: true, membersCanInvite: false, approveNewMembers: false },
    owner: 8,
    members: [
      { who: -1, role: 'admin' },
      { who: 9, role: 'member' },
      { who: 0, role: 'member' },
      { who: 10, role: 'member' },
    ],
    courses: [
      {
        title: 'Research Methods',
        code: 'OPT 391',
        materials: [
          ['Writing a literature review.pdf', 'pdf'],
          ['Myopia control — paper summaries.docx', 'doc'],
        ],
      },
    ],
    schedule: [{ kind: 'deadline', title: 'Abstract drafts due next week', detail: 'Share them in the Research Methods course', by: 8, hours: 30 }],
    tests: [],
    quiz: [],
  },
  {
    name: 'Unilorin Scholars 2026',
    slug: 'unilorin-scholars-2026-b5t7',
    description: 'Scholarship holders sharing resources, deadlines and opportunities.',
    reason: 'Something else',
    privacy: 'private',
    rules: { membersCanUpload: false, membersCanInvite: true, approveNewMembers: false },
    owner: 11,
    members: [
      { who: -1, role: 'member' },
      { who: 2, role: 'member' },
      { who: 6, role: 'admin' },
      { who: 9, role: 'member' },
    ],
    courses: [
      {
        title: 'General Studies',
        code: 'GNS 312',
        materials: [['GNS 312 past questions 2023.pdf', 'pdf']],
      },
    ],
    schedule: [{ kind: 'exam', title: 'GNS 312 exam is on 21 November', detail: '8:00 AM, Main Auditorium', by: 11, hours: 15 }],
    tests: [{ title: 'GNS 312 exam', days: 13 }],
    quiz: [],
  },
];

const run = async () => {
  const youId = process.argv[2];
  if (!youId || !Types.ObjectId.isValid(youId)) throw new Error('Pass your user id: npm run seed:spaces -- <userId>');

  await mongoose.connect(env.MONGODB_URI);

  const you = await User.findById(youId).select('firstName lastName');
  if (!you) throw new Error(`No user with id ${youId}`);
  if (await User.exists({ email: 'test1@breedx.org' })) {
    console.log('Already seeded: test1@breedx.org exists. Nothing changed.');
    return;
  }
  if (await Space.exists({ slug: { $in: SPACES.map((s) => s.slug) } })) {
    console.log('Already seeded: the spaces exist. Nothing changed.');
    return;
  }

  const password = await bcrypt.hash(PASSWORD, 12);
  const users = await User.insertMany(
    PEOPLE.map(([firstName, lastName], index) => ({
      firstName,
      lastName,
      email: `test${index + 1}@breedx.org`,
      country: 'Nigeria',
      password,
      authProvider: 'local',
      isVerified: true,
      onboardingStatus: 'complete',
      academicProfile: { school: SCHOOL, faculty: 'Faculty of Life Sciences', level: '300 Level', programme: 'Undergraduate' },
    }))
  );
  console.log(`Created ${users.length} test users (test1–test${users.length}@breedx.org, password ${PASSWORD})`);

  const youPerson: Person = { id: you._id as Types.ObjectId, name: `${you.firstName} ${you.lastName}`.trim(), firstName: you.firstName };
  const person = (index: number): Person =>
    index === -1
      ? youPerson
      : { id: users[index]._id as Types.ObjectId, name: `${users[index].firstName} ${users[index].lastName}`, firstName: users[index].firstName };

  for (const seed of SPACES) {
    const owner = person(seed.owner);
    const everyone = [seed.owner, ...seed.members.map((m) => m.who)];
    const uploader = (i: number) => person(everyone[i % everyone.length]);

    const space = await Space.create({
      name: seed.name,
      slug: seed.slug,
      school: SCHOOL,
      description: seed.description,
      reason: seed.reason,
      privacy: seed.privacy,
      rules: seed.rules,
      owner: owner.id,
      courses: seed.courses.map((course, c) => ({
        title: course.title,
        code: course.code,
        materials: course.materials.map(([title, fileType], m) => {
          const by = uploader(c + m);
          return { title, fileType, uploadedBy: by.id, uploadedByName: by.name, uploadedAt: hoursAgo(3 + c * 11 + m * 17) };
        }),
      })),
      scheduleUpdates: seed.schedule.map((item) => ({
        kind: item.kind,
        title: item.title,
        detail: item.detail,
        postedBy: person(item.by).firstName,
        at: hoursAgo(item.hours),
      })),
      upcomingTests: seed.tests.map((test) => ({ title: test.title, source: 'Posted by the class rep', date: daysFromNow(test.days) })),
      quizActivity: seed.quiz.map((item) => ({ title: item.title, detail: item.detail, at: hoursAgo(item.hours) })),
    });

    await SpaceMember.insertMany([
      { space: space._id, user: owner.id, role: 'owner', status: 'active', joinedAt: hoursAgo(24 * 40) },
      ...seed.members.map((member, i) => ({
        space: space._id,
        user: person(member.who).id,
        role: member.role,
        status: 'active',
        joinedAt: hoursAgo(24 * (30 - i * 6)),
      })),
    ]);
    console.log(`Created "${seed.name}" (/classes/${seed.slug}) with ${seed.members.length + 1} members`);
  }
};

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
