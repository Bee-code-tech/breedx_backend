import { Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import Space from '../models/space.model';
import ScheduleEntry from '../models/scheduleEntry.model';
import SpaceMember from '../models/spaceMember.model';
import User from '../models/user.model';
import { AuthRequest } from '../types/auth';
import {
  ISpace,
  ISpaceMember,
  MATERIAL_FILE_TYPES,
  MaterialFileType,
  SPACE_PRIVACY,
  SpacePrivacy,
  SpaceRole,
} from '../types/space';
import { planFor } from '../utils/plan';
import { sendError, sendSuccess } from '../utils/response';

const NAME_MAX = 80;
const SCHOOL_MAX = 120;
const DESCRIPTION_MAX = 300;
const REASON_MAX = 60;
const COURSE_TITLE_MAX = 100;
const COURSE_CODE_MAX = 20;
const MATERIAL_TITLE_MAX = 200;
const IMAGE_MAX = 120_000;
const INVITES_MAX = 20;
const UPLOAD_MAX = 20;
const RECENT_LIMIT = 12;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLE_RANK: Record<SpaceRole, number> = { owner: 0, admin: 1, member: 2 };

type MemberUser = { _id: Types.ObjectId; firstName: string; lastName?: string; avatar?: string };
type PopulatedMember = Omit<ISpaceMember, 'user'> & { user?: MemberUser | null };

// ── Helpers ───────────────────────────────────────────────────────────────────

const text = (value: unknown): string => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '');
const isId = (value: unknown): value is string => typeof value === 'string' && Types.ObjectId.isValid(value);
const fullName = (user?: MemberUser | null) => (user ? `${user.firstName} ${user.lastName ?? ''}`.trim() : 'Former member');

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'space';

const randomSuffix = () => Math.random().toString(36).slice(2, 6).padEnd(4, '0');

const isImage = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= IMAGE_MAX && /^data:image\/(png|jpe?g|webp);base64,/.test(value);

const canManage = (role: SpaceRole) => role === 'owner' || role === 'admin';

const activeMembers = (spaceId: Types.ObjectId) =>
  SpaceMember.find({ space: spaceId })
    .populate<{ user: MemberUser | null }>('user', 'firstName lastName avatar')
    .lean<PopulatedMember[]>();

// ── Shapes sent to the frontend ───────────────────────────────────────────────

// The Space shape the space page renders (lib/spaces/space.types.ts)
const toViewerSpace = async (space: ISpace, viewerId: string, viewerRole: SpaceRole) => {
  const [members, owner] = await Promise.all([
    activeMembers(space._id),
    User.findById(space.owner).select('firstName').lean(),
  ]);
  const isViewer = (id?: Types.ObjectId | null) => Boolean(id && String(id) === viewerId);
  const who = (id: Types.ObjectId, name: string) => (isViewer(id) ? 'You' : name);

  const courses = space.courses.map((course) => ({
    id: String(course._id),
    title: course.title,
    code: course.code,
    materials: [...course.materials]
      .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())
      .map((material) => ({
        id: String(material._id),
        title: material.title,
        fileType: material.fileType,
        uploadedBy: who(material.uploadedBy, material.uploadedByName),
        uploadedAt: material.uploadedAt.toISOString(),
      })),
  }));

  const recentlyShared = courses
    .flatMap((course) => course.materials)
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
    .slice(0, RECENT_LIMIT);

  const memberList = members
    .filter((member) => member.status === 'invited' || member.user)
    .sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || b.joinedAt.getTime() - a.joinedAt.getTime())
    .map((member) => ({
      id: String(member._id),
      name: member.status === 'invited' ? (member.email ?? '') : fullName(member.user),
      role: member.role,
      ...(isViewer(member.user?._id) && { isYou: true }),
      ...(member.status === 'invited' && { status: 'invited' as const }),
      ...(member.user?.avatar && { avatarUrl: member.user.avatar }),
      joinedAt: member.joinedAt.toISOString(),
    }));

  return {
    id: String(space._id),
    slug: space.slug,
    name: space.name,
    school: space.school,
    memberCount: members.filter((member) => member.status === 'active').length,
    description: space.description,
    imageUrl: space.imageUrl ?? null,
    privacy: space.privacy,
    viewerRole,
    rules: {
      membersCanUpload: space.rules.membersCanUpload,
      membersCanInvite: space.rules.membersCanInvite,
      approveNewMembers: space.rules.approveNewMembers,
    },
    inviteLink: `breedx.org/j/${space.slug}`,
    createdBy: isViewer(space.owner) ? 'You' : (owner?.firstName ?? 'A student'),
    createdAt: space.createdAt.toISOString(),
    activity: {
      scheduleUpdates: space.scheduleUpdates.map((update) => ({
        id: String(update._id),
        kind: update.kind,
        title: update.title,
        detail: update.detail,
        postedBy: update.postedBy,
        at: update.at.toISOString(),
      })),
      recentlyShared,
      upcomingTests: space.upcomingTests
        .filter((test) => test.date.getTime() > Date.now())
        .map((test) => ({
          id: String(test._id),
          title: test.title,
          source: test.source,
          date: test.date.toISOString(),
        })),
      quizActivity: space.quizActivity.map((item) => ({
        id: String(item._id),
        title: item.title,
        detail: item.detail,
        at: item.at.toISOString(),
      })),
    },
    courses,
    members: memberList,
  };
};

