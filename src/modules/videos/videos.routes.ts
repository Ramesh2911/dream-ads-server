import { Router } from 'express';
import { z } from 'zod';
import { Video } from '../../models/Video';
import { Category } from '../../models/Category';
import { Banner } from '../../models/Banner';
import { ViewEvent } from '../../models/ViewEvent';
import { applyLedger } from '../../services/ledger.service';
import { asyncHandler, ApiError } from '../../middleware/error';
import { requireUserAuth } from '../../middleware/auth';

const router = Router();

router.get(
  '/categories',
  asyncHandler(async (_req, res) => {
    const categories = await Category.find({ isActive: true }).sort({ order: 1 });
    res.json({ success: true, data: categories });
  })
);

router.get(
  '/videos',
  asyncHandler(async (req, res) => {
    const { category, featured, trending, page = 1, limit = 20 } = req.query;
    const filter: Record<string, unknown> = { status: 'published' };
    if (category) filter.category = category;
    if (featured === 'true') filter.isFeatured = true;
    if (trending === 'true') filter.isTrending = true;
    const skip = (Number(page) - 1) * Number(limit);
    const [videos, total] = await Promise.all([
      Video.find(filter).populate('category', 'name slug').sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
      Video.countDocuments(filter),
    ]);
    res.json({ success: true, data: { videos, total, page: Number(page), pages: Math.ceil(total / Number(limit)) } });
  })
);

router.get(
  '/videos/:id',
  asyncHandler(async (req, res) => {
    const video = await Video.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }, { new: true }).populate('category', 'name slug');
    if (!video || video.status !== 'published') throw new ApiError(404, 'Video not found');
    res.json({ success: true, data: video });
  })
);

router.get(
  '/banners',
  asyncHandler(async (_req, res) => {
    const now = new Date();
    const banners = await Banner.find({
      isActive: true,
      $and: [
        { $or: [{ startsAt: { $lte: now } }, { startsAt: null }, { startsAt: { $exists: false } }] },
        { $or: [{ endsAt: { $gte: now } }, { endsAt: null }, { endsAt: { $exists: false } }] },
      ],
    }).sort({ order: 1 });
    res.json({ success: true, data: banners });
  })
);

router.post(
  '/videos/:id/view',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const { watchedSeconds } = z.object({ watchedSeconds: z.number().min(0) }).parse(req.body);
    const video = await Video.findById(req.params.id);
    if (!video || video.status !== 'published') throw new ApiError(404, 'Video not found');

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const existing = await ViewEvent.findOne({ user: req.user!._id, video: video._id, createdAt: { $gte: today } });
    if (existing?.rewarded) {
      return res.json({ success: true, data: { rewarded: false, reason: 'Already rewarded today for this video' } });
    }

    const minWatch = Math.max(5, (video.duration || 30) * 0.5);
    if (watchedSeconds >= minWatch && video.rewardCoins > 0) {
      if (existing) {
        existing.watchedSeconds = watchedSeconds;
        existing.rewarded = true;
        await existing.save();
      } else {
        await ViewEvent.create({ user: req.user!._id, video: video._id, watchedSeconds, rewarded: true });
      }
      const { balance } = await applyLedger({
        userId: req.user!._id,
        wallet: video.rewardWallet,
        type: 'credit',
        amount: video.rewardCoins,
        reason: 'watch_reward',
        refModel: 'Video',
        refId: video._id,
      });
      return res.json({ success: true, data: { rewarded: true, coins: video.rewardCoins, wallet: video.rewardWallet, balance } });
    }

    if (!existing) {
      await ViewEvent.create({ user: req.user!._id, video: video._id, watchedSeconds, rewarded: false });
    }
    res.json({ success: true, data: { rewarded: false, reason: 'Watch time not enough' } });
  })
);

router.post(
  '/videos/:id/like',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const video = await Video.findByIdAndUpdate(req.params.id, { $inc: { likes: 1 } }, { new: true });
    if (!video) throw new ApiError(404, 'Video not found');
    res.json({ success: true, data: { likes: video.likes } });
  })
);

export default router;
