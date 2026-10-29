import { Types } from 'mongoose';
import { Notification } from '../models/Notification';
import { User } from '../models/User';
import { ApiError } from '../middleware/error';
import { logger } from '../utils/logger';

export type NotificationType = 'info' | 'reward' | 'task' | 'referral' | 'finance' | 'system';

export interface NotifyOpts {
  userId: Types.ObjectId | string;
  title: string;
  body: string;
  type?: NotificationType;
  data?: Record<string, unknown>;
}

/**
 * Fire-and-forget per-user notification. Never throws — a failed
 * notification must not break the main action that triggered it.
 */
export async function notify(opts: NotifyOpts): Promise<void> {
  try {
    await Notification.create({
      user: opts.userId,
      title: opts.title,
      body: opts.body,
      type: opts.type ?? 'info',
      data: opts.data,
    });
  } catch (err) {
    logger.error(`notify failed: ${err}`);
  }
}

export interface BroadcastOpts {
  title: string;
  body: string;
  type?: NotificationType;
  /** blank/undefined = all active users; else user email or _id */
  target?: string;
  sentBy?: string;
}

/**
 * Admin broadcast: fan-out to every target user + one ledger doc
 * (no `user` field → never appears in user-facing lists) so the admin
 * history has a single row per send.
 */
export async function broadcast(opts: BroadcastOpts): Promise<{ recipients: number }> {
  const title = opts.title.trim();
  const body = opts.body.trim();
  const type = opts.type ?? 'info';
  const target = opts.target?.trim();

  let userIds: Types.ObjectId[];
  let targetLabel: string;

  if (target) {
    const byId = Types.ObjectId.isValid(target)
      ? await User.findById(target).select('_id').lean()
      : null;
    const user = byId ?? (await User.findOne({ email: target }).select('_id').lean());
    if (!user) throw new ApiError(404, 'Target user not found (email or id)');
    userIds = [user._id as Types.ObjectId];
    targetLabel = target;
  } else {
    const users = await User.find({ status: { $ne: 'deleted' } }).select('_id').lean();
    userIds = users.map((u) => u._id as Types.ObjectId);
    targetLabel = 'all';
  }

  const docs = userIds.map((id) => ({ user: id, title, body, type, data: { broadcast: true } }));
  for (let i = 0; i < docs.length; i += 500) {
    await Notification.insertMany(docs.slice(i, i + 500), { ordered: false });
  }

  await Notification.create({
    title,
    body,
    type,
    read: true,
    data: { broadcast: true, target: targetLabel, recipients: userIds.length, sentBy: opts.sentBy },
  });

  return { recipients: userIds.length };
}