// Loads the space and the viewer's active membership; answers 404 otherwise,
// so a space you're not in looks the same as one that doesn't exist
export const loadSpace = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const space = await Space.findOne({ slug: String(req.params.slug).toLowerCase() });
  const membership = space
    ? await SpaceMember.findOne({ space: space._id, user: userId, status: 'active' })
    : null;
  if (!space || !membership) {
    sendError(res, 'Space not found', 404);
    return null;
  }
  return { space, membership, userId };
};

const respondSpace = async (res: Response, space: ISpace, userId: string, role: SpaceRole, message?: string, status = 200) =>
  sendSuccess(res, await toViewerSpace(space, userId, role), message, status);

const viewerName = async (userId: string) => {
  const user = await User.findById(userId).select('firstName lastName').lean();
  return user ? `${user.firstName} ${user.lastName ?? ''}`.trim() : 'A student';
};

const fileTypeFor = (value: unknown, title: string): MaterialFileType => {
  if (MATERIAL_FILE_TYPES.includes(value as MaterialFileType)) return value as MaterialFileType;
  const extension = title.split('.').pop()?.toLowerCase() ?? '';
  if (['ppt', 'pptx', 'key'].includes(extension)) return 'ppt';
  if (['doc', 'docx', 'txt', 'rtf', 'odt'].includes(extension)) return 'doc';
  return 'pdf';
};

// ── Spaces ────────────────────────────────────────────────────────────────────

