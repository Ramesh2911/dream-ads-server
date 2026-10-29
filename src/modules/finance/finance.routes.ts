import { Router } from 'express';
import { z } from 'zod';
import { Withdrawal } from '../../models/Withdrawal';
import { Deposit } from '../../models/Deposit';
import { applyLedger, getBalances } from '../../services/ledger.service';
import { asyncHandler, ApiError } from '../../middleware/error';
import { requireUserAuth } from '../../middleware/auth';

const router = Router();

const MIN_WITHDRAWAL = 100;
const MIN_DEPOSIT = 50;

router.get(
  '/withdrawals',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const withdrawals = await Withdrawal.find({ user: req.user!._id }).sort({ createdAt: -1 });
    res.json({ success: true, data: withdrawals });
  })
);

router.post(
  '/withdrawals',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        amount: z.number().min(MIN_WITHDRAWAL),
        wallet: z.enum(['video', 'social']),
        method: z.enum(['upi', 'bank', 'paytm']),
        destination: z.string().trim().min(3).optional(),
        accountNo: z.string().trim().min(6).max(25).regex(/^[A-Za-z0-9]+$/, 'Invalid account number').optional(),
        ifsc: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC code')
          .optional(),
        bankName: z.string().trim().min(2).max(60).optional(),
      })
      .superRefine((v, ctx) => {
        if (v.method === 'bank') {
          if (!v.accountNo) ctx.addIssue({ code: 'custom', path: ['accountNo'], message: 'Account number is required' });
          if (!v.ifsc) ctx.addIssue({ code: 'custom', path: ['ifsc'], message: 'IFSC code is required' });
          if (!v.bankName) ctx.addIssue({ code: 'custom', path: ['bankName'], message: 'Bank name is required' });
        } else if (!v.destination) {
          ctx.addIssue({ code: 'custom', path: ['destination'], message: 'Destination is required' });
        }
      })
      .parse(req.body);

    const isBank = data.method === 'bank';
    // bank payouts: compose the destination server-side so the admin sees one
    // consistent string while structured fields stay queryable
    const destination = isBank ? `A/C ${data.accountNo} · IFSC ${data.ifsc} · ${data.bankName}` : data.destination!;

    const balances = await getBalances(req.user!._id);
    if (balances[data.wallet] < data.amount) throw new ApiError(400, 'Insufficient balance');

    const pending = await Withdrawal.countDocuments({ user: req.user!._id, status: 'pending' });
    if (pending > 0) throw new ApiError(400, 'You already have a pending withdrawal');

    const { balance } = await applyLedger({
      userId: req.user!._id,
      wallet: data.wallet,
      type: 'debit',
      amount: data.amount,
      reason: 'withdrawal',
      note: `Withdrawal request via ${data.method}`,
    });

    const withdrawal = await Withdrawal.create({
      amount: data.amount,
      wallet: data.wallet,
      method: data.method,
      destination,
      ...(isBank ? { accountNo: data.accountNo, ifsc: data.ifsc, bankName: data.bankName } : {}),
      user: req.user!._id,
    });
    res.status(201).json({ success: true, data: { withdrawal, balance } });
  })
);

router.get(
  '/deposits',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const deposits = await Deposit.find({ user: req.user!._id }).sort({ createdAt: -1 });
    res.json({ success: true, data: deposits });
  })
);

router.post(
  '/deposits',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const data = z.object({ amount: z.number().min(MIN_DEPOSIT), gateway: z.string().default('manual') }).parse(req.body);
    const deposit = await Deposit.create({ ...data, user: req.user!._id });
    res.status(201).json({ success: true, data: deposit });
  })
);

export default router;
