import { Types } from 'mongoose';
import SpaceMember from '../models/spaceMember.model';
import User from '../models/user.model';
import { notify, NotificationInput } from './notify';

type SpaceLike = { _id: Types.ObjectId | string; name: string; slug: string; imageUrl?: string | null };

/**
 * Tells everyone in a space what just happened there, as a bell item and a
 * push (each student's switches and quiet hours still apply). The person who
 * did it isn't told. `title` gets their first name, e.g. "Ada added CSC 301".
 * Never throws.
 */
export const notifySpace = async (
  space: SpaceLike,
  actorId: string | null,
  input: {
    kind: string;
    title: (who: string) => string;
    body?: string;
    /** The tab to open, e.g. "courses" or "past questions". */
    tab?: string;
    /** Sent even in quiet hours, e.g. an important announcement. */
    urgent?: boolean;
    /** Same key within a day joins into one item, e.g. several uploads. */
    group?: { key: string; title: (count: number, who: string) => string; body?: (count: number) => string };
  },
  /** Also leave these people out, e.g. someone who was just removed. */
  exclude: (string | Types.ObjectId)[] = []
): Promise<void> => {
  try {
    const skip = [actorId, ...exclude].filter(Boolean).map((id) => new Types.ObjectId(String(id)));
    const [members, actor] = await Promise.all([
      SpaceMember.find({ space: space._id, status: 'active', user: { $nin: skip } })
        .select('user')
        .lean(),
      actorId ? User.findById(actorId).select('firstName').lean() : null,
    ]);
    const recipients = members.map((member) => member.user).filter(Boolean) as Types.ObjectId[];
    if (!recipients.length) return;
    const who = actor?.firstName ?? 'Someone';
    const notification: NotificationInput = {
      category: 'spaces',
      kind: input.kind,
      title: input.title(who),
      body: input.body ?? space.name,
      link: `/classes/${space.slug}${input.tab ? `?tab=${encodeURIComponent(input.tab)}` : ''}`,
      image: space.imageUrl ?? null,
      ...(input.group && {
        group: {
          key: input.group.key,
          title: (count: number) => input.group!.title(count, who),
          body: input.group.body,
        },
      }),
    };
    await notify(recipients, notification, { push: true, urgent: input.urgent });
  } catch (error) {
    console.error('Space notification failed:', error);
  }
};
