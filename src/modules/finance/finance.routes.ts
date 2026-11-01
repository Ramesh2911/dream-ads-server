import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { env } from '../../config/env';
import { Withdrawal } from '../../models/Withdrawal';
import { Deposit } from '../../models/Deposit';
import { Setting } from '../../models/Setting';
import { MembershipRequest } from '../../models/MembershipRequest';
import { applyLedger, getBalances } from '../../services/ledger.service';
import { asyncHandler, ApiError } from '../../middleware/error';
import { requireUserAuth } from '../../middleware/auth';

const router = Router();

const MIN_WITHDRAWAL = 100;
const MIN_DEPOSIT = 50;

// ---- Membership activation ----
const DEFAULT_ACTIVATION_FEE = 151;
const DEFAULT_USDT_MIN = 2;

const paymentRoot = path.resolve(env.uploadDir, 'payment');
fs.mkdirSync(paymentRoot, { recursive: true });

const screenshotStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, paymentRoot),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.-]+/g, '_').slice(-80);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
  },
});

const ALLOWED_IMAGE = ['image/png', 'image/jpeg', 'image/webp'];

const screenshotUpload = multer({
  storage: screenshotStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE.includes(file.mimetype)) return cb(new ApiError(400, 'Image must be PNG, JPG or WEBP'));
    cb(null, true);
  },
});

function handleMembershipUpload(req: Request, res: Response, next: NextFunction) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) return next();
  screenshotUpload.single('screenshot')(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof ApiError) return next(err);
      const e = err as { code?: string; message?: string };
      if (e.code === 'LIMIT_FILE_SIZE') return next(new ApiError(400, 'Screenshot must be 5MB or smaller'));
      return next(new ApiError(400, e.message || 'Upload failed'));
    }
    next();
  });
}

async function getMembershipConfig() {
  const keys = ['activationFee', 'upiQr', 'usdtQr', 'usdtAddress', 'usdtMin'];
  const rows = await Setting.find({ key: { $in: keys } }).lean();
  const map: Record<string, unknown> = {};
  rows.forEach((r) => (map[r.key] = r.value));
  return {
    fee: Number(map.activationFee) || DEFAULT_ACTIVATION_FEE,
    usdtMin: Number(map.usdtMin) || DEFAULT_USDT_MIN,
    upiQr: typeof map.upiQr === 'string' && map.upiQr ? map.upiQr : '',
    usdtQr: typeof map.usdtQr === 'string' && map.usdtQr ? map.usdtQr : '',
    usdtAddress: typeof map.usdtAddress === 'string' ? map.usdtAddress : '',
  };
}

router.get(
  '/membership/config',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const cfg = await getMembershipConfig();
    const user = req.user!;
    const latestRequest = await MembershipRequest.findOne({ user: user._id }).sort({ createdAt: -1 }).lean();
    res.json({
      success: true,
      data: {
        fee: cfg.fee,
        usdtMin: cfg.usdtMin,
        upiQr: cfg.upiQr ? `/api/finance/membership/qr/upi` : '',
        usdtQr: cfg.usdtQr ? `/api/finance/membership/qr/usdt` : '',
        usdtAddress: cfg.usdtAddress,
        status: (user as unknown as { membershipStatus?: string }).membershipStatus ?? 'none',
        activeAt: (user as unknown as { membershipActiveAt?: Date }).membershipActiveAt ?? null,
        latestRequest: latestRequest
          ? {
              id: String(latestRequest._id),
              method: latestRequest.method,
              amount: latestRequest.amount,
              status: latestRequest.status,
              rejectionReason: latestRequest.rejectionReason ?? null,
              createdAt: latestRequest.createdAt,
            }
          : null,
      },
    });
  })
);

// Public capability route so <Image> can load the QR without auth headers
router.get(
  '/membership/qr/:kind',
  asyncHandler(async (req, res) => {
    const kind = req.params.kind;
    if (kind !== 'upi' && kind !== 'usdt') throw new ApiError(404, 'Not found');
    const cfg = await getMembershipConfig();
    const filename = kind === 'upi' ? cfg.upiQr : cfg.usdtQr;
    if (!filename || !/^[\w.-]{1,120}$/.test(filename)) throw new ApiError(404, 'QR not configured');
    const full = path.join(paymentRoot, filename);
    if (!fs.existsSync(full)) throw new ApiError(404, 'QR file missing');
    const ext = path.extname(filename).toLowerCase();
    const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
    res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=300');
    fs.createReadStream(full).pipe(res);
  })
);

router.post(
  '/membership/requests',
  requireUserAuth,
  handleMembershipUpload,
  asyncHandler(async (req, res) => {
    const user = req.user!;
    if ((user as unknown as { membershipStatus?: string }).membershipStatus === 'active')
      throw new ApiError(400, 'Membership already active');

    const data = z
      .object({
        amount: z.coerce.number().positive(),
        method: z.enum(['upi', 'usdt']),
        utr: z.string().trim().optional(),
        txHash: z.string().trim().optional(),
      })
      .superRefine((v, ctx) => {
        if (v.method === 'upi') {
          if (!v.utr || !/^\d{12}$/.test(v.utr))
            ctx.addIssue({ code: 'custom', path: ['utr'], message: 'UTR must be a 12-digit number' });
        } else if (!v.txHash || v.txHash.length < 10 || v.txHash.length > 120) {
          ctx.addIssue({ code: 'custom', path: ['txHash'], message: 'Valid transaction hash is required' });
        }
      })
      .parse(req.body);

    const pending = await MembershipRequest.countDocuments({ user: user._id, status: 'pending' });
    if (pending > 0) throw new ApiError(400, 'You already have a pending verification request');

    const cfg = await getMembershipConfig();
    if (data.method === 'upi' && data.amount !== cfg.fee)
      throw new ApiError(400, `Amount must be ${cfg.fee}`);
    if (data.method === 'usdt' && data.amount < cfg.usdtMin)
      throw new ApiError(400, `Minimum ${cfg.usdtMin} USDT`);

    const screenshot = (req.file as Express.Multer.File | undefined)?.filename;
    if (!screenshot) throw new ApiError(400, 'Payment screenshot is required');

    const request = await MembershipRequest.create({
      user: user._id,
      method: data.method,
      amount: data.amount,
      ...(data.method === 'upi' ? { utr: data.utr } : { txHash: data.txHash }),
      screenshot,
    });

    await user.$set('membershipStatus', 'pending');
    await user.save();

    res.status(201).json({ success: true, data: { request, status: 'pending' } });
  })
);

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
