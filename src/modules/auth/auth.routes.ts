import { Router, Request } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { User } from '../../models/User';
import { Wallet } from '../../models/Wallet';
import { asyncHandler, ApiError } from '../../middleware/error';
import { requireUserAuth, signAccessToken, signRefreshToken } from '../../middleware/auth';
import { getBalances } from '../../services/ledger.service';

const router = Router();

const registerSchema = z
  .object({
    name: z.string().min(2),
    email: z.string().email().optional(),
    mobile: z.string().min(8).optional(),
    password: z.string().min(6),
    dob: z.string().optional(),
    referralCode: z.string().optional(),
    acceptTerms: z.boolean(),
  })
  .refine((d) => d.email || d.mobile, { message: 'Email or mobile required' });

function makeReferralCode() {
  return 'DA' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

router.post(
  '/register',
  asyncHandler(async (req: Request, res) => {
    const data = registerSchema.parse(req.body);
    if (data.email && (await User.findOne({ email: data.email })))
      throw new ApiError(409, 'Email already registered');
    if (data.mobile && (await User.findOne({ mobile: data.mobile })))
      throw new ApiError(409, 'Mobile already registered');

    let referredBy;
    if (data.referralCode) {
      const ref = await User.findOne({ referralCode: data.referralCode });
      if (!ref) throw new ApiError(400, 'Invalid referral code');
      referredBy = ref._id;
    }

    const hashed = await bcrypt.hash(data.password, 10);
    const user = await User.create({
      name: data.name,
      email: data.email,
      mobile: data.mobile,
      password: hashed,
      dob: data.dob ? new Date(data.dob) : undefined,
      referralCode: makeReferralCode(),
      referredBy,
      isAgeVerified: data.dob ? true : false,
      termsAcceptedAt: data.acceptTerms ? new Date() : undefined,
    });

    await Wallet.create([
      { user: user._id, wallet: 'video', balance: 0 },
      { user: user._id, wallet: 'social', balance: 0 },
    ]);

    if (referredBy) {
      const { distributeReferralRewards } = await import('../referrals/referrals.routes');
      distributeReferralRewards(String(user._id)).catch(() => {});
    }

    const access = signAccessToken(String(user._id));
    const refresh = signRefreshToken(String(user._id));
    res.status(201).json({
      success: true,
      data: {
        user: { id: user._id, name: user.name, email: user.email, referralCode: user.referralCode },
        tokens: { access, refresh },
      },
    });
  })
);

const loginSchema = z.object({
  email: z.string().email().optional(),
  mobile: z.string().optional(),
  password: z.string(),
});

router.post(
  '/login',
  asyncHandler(async (req: Request, res) => {
    const { email, mobile, password } = loginSchema.parse(req.body);
    const query = email ? { email } : { mobile };
    const user = await User.findOne(query);
    if (!user) throw new ApiError(401, 'Invalid credentials');
    if (user.status === 'banned') throw new ApiError(403, 'Account banned');
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) throw new ApiError(401, 'Invalid credentials');
    user.lastLoginAt = new Date();
    await user.save();
    const access = signAccessToken(String(user._id));
    const refresh = signRefreshToken(String(user._id));
    res.json({
      success: true,
      data: {
        user: { id: user._id, name: user.name, email: user.email, referralCode: user.referralCode, status: user.status },
        tokens: { access, refresh },
      },
    });
  })
);

router.get(
  '/me',
  requireUserAuth,
  asyncHandler(async (req: Request, res) => {
    const u = req.user!;
    const balances = await getBalances(String(u._id));
    res.json({
      success: true,
      data: {
        id: u._id, name: u.name, email: u.email, mobile: u.mobile, referralCode: u.referralCode,
        dob: u.dob, avatar: u.avatar, status: u.status, kycStatus: u.kycStatus,
        isAgeVerified: u.isAgeVerified, balances,
      },
    });
  })
);

router.put(
  '/me',
  requireUserAuth,
  asyncHandler(async (req: Request, res) => {
    const schema = z.object({ name: z.string().min(2).optional(), avatar: z.string().optional() });
    const data = schema.parse(req.body);
    const user = await User.findByIdAndUpdate(req.user!._id, data, { new: true });
    res.json({ success: true, data: { id: user!._id, name: user!.name, avatar: user!.avatar } });
  })
);

router.post(
  '/delete-request',
  requireUserAuth,
  asyncHandler(async (req: Request, res) => {
    const user = await User.findById(req.user!._id);
    if (!user) throw new ApiError(404, 'User not found');
    if (user.status === 'pending_delete') {
      res.json({ success: true, message: 'Deletion request already pending review' });
      return;
    }
    if (user.status !== 'active') throw new ApiError(400, 'Only active accounts can request deletion');
    user.status = 'pending_delete';
    await user.save();
    res.json({ success: true, message: 'Account deletion requested. An admin will review it.' });
  })
);

router.post(
  '/logout',
  requireUserAuth,
  asyncHandler(async (_req, res) => {
    res.json({ success: true, message: 'Logged out' });
  })
);

export default router;