// GET /api/v1/spaces: the spaces you're in, for the sidebar
export const listSpaces = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const memberships = await SpaceMember.find({ user: req.user!.id, status: 'active' }).sort({ joinedAt: 1 }).lean();
    const spaces = await Space.find({ _id: { $in: memberships.map((m) => m.space) } })
      .select('name slug imageUrl')
      .lean();
    const counts = await SpaceMember.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { space: { $in: spaces.map((s) => s._id) }, status: 'active' } },
      { $group: { _id: '$space', count: { $sum: 1 } } },
    ]);
    const countOf = new Map(counts.map((c) => [String(c._id), c.count]));
    const byId = new Map(spaces.map((s) => [String(s._id), s]));

    sendSuccess(
      res,
      memberships.flatMap((membership) => {
        const space = byId.get(String(membership.space));
        if (!space) return [];
        return [
          {
            id: String(space._id),
            slug: space.slug,
            name: space.name,
            imageUrl: space.imageUrl ?? null,
            role: membership.role,
            memberCount: countOf.get(String(space._id)) ?? 0,
          },
        ];
      })
    );
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/spaces
export const createSpace = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const name = text(req.body?.name);
    const school = text(req.body?.school);
    const reason = text(req.body?.reason);
    const privacy = text(req.body?.privacy) as SpacePrivacy;

    if (!name || name.length > NAME_MAX) return sendError(res, `Give your space a name up to ${NAME_MAX} characters`, 400);
    if (!school || school.length > SCHOOL_MAX) return sendError(res, 'Enter your school', 400);
    if (reason.length > REASON_MAX) return sendError(res, 'That reason is too long', 400);
    if (!SPACE_PRIVACY.includes(privacy)) return sendError(res, 'Choose who can join', 400);

    const { limits } = await planFor(userId);
    if (limits.spaces !== null) {
      const owned = await Space.countDocuments({ owner: userId });
      if (owned >= limits.spaces) {
        return sendError(
          res,
          `Your plan includes ${limits.spaces} space${limits.spaces === 1 ? '' : 's'}. Upgrade to create more.`,
          403,
          { code: 'PLAN_LIMIT', limit: 'spaces' }
        );
      }
    }

    let space: ISpace | null = null;
    // A clash on the random suffix is rare; try a few times
    for (let attempt = 0; attempt < 5 && !space; attempt++) {
      try {
        space = await Space.create({
          name,
          school,
          reason: reason || undefined,
          privacy,
          slug: `${slugify(name)}-${randomSuffix()}`,
          owner: userId,
          description: '',
        });
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
      }
    }
    if (!space) return sendError(res, "We couldn't create that space. Try again", 500);

    await SpaceMember.create({ space: space._id, user: userId, role: 'owner', status: 'active' });
    await respondSpace(res, space, userId, 'owner', 'Space created', 201);
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/spaces/:slug
export const getSpace = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    await respondSpace(res, found.space, found.userId, found.membership.role);
  } catch (error) {
    next(error);
  }
};

// PATCH /api/v1/spaces/:slug: settings (owner), photo (owner or admin)
export const updateSpace = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const { space, membership, userId } = found;
    const body = req.body ?? {};
    const settingsKeys = ['name', 'school', 'description', 'privacy', 'rules'].filter((key) => key in body);

    if (settingsKeys.length && membership.role !== 'owner') return sendError(res, 'Only the owner can change settings', 403);
    if ('imageUrl' in body && !canManage(membership.role)) return sendError(res, 'Only the owner and admins can change the photo', 403);

    if ('name' in body) {
      const name = text(body.name);
      if (!name || name.length > NAME_MAX) return sendError(res, `Give your space a name up to ${NAME_MAX} characters`, 400);
      space.name = name;
    }
    if ('school' in body) {
      const school = text(body.school);
      if (!school || school.length > SCHOOL_MAX) return sendError(res, 'Enter your school', 400);
      space.school = school;
    }
    if ('description' in body) {
      const description = typeof body.description === 'string' ? body.description.trim() : '';
      if (description.length > DESCRIPTION_MAX) return sendError(res, `Keep the description under ${DESCRIPTION_MAX} characters`, 400);
      space.description = description;
    }
    if ('privacy' in body) {
      if (!SPACE_PRIVACY.includes(body.privacy)) return sendError(res, 'Choose who can join', 400);
      space.privacy = body.privacy;
    }
    if ('rules' in body && body.rules && typeof body.rules === 'object') {
      for (const key of ['membersCanUpload', 'membersCanInvite', 'approveNewMembers'] as const) {
        if (typeof body.rules[key] === 'boolean') space.rules[key] = body.rules[key];
      }
    }
    if ('imageUrl' in body) {
      if (body.imageUrl !== null && !isImage(body.imageUrl)) return sendError(res, 'Use a JPG, PNG or WebP photo', 400);
      space.imageUrl = body.imageUrl;
    }

    await space.save();
    await respondSpace(res, space, userId, membership.role, 'Space updated');
  } catch (error) {
    next(error);
  }
};

