import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { Notification } from '../../models/Notification';
import { requireUserAuth } from '../../middleware/auth';
import { asyncHandler, ApiError } from '../../middleware/error';

const router = Router();

// ---- List own notifications (paginated, newest first) ----
router.get(
  '/',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .parse(req.query);

    const filter = { user: req.user!._id };
    const [items, total, unreadCount] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit)
        .lean(),
      Notification.countDocuments(filter),
      Notification.countDocuments({ ...filter, read: false }),
    ]);

    res.json({
      success: true,
      data: { items, total, unreadCount, page: q.page, pages: Math.ceil(total / q.limit) },
    });
  })
);

// ---- Unread badge count ----
router.get(
  '/unread-count',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const count = await Notification.countDocuments({ user: req.user!._id, read: false });
    res.json({ success: true, data: { count } });
  })
);

// ---- Mark one as read ----
router.post(
  '/:id/read',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!Types.ObjectId.isValid(id)) throw new ApiError(404, 'Notification not found');
    const doc = await Notification.findOneAndUpdate(
      { _id: id, user: req.user!._id },
      { read: true },
      { new: true }
    );
    if (!doc) throw new ApiError(404, 'Notification not found');
    res.json({ success: true, data: { id: doc._id, read: true } });
  })
);

// ---- Mark all as read ----
router.post(
  '/read-all',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const result = await Notification.updateMany({ user: req.user!._id, read: false }, { read: true });
    res.json({ success: true, data: { updated: result.modifiedCount } });
  })
);

export default router;
