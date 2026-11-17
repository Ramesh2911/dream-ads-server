import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomInt, createHash, timingSafeEqual } from 'crypto';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { User } from '../../models/User';
import { UserOtp, OtpPurpose } from '../../models/UserOtp';
import { DeletionRequest } from '../../models/DeletionRequest';
import { Wallet } from '../../models/Wallet';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { sendMail } from '../../services/mailer.service';
import { asyncHandler, ApiError } from '../../middleware/error';
import { requireUserAuth, signAccessToken, signRefreshToken } from '../../middleware/auth';
import { getBalances } from '../../services/ledger.service';
import { notify } from '../../services/notify.service';

const router = Router();

// ---- Email OTP (register verification + forgot password) ----
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts — try again after 15 minutes' },
});

const OTP_TTL_MIN = 10;
const OTP_MAX_ATTEMPTS = 5;

function hashOtp(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function otpMatches(storedHash: string, code: string): boolean {
  const a = Buffer.from(storedHash, 'hex');
  const b = Buffer.from(hashOtp(code), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function otpEmailHtml(code: string, heading: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">
  <h2 style="color:#0A1540;margin:0 0 4px;font-size:20px">Dream Ads</h2>
  <p style="color:#374151;font-size:14px;margin:8px 0">${heading}</p>
  <p style="font-size:30px;letter-spacing:10px;font-weight:bold;color:#2563EB;text-align:center;background:#f1f5f9;padding:14px;border-radius:8px;margin:12px 0">${code}</p>
  <p style="color:#6b7280;font-size:12px;margin-top:14px">Valid for ${OTP_TTL_MIN} minutes. If you didn't request this, you can safely ignore this email.</p>
</div>`;
}

/** Create (replacing older codes) and email an OTP. Throws ApiError(502) when mail fails. */
async function issueOtp(email: string, purpose: OtpPurpose, heading: string): Promise<void> {
  const code = String(randomInt(100000, 1000000));
  await UserOtp.deleteMany({ email, purpose });
  await UserOtp.create({
    email,
    purpose,
    codeHash: hashOtp(code),
    expiresAt: new Date(Date.now() + OTP_TTL_MIN * 60 * 1000),
  });
  try {
    await sendMail({ to: email, subject: `Your verification code — Dream Ads`, html: otpEmailHtml(code, heading) });
  } catch (err) {
    logger.error({ err }, 'otp: email failed to send');
    throw new ApiError(502, 'Could not send OTP email — try again later');
  }
}

/** Validate an OTP without consuming it. Throws ApiError(400) on expiry/limits/mismatch. */
async function checkOtp(email: string, purpose: OtpPurpose, otp: string): Promise<void> {
  const record = await UserOtp.findOne({ email, purpose }).sort({ createdAt: -1 });
  if (!record || record.expiresAt.getTime() < Date.now()) {
    await UserOtp.deleteMany({ email, purpose });
    throw new ApiError(400, 'OTP expired — request a new one');
  }
  if (record.attempts >= OTP_MAX_ATTEMPTS) {
    await UserOtp.deleteMany({ email, purpose });
    throw new ApiError(400, 'Too many attempts — request a new OTP');
  }
  if (!otpMatches(record.codeHash, otp)) {
    record.attempts += 1;
    await record.save();
    throw new ApiError(400, 'Invalid OTP');
  }
}

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
  limits: { fileSize: 5 * 1024 * 1024, files: 4 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE.includes(file.mimetype)) return cb(new ApiError(400, 'Image must be PNG, JPG or WEBP'));
    cb(null, true);
  },
});

const PROFILE_FIELDS = ['avatar', 'aadharFront', 'aadharBack', 'livePhoto'];

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

// ---- Register step 1: validate form + send email OTP (account created only after OTP verify) ----
router.post(
  '/register/request-otp',
  otpLimiter,
  asyncHandler(async (req: Request, res) => {
    const data = registerSchema.parse(req.body);
    if (data.email && (await User.findOne({ email: data.email })))
      throw new ApiError(409, 'Email already registered');
    if (data.mobile && (await User.findOne({ mobile: data.mobile })))
      throw new ApiError(409, 'Mobile already registered');
    if (data.referralCode && !(await User.findOne({ referralCode: data.referralCode })))
      throw new ApiError(400, 'Invalid referral code');

    await issueOtp(data.email.toLowerCase(), 'register', 'Use this code to verify your email and create your account:');
    res.json({ success: true, message: `OTP sent to ${data.email} — valid for ${OTP_TTL_MIN} minutes` });
  })
);

router.post(
  '/register',
  otpLimiter,
  asyncHandler(async (req: Request, res) => {
    const data = registerSchema
      .extend({ otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits') })
      .parse(req.body);
    await checkOtp(data.email.toLowerCase(), 'register', data.otp);
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
    await UserOtp.deleteMany({ email: data.email.toLowerCase(), purpose: 'register' });

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
    if (user.status === 'deleted') throw new ApiError(401, 'Invalid credentials');
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

// ---- Forgot password (email OTP → verify → reset) ----
router.post(
  '/forgot-password',
  otpLimiter,
  asyncHandler(async (req: Request, res) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const user = await User.findOne({ email });
    if (user && user.status !== 'deleted') {
      await issueOtp(email.toLowerCase(), 'reset', 'Use this code to reset your password:');
    }
    // Generic response whether or not the email exists (anti-enumeration)
    res.json({ success: true, message: `If this email is registered, a ${OTP_TTL_MIN}-minute OTP has been sent` });
  })
);

router.post(
  '/forgot-password/verify',
  otpLimiter,
  asyncHandler(async (req: Request, res) => {
    const data = z
      .object({
        email: z.string().email(),
        otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
      })
      .parse(req.body);
    await checkOtp(data.email.toLowerCase(), 'reset', data.otp);
    res.json({ success: true, message: 'OTP verified — set your new password' });
  })
);

router.post(
  '/forgot-password/reset',
  otpLimiter,
  asyncHandler(async (req: Request, res) => {
    const data = z
      .object({
        email: z.string().email(),
        otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
        newPassword: z.string().min(6, 'New password must be at least 6 characters').max(100),
      })
      .parse(req.body);
    const email = data.email.toLowerCase();
    await checkOtp(email, 'reset', data.otp);
    const user = await User.findOne({ email: data.email });
    if (!user || user.status === 'deleted') throw new ApiError(400, 'Invalid request');
    user.password = await bcrypt.hash(data.newPassword, 10);
    await user.save();
    await UserOtp.deleteMany({ email, purpose: 'reset' });
    res.json({ success: true, message: 'Password updated — sign in with your new password' });
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
        livePhoto: u.livePhoto ?? null,
        kycDocType: u.kycDocType ?? null,
        status: u.status, kycStatus: u.kycStatus, isAgeVerified: u.isAgeVerified, balances,
        membershipStatus: u.membershipStatus ?? 'none', membershipActiveAt: u.membershipActiveAt ?? null,
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

      const liveFile = files.livePhoto?.[0];
      if (liveFile) {
        removeProfileFile(user.livePhoto);
        user.livePhoto = liveFile.filename;
      }

      let docsChanged = false;
      const front = files.aadharFront?.[0];
      const back = files.aadharBack?.[0];
      const rawDocType = typeof req.body.kycDocType === 'string' ? req.body.kycDocType : '';
      const docType = rawDocType === 'pan' || rawDocType === 'voter' || rawDocType === 'aadhar' ? rawDocType : undefined;

      // Doc type switch → clear old slots (smooth automatic replace)
      if (docType && user.kycDocType && user.kycDocType !== docType && (front || back)) {
        if (user.aadharFront) { removeProfileFile(user.aadharFront); user.aadharFront = undefined; }
        if (user.aadharBack) { removeProfileFile(user.aadharBack); user.aadharBack = undefined; }
        user.kycDocType = docType;
      } else if (docType) {
        user.kycDocType = docType;
      }

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
        data: { id: user._id, name: user.name, avatar: user.avatar, aadharFront: user.aadharFront, aadharBack: user.aadharBack, livePhoto: user.livePhoto ?? null, kycDocType: user.kycDocType ?? null, kycStatus: user.kycStatus },
      });
      return;
    }

    const schema = z.object({ name: z.string().min(2).optional(), avatar: z.string().optional() });
    const data = schema.parse(req.body);
    Object.assign(user, data);
    await user.save();
    res.json({
      success: true,
      data: { id: user._id, name: user.name, avatar: user.avatar, aadharFront: user.aadharFront, aadharBack: user.aadharBack, livePhoto: user.livePhoto ?? null, kycDocType: user.kycDocType ?? null, kycStatus: user.kycStatus },
    });
  })
);

const deleteRequestSchema = z.object({
  name: z.string().min(2, 'Name is required').max(80),
  idNo: z.string().min(4, 'ID number is required').max(40),
  phone: z.string().regex(/^\d{10}$/, 'Mobile must be 10 digits'),
  email: z.string().email('Valid email is required'),
  notes: z.string().max(500).optional(),
});

router.post(
  '/delete-request',
  requireUserAuth,
  asyncHandler(async (req: Request, res) => {
    const data = deleteRequestSchema.parse(req.body);
    const user = await User.findById(req.user!._id);
    if (!user) throw new ApiError(404, 'User not found');
    if (user.status === 'pending_delete') {
      res.json({ success: true, message: 'Deletion request already pending review' });
      return;
    }
    if (user.status !== 'active') throw new ApiError(400, 'Only active accounts can request deletion');
    if (await DeletionRequest.exists({ user: user._id, status: 'pending' })) {
      throw new ApiError(409, 'A deletion request is already under review');
    }

    await DeletionRequest.create({
      user: user._id,
      name: data.name,
      idNo: data.idNo,
      phone: data.phone,
      email: data.email,
      notes: data.notes?.trim() || undefined,
    });
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
    if (kind !== 'aadharFront' && kind !== 'aadharBack' && kind !== 'livePhoto') throw new ApiError(404, 'File not found');
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
    const user = await User.findById(userId).select('aadharFront aadharBack livePhoto');
    const filename = kind === 'livePhoto' ? user?.livePhoto : kind === 'aadharFront' ? user?.aadharFront : user?.aadharBack;
    if (!filename) throw new ApiError(404, 'File not found');
    sendProfileFile(res, filename, true);
  })
);

export default router;
