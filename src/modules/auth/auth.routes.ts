import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import { User } from '../../models/User';
import { Wallet } from '../../models/Wallet';
import { env } from '../../config/env';
import { asyncHandler, ApiError } from '../../middleware/error';
import { requireUserAuth, signAccessToken, signRefreshToken } from '../../middleware/auth';
import { getBalances } from '../../services/ledger.service';
import { notify } from '../../services/notify.service';

const router = Router();

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  mobile: z.string().regex(/^\d{10}$/, 'Mobile must be 10 digits'),
  password: z.string().min(6),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be YYYY-MM-DD'),
  referralCode: z.string().optional(),
  acceptTerms: z.boolean(),
});

function makeReferralCode() {
  return 'DA' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// ---- Profile image storage (avatar + aadhar KYC docs) ----
const profileRoot = path.resolve(env.uploadDir, 'profile');
fs.mkdirSync(profileRoot, { recursive: true });

const profileStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, profileRoot),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.-]+/g, '_').slice(-80);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
  },
});

const ALLOWED_IMAGE = ['image/png', 'image/jpeg', 'image/webp'];

const profileUpload = multer({
  storage: profileStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 3 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE.includes(file.mimetype)) return cb(new ApiError(400, 'Image must be PNG, JPG or WEBP'));
    cb(null, true);
  },
});

const PROFILE_FIELDS = ['avatar', 'aadharFront', 'aadharBack'];

function handleProfileUpload(req: Request, res: Response, next: NextFunction) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) return next();
  profileUpload.fields(PROFILE_FIELDS.map((name) => ({ name, maxCount: 1 })))(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof ApiError) return next(err);
      const e = err as { code?: string; message?: string };
      if (e.code === 'LIMIT_FILE_SIZE') return next(new ApiError(400, 'Image must be 5MB or smaller'));
      return next(new ApiError(400, e.message || 'Upload failed'));
    }
    next();
  });
}

function removeProfileFile(filename?: string) {
  if (!filename || filename.startsWith('http')) return;
  try {
    if (/^[\w.-]{1,120}$/.test(filename)) fs.unlinkSync(path.join(profileRoot, filename));
  } catch {
    /* old file may already be gone */
  }
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

    notify({
      userId: user._id,
      type: 'info',
      title: 'Welcome to Dream Ads 🎉',
      body: 'Complete tasks, earn coins and withdraw your earnings. Explore your first task to get started.',
      data: { welcome: true },
    });

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

/** Exchange a valid refresh token for a fresh access token — the app's axios
 *  interceptor calls this on 401 so short-lived (15m) access tokens renew silently. */
router.post(
  '/refresh',
  asyncHandler(async (req: Request, res) => {
    const { refreshToken } = z.object({ refreshToken: z.string().min(20) }).parse(req.body);
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(refreshToken, env.jwtRefreshSecret) as jwt.JwtPayload;
    } catch {
      throw new ApiError(401, 'Invalid or expired refresh token');
    }
    if (payload.type !== 'refresh') throw new ApiError(401, 'Invalid or expired refresh token');
    const user = await User.findById(payload.sub);
    if (!user || user.status === 'deleted' || user.status === 'banned' || user.status === 'suspended') {
      throw new ApiError(401, 'Invalid or expired refresh token');
    }
    res.json({ success: true, data: { accessToken: signAccessToken(String(user._id)) } });
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
        dob: u.dob, avatar: u.avatar, aadharFront: u.aadharFront, aadharBack: u.aadharBack,
        status: u.status, kycStatus: u.kycStatus, isAgeVerified: u.isAgeVerified, balances,
      },
    });
  })
);

router.put(
  '/me',
  requireUserAuth,
  handleProfileUpload,
  asyncHandler(async (req: Request, res) => {
    const user = await User.findById(req.user!._id);
    if (!user) throw new ApiError(404, 'User not found');

    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;

      const avatarFile = files.avatar?.[0];
      if (avatarFile) {
        removeProfileFile(user.avatar);
        user.avatar = avatarFile.filename;
      }

      let docsChanged = false;
      const front = files.aadharFront?.[0];
      const back = files.aadharBack?.[0];
      if (front) {
        removeProfileFile(user.aadharFront);
        user.aadharFront = front.filename;
        docsChanged = true;
      }
      if (back) {
        removeProfileFile(user.aadharBack);
        user.aadharBack = back.filename;
        docsChanged = true;
      }
      if (docsChanged && (user.kycStatus === 'none' || user.kycStatus === 'rejected')) user.kycStatus = 'pending';

      await user.save();
      res.json({
        success: true,
        data: { id: user._id, name: user.name, avatar: user.avatar, aadharFront: user.aadharFront, aadharBack: user.aadharBack, kycStatus: user.kycStatus },
      });
      return;
    }

    const schema = z.object({ name: z.string().min(2).optional(), avatar: z.string().optional() });
    const data = schema.parse(req.body);
    Object.assign(user, data);
    await user.save();
    res.json({
      success: true,
      data: { id: user._id, name: user.name, avatar: user.avatar, aadharFront: user.aadharFront, aadharBack: user.aadharBack, kycStatus: user.kycStatus },
    });
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

// ---- Profile file serving ----
const FILE_MIME: Record<string, string> = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

function sendProfileFile(res: Response, filename: string, isPrivate: boolean) {
  if (!/^[\w.-]{1,120}$/.test(filename)) throw new ApiError(404, 'File not found');
  const filePath = path.join(profileRoot, filename);
  if (!filePath.startsWith(profileRoot + path.sep)) throw new ApiError(404, 'File not found');
  if (!fs.existsSync(filePath)) throw new ApiError(404, 'File not found');
  const ext = path.extname(filename).toLowerCase();
  res.setHeader('Content-Type', FILE_MIME[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', isPrivate ? 'private, max-age=3600' : 'public, max-age=86400');
  res.sendFile(filePath);
}

/** Public avatar — random filename acts as an unguessable capability URL. */
router.get(
  '/avatar/:file',
  asyncHandler(async (req: Request, res) => {
    sendProfileFile(res, req.params.file, false);
  })
);

/** Own KYC documents — token in query because RN <Image> cannot send Authorization headers. */
router.get(
  '/kyc/:kind',
  asyncHandler(async (req: Request, res) => {
    const kind = req.params.kind;
    if (kind !== 'aadharFront' && kind !== 'aadharBack') throw new ApiError(404, 'File not found');
    const token = String(req.query.token || '');
    if (!token) throw new ApiError(401, 'Authentication required');
    let userId: string;
    try {
      const payload = jwt.verify(token, env.jwtAccessSecret) as jwt.JwtPayload;
      if (payload.type !== 'access' || !payload.sub) throw new Error('invalid token');
      userId = String(payload.sub);
    } catch {
      throw new ApiError(401, 'Authentication required');
    }
    const user = await User.findById(userId).select('aadharFront aadharBack');
    const filename = kind === 'aadharFront' ? user?.aadharFront : user?.aadharBack;
    if (!filename) throw new ApiError(404, 'File not found');
    sendProfileFile(res, filename, true);
  })
);

export default router;
