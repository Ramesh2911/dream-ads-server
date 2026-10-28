import { Router } from 'express';
import { z } from 'zod';
import { Video } from '../../models/Video';
import { Category } from '../../models/Category';
import { Banner } from '../../models/Banner';
import { ViewEvent } from '../../models/ViewEvent';
import { Comment } from '../../models/Comment';
import { VideoLike } from '../../models/VideoLike';
import { VideoSave } from '../../models/VideoSave';
import { applyLedger } from '../../services/ledger.service';
import { asyncHandler, ApiError } from '../../middleware/error';
import { requireUserAuth, optionalUserAuth } from '../../middleware/auth';

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
  optionalUserAuth,
  asyncHandler(async (req, res) => {
    const { category, featured, trending, page = 1, limit = 20 } = req.query;
    const filter: Record<string, unknown> = { status: 'published' };
    if (category) {
      // accept slug or ObjectId (guard against invalid ObjectId cast errors)
      const isObjectId = /^[0-9a-fA-F]{24}$/.test(String(category));
      const cat = isObjectId
        ? await Category.findOne({ $or: [{ slug: String(category) }, { _id: category }] }).select('_id')
        : await Category.findOne({ slug: String(category) }).select('_id');
      if (cat) filter.category = cat._id;
      else filter.category = '000000000000000000000000'; // no match
    }
    if (featured === 'true') filter.isFeatured = true;
    if (trending === 'true') filter.isTrending = true;
    const skip = (Number(page) - 1) * Number(limit);
    const [videos, total] = await Promise.all([
      Video.find(filter).populate('category', 'name slug').sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
      Video.countDocuments(filter),
    ]);

    let likedIds = new Set<string>();
    let savedIds = new Set<string>();
    if (req.user && videos.length) {
      const ids = videos.map((v) => v._id);
      const [likes, saves] = await Promise.all([
        VideoLike.find({ user: req.user._id, video: { $in: ids } }).select('video'),
        VideoSave.find({ user: req.user._id, video: { $in: ids } }).select('video'),
      ]);
      likedIds = new Set(likes.map((l) => String(l.video)));
      savedIds = new Set(saves.map((s) => String(s.video)));
    }

    const data = videos.map((v) => ({
      ...v.toObject(),
      liked: likedIds.has(String(v._id)),
      saved: savedIds.has(String(v._id)),
    }));

    res.json({ success: true, data: { videos: data, total, page: Number(page), pages: Math.ceil(total / Number(limit)) } });
  })
);

router.get(
  '/videos/saved',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const saves = await VideoSave.find({ user: req.user!._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate({ path: 'video', populate: { path: 'category', select: 'name slug' } });
    const videos = saves.map((s) => s.video).filter((v) => v && (v as { status?: string }).status === 'published');
    res.json({ success: true, data: { videos } });
  })
);

router.get(
  '/videos/:id',
  optionalUserAuth,
  asyncHandler(async (req, res) => {
    const video = await Video.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }, { new: true }).populate('category', 'name slug');
    if (!video || video.status !== 'published') throw new ApiError(404, 'Video not found');
    let liked = false;
    let saved = false;
    if (req.user) {
      const [l, s] = await Promise.all([
        VideoLike.exists({ user: req.user._id, video: video._id }),
        VideoSave.exists({ user: req.user._id, video: video._id }),
      ]);
      liked = !!l;
      saved = !!s;
    }
    res.json({ success: true, data: { ...video.toObject(), liked, saved } });
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

/** Toggle like — per-user dedupe via unique index (no blind $inc). */
router.post(
  '/videos/:id/like',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const video = await Video.findById(req.params.id);
    if (!video || video.status !== 'published') throw new ApiError(404, 'Video not found');
    const existing = await VideoLike.findOne({ user: req.user!._id, video: video._id });
    if (existing) {
      await existing.deleteOne();
      video.likes = Math.max(0, video.likes - 1);
      await video.save();
      return res.json({ success: true, data: { liked: false, likes: video.likes } });
    }
    await VideoLike.create({ user: req.user!._id, video: video._id });
    video.likes += 1;
    await video.save();
    res.json({ success: true, data: { liked: true, likes: video.likes } });
  })
);

/** Toggle save/favourite. */
router.post(
  '/videos/:id/save',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const video = await Video.findById(req.params.id);
    if (!video || video.status !== 'published') throw new ApiError(404, 'Video not found');
    const existing = await VideoSave.findOne({ user: req.user!._id, video: video._id });
    if (existing) {
      await existing.deleteOne();
      return res.json({ success: true, data: { saved: false } });
    }
    await VideoSave.create({ user: req.user!._id, video: video._id });
    res.json({ success: true, data: { saved: true } });
  })
);

/** Count a share (client still uses native Share sheet). */
router.post(
  '/videos/:id/share',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const video = await Video.findByIdAndUpdate(req.params.id, { $inc: { shares: 1 } }, { new: true });
    if (!video) throw new ApiError(404, 'Video not found');
    res.json({ success: true, data: { shares: video.shares } });
  })
);

// ---- Comments ----

router.get(
  '/videos/:id/comments',
  asyncHandler(async (req, res) => {
    const { page = 1, limit = 50 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const [comments, total] = await Promise.all([
      Comment.find({ video: req.params.id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .populate('user', 'name avatar'),
      Comment.countDocuments({ video: req.params.id }),
    ]);
    res.json({ success: true, data: { comments, total, page: Number(page), pages: Math.ceil(total / Number(limit)) } });
  })
);

router.post(
  '/videos/:id/comments',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const { text } = z.object({ text: z.string().trim().min(1).max(500) }).parse(req.body);
    const video = await Video.findById(req.params.id);
    if (!video || video.status !== 'published') throw new ApiError(404, 'Video not found');
    const comment = await Comment.create({ video: video._id, user: req.user!._id, text });
    await comment.populate('user', 'name avatar');
    res.status(201).json({ success: true, data: comment });
  })
);

router.delete(
  '/videos/comments/:commentId',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment) throw new ApiError(404, 'Comment not found');
    if (String(comment.user) !== String(req.user!._id)) throw new ApiError(403, 'Not your comment');
    await comment.deleteOne();
    res.json({ success: true, message: 'Comment deleted' });
  })
);

export default router;
