/**
 * One-time seed: a schedule in every category for the spaces you're in.
 *
 *   npm run seed:schedule -- <yourUserId>
 *
 * For each of your spaces that has courses and no schedule yet: a weekly class
 * timetable, two tests and two exams (dated from today), and your own study
 * plan. Spaces that already have a schedule are left alone, so it's safe to
 * run again.
 */
import mongoose, { Types } from 'mongoose';
import env from '../config/env';
import ScheduleEntry from '../models/scheduleEntry.model';
import Space from '../models/space.model';
import SpaceMember from '../models/spaceMember.model';

const VENUES = ['LT I', 'LT II', 'LT III', 'ELH II', 'Main Auditorium', 'Faculty Hall'];

// YYYY-MM-DD, `days` from today in Lagos
const dateIn = (days: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date(Date.now() + days * 86_400_000));

const run = async () => {
  const youId = process.argv[2];
  if (!youId || !Types.ObjectId.isValid(youId)) throw new Error('Pass your user id: npm run seed:schedule -- <userId>');
  await mongoose.connect(env.MONGODB_URI);

  const memberships = await SpaceMember.find({ user: youId, status: 'active' }).lean();
  const spaces = await Space.find({ _id: { $in: memberships.map((m) => m.space) } });
  if (!spaces.length) console.log('You are not in any space yet. Nothing changed.');

  for (const space of spaces) {
    const courses = space.courses;
    if (!courses.length) {
      console.log(`Skipped "${space.name}": it has no courses`);
      continue;
    }
    if (await ScheduleEntry.exists({ space: space._id })) {
      console.log(`Skipped "${space.name}": it already has a schedule`);
      continue;
    }
    const course = (i: number) => courses[i % courses.length];
    const base = (i: number) => ({
      space: space._id,
      course: course(i)._id,
      courseCode: course(i).code,
      title: course(i).title,
      createdBy: space.owner,
      note: '',
    });

    // Weekdays: two or three classes a day, morning to early afternoon
    const classes = [
      { day: 1, startTime: '08:00', endTime: '10:00' },
      { day: 1, startTime: '10:00', endTime: '12:00' },
      { day: 2, startTime: '09:00', endTime: '11:00' },
      { day: 2, startTime: '12:00', endTime: '14:00' },
      { day: 3, startTime: '08:00', endTime: '10:00' },
      { day: 3, startTime: '14:00', endTime: '16:00' },
      { day: 4, startTime: '10:00', endTime: '12:00' },
      { day: 5, startTime: '09:00', endTime: '10:30' },
      { day: 5, startTime: '11:00', endTime: '13:00' },
    ].map((slot, i) => ({ ...base(i), ...slot, kind: 'class', venue: VENUES[i % VENUES.length] }));

    const tests = [
      { date: dateIn(3), startTime: '10:00', endTime: '11:00', note: 'Chapters 1–4' },
      { date: dateIn(9), startTime: '14:00', endTime: '15:00', note: 'Bring a calculator' },
    ].map((slot, i) => ({ ...base(i), ...slot, kind: 'test', venue: VENUES[(i + 1) % VENUES.length] }));

    const exams = [
      { date: dateIn(18), startTime: '09:00', endTime: '12:00' },
      { date: dateIn(21), startTime: '13:00', endTime: '16:00' },
    ].map((slot, i) => ({ ...base(i + 1), ...slot, kind: 'exam', venue: 'Main Auditorium', note: 'Bring your ID card' }));

    // Your own evening reading plan
    const study = [
      { day: 1, startTime: '18:00', endTime: '19:00' },
      { day: 2, startTime: '18:00', endTime: '19:30' },
      { day: 4, startTime: '19:00', endTime: '20:00' },
      { day: 6, startTime: '10:00', endTime: '12:00' },
    ].map((slot, i) => ({
      ...base(i),
      ...slot,
      kind: 'study',
      venue: '',
      owner: new Types.ObjectId(youId),
      createdBy: new Types.ObjectId(youId),
    }));

    await ScheduleEntry.insertMany([...classes, ...tests, ...exams, ...study]);
    console.log(
      `Seeded "${space.name}": ${classes.length} classes, ${tests.length} tests, ${exams.length} exams, ${study.length} study sessions`
    );
  }
};

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