// DELETE /api/v1/spaces/:slug
export const deleteSpace = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    if (found.membership.role !== 'owner') return sendError(res, 'Only the owner can delete this space', 403);
    await Promise.all([
      SpaceMember.deleteMany({ space: found.space._id }),
      ScheduleEntry.deleteMany({ space: found.space._id }),
      found.space.deleteOne(),
    ]);
    sendSuccess(res, null, 'Space deleted');
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/spaces/:slug/leave
export const leaveSpace = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    if (found.membership.role === 'owner') return sendError(res, 'Owners delete the space instead of leaving it', 400);
    await Promise.all([
      found.membership.deleteOne(),
      // Their private study timetable goes with them
      ScheduleEntry.deleteMany({ space: found.space._id, kind: 'study', owner: found.userId }),
    ]);
    sendSuccess(res, null, 'You left the space');
  } catch (error) {
    next(error);
  }
};

// ── Joining ───────────────────────────────────────────────────────────────────

// GET /api/v1/spaces/invite/:code: what you see before joining
export const previewInvite = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const space = await Space.findOne({ slug: String(req.params.code).toLowerCase() });
    if (!space) return sendError(res, 'No space matches that link', 404);
    const [members, owner, mine] = await Promise.all([
      activeMembers(space._id),
      User.findById(space.owner).select('firstName').lean(),
      SpaceMember.exists({ space: space._id, user: req.user!.id, status: 'active' }),
    ]);
    const active = members
      .filter((member) => member.status === 'active' && member.user)
      .sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role]);

    sendSuccess(res, {
      slug: space.slug,
      name: space.name,
      school: space.school,
      memberCount: active.length,
      createdBy: String(space.owner) === req.user!.id ? 'You' : (owner?.firstName ?? 'A student'),
      createdAt: space.createdAt.toISOString(),
      isMember: Boolean(mine),
      members: active.slice(0, 3).map((member) => ({
        id: String(member._id),
        name: fullName(member.user),
        role: member.role,
        ...(member.user?.avatar && { avatarUrl: member.user.avatar }),
        joinedAt: member.joinedAt.toISOString(),
      })),
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/spaces/invite/:code/join
export const joinSpace = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.id;
    const space = await Space.findOne({ slug: String(req.params.code).toLowerCase() });
    if (!space) return sendError(res, 'No space matches that link', 404);

    const existing = await SpaceMember.findOne({ space: space._id, user: userId });
    if (existing?.status === 'active') return respondSpace(res, space, userId, existing.role, "You're already in this space");

    const user = await User.findById(userId).select('email').lean();
    // An email invite becomes the membership; otherwise add a new one
    const invite = user && (await SpaceMember.findOne({ space: space._id, email: user.email, status: 'invited' }));
    let membership: ISpaceMember;
    if (invite) {
      invite.user = new Types.ObjectId(userId);
      invite.email = undefined;
      invite.status = 'active';
      invite.joinedAt = new Date();
      membership = await invite.save();
    } else {
      membership = await SpaceMember.create({ space: space._id, user: userId, role: 'member', status: 'active' });
    }
    await respondSpace(res, space, userId, membership.role, `You joined ${space.name}`, 201);
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return sendError(res, "You're already in this space", 409);
    next(error);
  }
};

// ── Members ───────────────────────────────────────────────────────────────────

// POST /api/v1/spaces/:slug/invites { emails }
export const inviteMembers = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const { space, membership, userId } = found;
    if (!canManage(membership.role) && !space.rules.membersCanInvite) {
      return sendError(res, 'Only the owner and admins can invite people', 403);
    }

    const emails: string[] = Array.isArray(req.body?.emails)
      ? [...new Set<string>(req.body.emails.map((e: unknown) => text(e).toLowerCase()))]
      : [];
    if (!emails.length || emails.length > INVITES_MAX) return sendError(res, `Add between 1 and ${INVITES_MAX} emails`, 400);
    if (emails.some((email) => !EMAIL_REGEX.test(email))) return sendError(res, 'One of those emails is not valid', 400);

    // Skip people who are already in the space
    const users = await User.find({ email: { $in: emails } }).select('email').lean();
    const joined = await SpaceMember.find({ space: space._id, user: { $in: users.map((u) => u._id) }, status: 'active' }).lean();
    const joinedEmails = new Set(
      users.filter((u) => joined.some((m) => String(m.user) === String(u._id))).map((u) => u.email)
    );

    await Promise.all(
      emails
        .filter((email) => !joinedEmails.has(email))
        .map((email) =>
          SpaceMember.updateOne(
            { space: space._id, email },
            { $setOnInsert: { space: space._id, email, role: 'member', status: 'invited', joinedAt: new Date() } },
            { upsert: true }
          )
        )
    );
    await respondSpace(res, space, userId, membership.role, 'Invites saved');
  } catch (error) {
    next(error);
  }
};

