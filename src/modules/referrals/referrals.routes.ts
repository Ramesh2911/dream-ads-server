import { Router } from 'express';
import { User } from '../../models/User';
import { ReferralConfig, referralConfigJson, DEFAULT_LEVEL_TARGETS, DEFAULT_LEVEL_UP_BONUSES, ILevelTarget } from '../../models/ReferralConfig';
import { applyLedger, getBalances } from '../../services/ledger.service';
import { asyncHandler, ApiError } from '../../middleware/error';
import { requireUserAuth } from '../../middleware/auth';
import { logger } from '../../utils/logger';
import { notify } from '../../services/notify.service';

const router = Router();

router.get(
  '/',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const [directCount, config, fresh] = await Promise.all([
      User.countDocuments({ referredBy: user._id, status: { $ne: 'deleted' } }),
      ReferralConfig.findOne().lean(),
      User.findById(user._id).select('teamCount levelUpsReceived referralCode').lean(),
    ]);
    res.json({
      success: true,
      data: {
        referralCode: fresh?.referralCode || user.referralCode,
        directCount,
        teamCount: fresh?.teamCount ?? 0,
        levelUpsReceived: fresh?.levelUpsReceived ?? [],
        config: referralConfigJson(config as never),
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

function targetFor(targets: ILevelTarget[] | undefined, level: number): number {
  const found = targets?.find((t) => t.level === level);
  return found?.target ?? DEFAULT_LEVEL_TARGETS.find((t) => t.level === level)?.target ?? 3 ** level;
}

/**
 * Called internally after a referred user registers — distributes level rewards,
 * maintains the ancestor's total teamCount, and credits one-time level-up bonuses
 * when the team reaches each level's target size.
 */
export async function distributeReferralRewards(newUserId: string) {
  try {
    const config = await ReferralConfig.findOne();
    const maxLevels = config?.maxLevels ?? 10;
    const targets = config?.levelTargets?.length ? config.levelTargets : DEFAULT_LEVEL_TARGETS;
    const bonuses = config?.levelUpBonuses?.length ? config.levelUpBonuses : DEFAULT_LEVEL_UP_BONUSES;
    let currentAncestor: { referredBy?: unknown } | null = await User.findById(newUserId).select('referredBy').lean();

    for (let level = 1; level <= maxLevels && currentAncestor?.referredBy; level++) {
      const ancestor = await User.findById(currentAncestor.referredBy);
      if (!ancestor || ancestor.status !== 'active') break;

      // Maintain total team size for this ancestor (every new descendant counts once).
      const updated = await User.findByIdAndUpdate(ancestor._id, { $inc: { teamCount: 1 } }, { new: true });

      // Per-joining income at this network level (existing behaviour, values fully dynamic via config).
      const reward = config?.levelRewards.find((r) => r.level === level);
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
        notify({
          userId: ancestor._id,
          type: 'referral',
          title: `Referral reward +${reward.coins} 🎁`,
          body: `Level ${level} referral — ${reward.coins} coins credited to your ${reward.wallet} passbook.`,
          data: { level, coins: reward.coins, wallet: reward.wallet },
        });
      }

      // One-time level-up bonuses: granted once per level when teamCount reaches target.
      if (updated) {
        for (const bonus of bonuses) {
          if (!(bonus.coins > 0)) continue;
          const target = targetFor(targets, bonus.level);
          if ((updated.teamCount ?? 0) < target) continue;
          if ((updated.levelUpsReceived ?? []).some((r) => r.level === bonus.level)) continue;
          // Atomic claim so concurrent joins can never double-credit.
          const claimed = await User.updateOne(
            { _id: ancestor._id, 'levelUpsReceived.level': { $ne: bonus.level } },
            { $push: { levelUpsReceived: { level: bonus.level, coins: bonus.coins, receivedAt: new Date() } } }
          );
          if (claimed.modifiedCount === 1) {
            await applyLedger({
              userId: ancestor._id,
              wallet: bonus.wallet,
              type: 'credit',
              amount: bonus.coins,
              reason: 'level_up_bonus',
              refModel: 'User',
              refId: newUserId as never,
              note: `Level ${bonus.level} level-up bonus`,
            });
            notify({
              userId: ancestor._id,
              type: 'referral',
              title: `Level ${bonus.level} unlocked! 🎉`,
              body: `Your team reached ${target} members — one-time bonus of ${bonus.coins} coins credited to your ${bonus.wallet} passbook.`,
              data: { level: bonus.level, coins: bonus.coins, target, wallet: bonus.wallet },
            });
          }
        }
      }

      currentAncestor = await User.findById(ancestor._id).select('referredBy').lean();
    }
  } catch (err) {
    logger.error({ err }, 'Referral reward distribution failed');
  }
}

export default router;
