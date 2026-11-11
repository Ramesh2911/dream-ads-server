/**
 * One-time backfill: compute each user's total descendant count (teamCount).
 * Safe to re-run — absolute overwrite with freshly computed subtree sizes.
 *
 * Usage: npx tsx src/scripts/backfillTeamCount.ts
 */
import { connectDB, disconnectDB } from '../config/database';
import { User } from '../models/User';
import { logger } from '../utils/logger';

async function main() {
  await connectDB();

  const users = await User.find({ status: { $ne: 'deleted' } }).select('_id referredBy teamCount').lean();
  const ids = new Set(users.map((u) => String(u._id)));
  const children = new Map<string, string[]>();
  for (const u of users) {
    const parent = u.referredBy ? String(u.referredBy) : null;
    if (parent && ids.has(parent)) {
      const list = children.get(parent);
      if (list) list.push(String(u._id));
      else children.set(parent, [String(u._id)]);
    }
  }

  // Preorder traversal (iterative), then process in reverse → children before parents.
  const parentInSet = new Set<string>();
  for (const u of users) {
    const parent = u.referredBy ? String(u.referredBy) : null;
    if (parent && ids.has(parent)) parentInSet.add(String(u._id));
  }
  const roots = [...ids].filter((id) => !parentInSet.has(id));
  const order: string[] = [];
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const c of children.get(id) ?? []) stack.push(c);
  }
  // Any user not reached (cycle guard) — append remaining.
  for (const id of ids) if (!seen.has(id)) order.push(id);

  const size = new Map<string, number>();
  for (const id of order) size.set(id, 0);
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    let s = 0;
    for (const c of children.get(id) ?? []) s += 1 + (size.get(c) ?? 0);
    size.set(id, s);
  }

  const ops = [];
  let changed = 0;
  for (const u of users) {
    const id = String(u._id);
    const computed = size.get(id) ?? 0;
    if ((u.teamCount ?? 0) !== computed) {
      changed++;
      ops.push({ updateOne: { filter: { _id: u._id }, update: { $set: { teamCount: computed } } } });
    }
  }
  if (ops.length > 0) {
    await User.bulkWrite(ops, { ordered: false });
  }

  const top = [...size.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  logger.info({ totalUsers: users.length, changed, top }, 'teamCount backfill complete');
  await disconnectDB();
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'teamCount backfill failed');
  process.exit(1);
});