// PATCH /api/v1/spaces/:slug/members/:memberId { role }
export const setMemberRole = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const { space, membership, userId } = found;
    if (membership.role !== 'owner') return sendError(res, 'Only the owner can change roles', 403);
    const role = req.body?.role;
    if (role !== 'admin' && role !== 'member') return sendError(res, 'Choose admin or member', 400);
    if (!isId(req.params.memberId)) return sendError(res, 'Member not found', 404);

    const target = await SpaceMember.findOne({ _id: req.params.memberId, space: space._id, status: 'active' });
    if (!target || target.role === 'owner') return sendError(res, 'Member not found', 404);
    target.role = role;
    await target.save();
    await respondSpace(res, space, userId, membership.role, 'Role updated');
  } catch (error) {
    next(error);
  }
};

// DELETE /api/v1/spaces/:slug/members/:memberId: remove someone or cancel an invite
export const removeMember = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const { space, membership, userId } = found;
    if (!canManage(membership.role)) return sendError(res, 'Only the owner and admins can remove people', 403);
    if (!isId(req.params.memberId)) return sendError(res, 'Member not found', 404);

    const target = await SpaceMember.findOne({ _id: req.params.memberId, space: space._id });
    if (!target || target.role === 'owner' || String(target._id) === String(membership._id)) {
      return sendError(res, 'Member not found', 404);
    }
    // Admins can only remove plain members
    if (membership.role === 'admin' && target.role === 'admin') return sendError(res, 'Only the owner can remove an admin', 403);
    await Promise.all([
      target.deleteOne(),
      target.user ? ScheduleEntry.deleteMany({ space: space._id, kind: 'study', owner: target.user }) : null,
    ]);
    await respondSpace(res, space, userId, membership.role, 'Member removed');
  } catch (error) {
    next(error);
  }
};

// ── Courses and materials ─────────────────────────────────────────────────────

const courseValues = (body: Record<string, unknown>) => {
  const title = text(body.title);
  const code = text(body.code).toUpperCase();
  if (!title || title.length > COURSE_TITLE_MAX) return { error: 'Give the course a title' };
  if (code.length > COURSE_CODE_MAX) return { error: 'That course code is too long' };
  return { title, code };
};

// POST /api/v1/spaces/:slug/courses
export const createCourse = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const { space, membership, userId } = found;
    if (!canManage(membership.role)) return sendError(res, 'Only the owner and admins can add courses', 403);
    const values = courseValues(req.body ?? {});
    if ('error' in values) return sendError(res, values.error!, 400);
    space.courses.unshift({ title: values.title, code: values.code, materials: [] });
    await space.save();
    await respondSpace(res, space, userId, membership.role, 'Course added', 201);
  } catch (error) {
    next(error);
  }
};

// PATCH /api/v1/spaces/:slug/courses/:courseId
export const updateCourse = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const { space, membership, userId } = found;
    if (!canManage(membership.role)) return sendError(res, 'Only the owner and admins can edit courses', 403);
    const course = isId(req.params.courseId) ? space.courses.id(req.params.courseId) : null;
    if (!course) return sendError(res, 'Course not found', 404);
    const values = courseValues(req.body ?? {});
    if ('error' in values) return sendError(res, values.error!, 400);
    course.title = values.title;
    course.code = values.code;
    await space.save();
    await respondSpace(res, space, userId, membership.role, 'Course updated');
  } catch (error) {
    next(error);
  }
};

