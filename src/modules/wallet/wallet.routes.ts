import { Router } from 'express';
import { z } from 'zod';
import { LedgerEntry } from '../../models/LedgerEntry';
import { getBalances } from '../../services/ledger.service';
import { asyncHandler } from '../../middleware/error';
import { requireUserAuth } from '../../middleware/auth';

const router = Router();

router.get(
  '/balances',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const balances = await getBalances(req.user!._id);
    res.json({ success: true, data: balances });
  })
);

router.get(
  '/history',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const { wallet, page = 1, limit = 20 } = req.query;
    const filter: Record<string, unknown> = { user: req.user!._id };
    if (wallet) filter.wallet = wallet;
    const skip = (Number(page) - 1) * Number(limit);
    const [entries, total] = await Promise.all([
      LedgerEntry.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
      LedgerEntry.countDocuments(filter),
    ]);
    res.json({ success: true, data: { entries, total, page: Number(page), pages: Math.ceil(total / Number(limit)) } });
  })
);

router.get(
  '/pending',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const pending = await LedgerEntry.find({
      user: req.user!._id,
      reason: { $in: ['task_reward', 'referral_reward'] },
    }).sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, data: pending });
  })
);

export default router;
