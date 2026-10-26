import { Router } from 'express';
import { User } from '../../models/User';
import { ReferralConfig } from '../../models/ReferralConfig';
import { applyLedger, getBalances } from '../../services/ledger.service';
import { asyncHandler, ApiError } from '../../middleware/error';
import { requireUserAuth } from '../../middleware/auth';
import { logger } from '../../utils/logger';

const router = Router();

router.get(
  '/',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const [directCount, config] = await Promise.all([
      User.countDocuments({ referredBy: user._id, status: { $ne: 'deleted' } }),
      ReferralConfig.findOne().lean(),
    ]);
    res.json({
      success: true,
      data: {
        referralCode: user.referralCode,
        directCount,
        config: config || { maxLevels: 10, levelRewards: [] },
      },
    });
  })
);

router.get(
  '/tree',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user!._id;
    const levels: { _id: unknown; name: string; referralCode: string; status: string; createdAt: Date }[][] = [];
    let currentLevel = await User.find({ referredBy: userId, status: { $ne: 'deleted' } }).select('name referralCode status createdAt').lean();
    levels.push(currentLevel as never);
    for (let i = 1; i < 10 && currentLevel.length > 0; i++) {
      currentLevel = await User.find({ referredBy: { $in: currentLevel.map((u) => u._id) }, status: { $ne: 'deleted' } }).select('name referralCode status createdAt').lean();
      levels.push(currentLevel as never);
    }
    res.json({ success: true, data: { levels: levels.map((l, i) => ({ level: i + 1, count: l.length, users: l })) } });
  })
);

router.get(
  '/daily',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const count = await User.countDocuments({ referredBy: req.user!._id, createdAt: { $gte: start } });
    res.json({ success: true, data: { dailyJoins: count } });
  })
);

/**
 * Called internally after a referred user registers — distributes level rewards.
 */
export async function distributeReferralRewards(newUserId: string) {
  try {
    const config = await ReferralConfig.findOne();
    if (!config || config.levelRewards.length === 0) return;
    let currentAncestor: { referredBy?: unknown } | null = await User.findById(newUserId).select('referredBy').lean();
    for (let level = 1; level <= config.maxLevels && currentAncestor?.referredBy; level++) {
      const ancestor = await User.findById(currentAncestor.referredBy);
      if (!ancestor || ancestor.status !== 'active') break;
      const reward = config.levelRewards.find((r) => r.level === level);
      if (reward && reward.coins > 0) {
        await applyLedger({
          userId: ancestor._id,
          wallet: reward.wallet,
          type: 'credit',
          amount: reward.coins,
          reason: 'referral_reward',
          refModel: 'User',
          refId: newUserId as never,
          note: `Level ${level} referral reward`,
        });
      }
      currentAncestor = await User.findById(ancestor._id).select('referredBy').lean();
    }
  } catch (err) {
    logger.error({ err }, 'Referral reward distribution failed');
  }
}

export default router;