// DELETE /api/v1/spaces/:slug/courses/:courseId
export const deleteCourse = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const { space, membership, userId } = found;
    if (!canManage(membership.role)) return sendError(res, 'Only the owner and admins can delete courses', 403);
    const course = isId(req.params.courseId) ? space.courses.id(req.params.courseId) : null;
    if (!course) return sendError(res, 'Course not found', 404);
    // Its timetable entries go with it
    await ScheduleEntry.deleteMany({ space: space._id, course: course._id });
    course.deleteOne();
    await space.save();
    await respondSpace(res, space, userId, membership.role, 'Course deleted');
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/spaces/:slug/materials { courseIds, files: [{ title, fileType }] }
export const addMaterials = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const { space, membership, userId } = found;
    if (!canManage(membership.role) && !space.rules.membersCanUpload) {
      return sendError(res, 'Only the owner and admins can add materials here', 403);
    }

    const courseIds: unknown[] = Array.isArray(req.body?.courseIds) ? req.body.courseIds : [];
    const files: unknown[] = Array.isArray(req.body?.files) ? req.body.files : [];
    const courses = courseIds.filter(isId).map((id) => space.courses.id(id)).filter((c) => c !== null);
    if (!courses.length) return sendError(res, 'Choose at least one course', 400);
    if (!files.length || files.length > UPLOAD_MAX) return sendError(res, `Add between 1 and ${UPLOAD_MAX} files`, 400);

    const parsed = files.map((file) => {
      const raw = (file ?? {}) as Record<string, unknown>;
      const title = text(raw.title);
      return { title, fileType: fileTypeFor(raw.fileType, title) };
    });
    if (parsed.some((file) => !file.title || file.title.length > MATERIAL_TITLE_MAX)) {
      return sendError(res, 'Each file needs a name', 400);
    }

    const name = await viewerName(userId);
    const now = new Date();
    for (const course of courses) {
      for (const file of parsed) {
        course.materials.push({ ...file, uploadedBy: new Types.ObjectId(userId), uploadedByName: name, uploadedAt: now });
      }
    }
    await space.save();
    await respondSpace(res, space, userId, membership.role, 'Materials added', 201);
  } catch (error) {
    next(error);
  }
};

const findMaterial = (space: ISpace, materialId: string) => {
  for (const course of space.courses) {
    const material = course.materials.id(materialId);
    if (material) return material;
  }
  return null;
};

// PATCH /api/v1/spaces/:slug/materials/:materialId { title }
export const renameMaterial = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const { space, membership, userId } = found;
    const material = isId(req.params.materialId) ? findMaterial(space, req.params.materialId) : null;
    if (!material) return sendError(res, 'Material not found', 404);
    if (!canManage(membership.role) && String(material.uploadedBy) !== userId) {
      return sendError(res, 'You can only rename materials you added', 403);
    }
    const title = text(req.body?.title);
    if (!title || title.length > MATERIAL_TITLE_MAX) return sendError(res, 'Give the material a name', 400);
    material.title = title;
    await space.save();
    await respondSpace(res, space, userId, membership.role, 'Material renamed');
  } catch (error) {
    next(error);
  }
};

// DELETE /api/v1/spaces/:slug/materials/:materialId
export const removeMaterial = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const found = await loadSpace(req, res);
    if (!found) return;
    const { space, membership, userId } = found;
    const material = isId(req.params.materialId) ? findMaterial(space, req.params.materialId) : null;
    if (!material) return sendError(res, 'Material not found', 404);
    if (!canManage(membership.role) && String(material.uploadedBy) !== userId) {
      return sendError(res, 'You can only remove materials you added', 403);
    }
    material.deleteOne();
    await space.save();
    await respondSpace(res, space, userId, membership.role, 'Material removed');
  } catch (error) {
    next(error);
  }
};
