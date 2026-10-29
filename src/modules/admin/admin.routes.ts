import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { env } from '../../config/env';
import { User } from '../../models/User';
import { AdminUser } from '../../models/AdminUser';
import { Role, Permission, ALL_PERMISSIONS } from '../../models/Role';
import { LedgerEntry } from '../../models/LedgerEntry';
import { Wallet } from '../../models/Wallet';
import { Video } from '../../models/Video';
import { ViewEvent } from '../../models/ViewEvent';
import { Task } from '../../models/Task';
import { TaskSubmission } from '../../models/TaskSubmission';
import { Withdrawal } from '../../models/Withdrawal';
import { Deposit } from '../../models/Deposit';
import { AuditLog } from '../../models/AuditLog';
import { Inquiry } from '../../models/Inquiry';
import { Voucher } from '../../models/Voucher';
import { VoucherRedemption } from '../../models/VoucherRedemption';
import { Category } from '../../models/Category';
import { Banner } from '../../models/Banner';
import { AdPlacement } from '../../models/AdPlacement';
import { ReferralConfig } from '../../models/ReferralConfig';
import { Setting } from '../../models/Setting';
import { applyLedger, getBalances } from '../../services/ledger.service';
import { asyncHandler, ApiError } from '../../middleware/error';
import { requireAdminAuth, requirePermission, signAccessToken } from '../../middleware/auth';
import { audit } from '../../middleware/audit';
import { distributeReferralRewards } from '../referrals/referrals.routes';

const router = Router();

// ---- Admin auth ----
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
    const admin = await AdminUser.findOne({ email }).populate('role');
    if (!admin || admin.status !== 'active') throw new ApiError(401, 'Invalid credentials');
    const ok = await bcrypt.compare(password, admin.password);
    if (!ok) throw new ApiError(401, 'Invalid credentials');
    admin.lastLoginAt = new Date();
    await admin.save();
    const role = admin.role as unknown as { name: string; permissions: Permission[] };
    res.json({
      success: true,
      data: {
        admin: { id: admin._id, name: admin.name, email: admin.email, role: role.name, permissions: role.name === 'Super Admin' ? ['*'] : role.permissions },
        token: signAccessToken(String(admin._id)),
      },
    });
  })
);

// ---- Profile ----
router.get(
  '/profile',
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const admin = req.admin!;
    const role = admin.role as unknown as { _id?: unknown; name: string; permissions: Permission[] };
    const isSuper = role?.name === 'Super Admin';
    const permissions = isSuper ? (['*'] as unknown as Permission[]) : role?.permissions || [];
    const [auditCount, activity, actionAgg] = await Promise.all([
      AuditLog.countDocuments({ actorEmail: admin.email }),
      AuditLog.find({ actorEmail: admin.email }).sort({ createdAt: -1 }).limit(8).select('action entity createdAt ip').lean(),
      AuditLog.aggregate([
        { $match: { actorEmail: admin.email } },
        { $group: { _id: '$action', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
    ]);
    res.json({
      success: true,
      data: {
        id: admin._id,
        name: admin.name,
        email: admin.email,
        status: admin.status,
        role: {
          id: role?._id ?? null,
          name: role?.name ?? 'Unknown',
          permissions,
          permissionCount: isSuper ? ALL_PERMISSIONS.length : permissions.length,
          totalPermissions: ALL_PERMISSIONS.length,
        },
        totpEnabled: admin.totpEnabled,
        createdAt: admin.createdAt,
        updatedAt: admin.updatedAt,
        lastLoginAt: admin.lastLoginAt,
        auditCount,
        activity,
        topActions: (actionAgg as Array<{ _id: string; count: number }>).map((a) => ({ action: a._id, count: a.count })),
      },
    });
  })
);

router.put(
  '/profile',
  requireAdminAuth,
  audit('profile.update', 'AdminUser'),
  asyncHandler(async (req, res) => {
    const data = z
      .object({ name: z.string().min(2).max(60), email: z.string().email().max(120) })
      .parse(req.body);
    const admin = req.admin!;
    const normalized = data.email.toLowerCase();
    const dupe = await AdminUser.findOne({ email: normalized, _id: { $ne: admin._id } });
    if (dupe) throw new ApiError(409, 'Another admin already uses this email');
    admin.name = data.name.trim();
    admin.email = normalized;
    await admin.save();
    res.json({ success: true, message: 'Profile updated', data: { name: admin.name, email: admin.email } });
  })
);

router.post(
  '/profile/password',
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = z
      .object({
        currentPassword: z.string().min(1),
        newPassword: z
          .string()
          .min(8, 'New password must be at least 8 characters')
          .max(100)
          .regex(/[a-zA-Z]/, 'Must contain a letter')
          .regex(/\d/, 'Must contain a number'),
      })
      .parse(req.body);
    const admin = req.admin!;
    const ok = await bcrypt.compare(currentPassword, admin.password);
    if (!ok) throw new ApiError(401, 'Current password is incorrect');
    admin.password = await bcrypt.hash(newPassword, 10);
    await admin.save();
    AuditLog.create({
      actor: admin._id,
      actorEmail: admin.email,
      action: 'password.change',
      entity: 'AdminUser',
      entityId: String(admin._id),
      after: { password: '[redacted]' },
      ip: req.ip,
    }).catch(() => {});
    res.json({ success: true, message: 'Password changed' });
  })
);

// ---- Dashboard ----
router.get(
  '/dashboard',
  requireAdminAuth,
  requirePermission('dashboard.view'),
  asyncHandler(async (_req, res) => {
    const [userCount, newUsersToday, pendingTasks, pendingWithdrawals, pendingDeposits, totalVideoEarned, pendingLeads, signupsRaw] = await Promise.all([
      User.countDocuments({ status: { $ne: 'deleted' } }),
      User.countDocuments({ createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } }),
      TaskSubmission.countDocuments({ status: 'pending' }),
      Withdrawal.countDocuments({ status: 'pending' }),
      Deposit.countDocuments({ status: 'pending' }),
      LedgerEntry.aggregate([{ $match: { wallet: 'video', type: 'credit' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Inquiry.countDocuments({ status: 'new' }),
      User.aggregate([
        { $match: { createdAt: { $gte: new Date(Date.now() - 6 * 864e5) } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
    ]);
    const signupsByDay = new Map<string, number>(
      (signupsRaw as Array<{ _id: string; count: number }>).map((r) => [r._id, r.count])
    );
    const signups7d = Array.from({ length: 7 }, (_, i) => {
      const key = new Date(Date.now() - (6 - i) * 864e5).toISOString().slice(0, 10);
      return { date: key, count: signupsByDay.get(key) ?? 0 };
    });
    res.json({
      success: true,
      data: {
        userCount, newUsersToday, pendingTasks, pendingWithdrawals, pendingDeposits,
        totalVideoEarned: totalVideoEarned[0]?.total || 0,
        pendingLeads,
        signups7d,
      },
    });
  })
);

// ---- Users ----
router.get(
  '/users',
  requireAdminAuth,
  requirePermission('users.read'),
  asyncHandler(async (req, res) => {
    const { search, status, page = 1, limit = 20 } = req.query;
    const filter: Record<string, unknown> = {};
    if (search) {
      filter.$or = [
        { name: { $regex: String(search), $options: 'i' } },
        { email: { $regex: String(search), $options: 'i' } },
        { mobile: { $regex: String(search), $options: 'i' } },
        { referralCode: String(search).toUpperCase() },
      ];
    }
    if (status) filter.status = status;
    const skip = (Number(page) - 1) * Number(limit);
    const [users, total, statusCounts] = await Promise.all([
      User.find(filter).select('-password').sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
      User.countDocuments(filter),
      User.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    ]);
    const counts: Record<string, number> = { active: 0, suspended: 0, banned: 0, pending_delete: 0 };
    for (const row of statusCounts as Array<{ _id: string; count: number }>) counts[row._id] = row.count;
    res.json({ success: true, data: { users, total, counts, page: Number(page), pages: Math.ceil(total / Number(limit)) } });
  })
);

// ---- KYC review (registered BEFORE /users/:id so 'kyc' is not parsed as an id) ----
const profileRoot = path.resolve(env.uploadDir, 'profile');
const KYC_FILE_MIME: Record<string, string> = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

router.get(
  '/users/kyc',
  requireAdminAuth,
  requirePermission('users.read'),
  asyncHandler(async (req, res) => {
    const { status, search, page = 1, limit = 20 } = req.query;
    const and: Record<string, unknown>[] = [];
    if (status) and.push({ kycStatus: status });
    else
      and.push({
        $or: [
          { aadharFront: { $exists: true, $ne: null } },
          { aadharBack: { $exists: true, $ne: null } },
          { kycStatus: { $ne: 'none' } },
        ],
      });
    if (search) {
      and.push({
        $or: [
          { name: { $regex: String(search), $options: 'i' } },
          { email: { $regex: String(search), $options: 'i' } },
          { mobile: { $regex: String(search), $options: 'i' } },
        ],
      });
    }
    const filter = and.length ? { $and: and } : {};
    const skip = (Number(page) - 1) * Number(limit);
    const [users, total, kycCounts] = await Promise.all([
      User.find(filter)
        .select('name email mobile dob referralCode status kycStatus avatar aadharFront aadharBack createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      User.countDocuments(filter),
      User.aggregate([{ $group: { _id: '$kycStatus', count: { $sum: 1 } } }]),
    ]);
    const counts: Record<string, number> = { none: 0, pending: 0, verified: 0, rejected: 0 };
    for (const row of kycCounts as Array<{ _id: string; count: number }>) counts[row._id] = row.count;
    res.json({ success: true, data: { users, total, counts, page: Number(page), pages: Math.ceil(total / Number(limit)) } });
  })
);

router.get(
  '/users/:id/kyc-doc/:kind',
  requireAdminAuth,
  requirePermission('users.read'),
  asyncHandler(async (req, res) => {
    const kind = req.params.kind;
    if (kind !== 'aadharFront' && kind !== 'aadharBack') throw new ApiError(404, 'File not found');
    const user = await User.findById(req.params.id).select('aadharFront aadharBack');
    const filename = kind === 'aadharFront' ? user?.aadharFront : user?.aadharBack;
    if (!filename || !/^[\w.-]{1,120}$/.test(filename)) throw new ApiError(404, 'File not found');
    const filePath = path.join(profileRoot, filename);
    if (!filePath.startsWith(profileRoot + path.sep) || !fs.existsSync(filePath)) throw new ApiError(404, 'File not found');
    const ext = path.extname(filename).toLowerCase();
    res.setHeader('Content-Type', KYC_FILE_MIME[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(filePath);
  })
);

router.put(
  '/users/:id/kyc',
  requireAdminAuth,
  requirePermission('users.update'),
  audit('kyc.review', 'User'),
  asyncHandler(async (req, res) => {
    const { status, reason } = z
      .object({ status: z.enum(['verified', 'rejected']), reason: z.string().max(500).optional() })
      .parse(req.body);
    const user = await User.findById(req.params.id);
    if (!user) throw new ApiError(404, 'User not found');
    if (!user.aadharFront && !user.aadharBack) throw new ApiError(400, 'No KYC documents uploaded');
    user.kycStatus = status;
    user.kycDocuments = user.kycDocuments ?? [];
    user.kycDocuments.push({ type: 'review', url: '', status, reason });
    await user.save();
    res.json({ success: true, data: { id: user._id, kycStatus: user.kycStatus } });
  })
);

router.get(
  '/users/:id',
  requireAdminAuth,
  requirePermission('users.read'),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) throw new ApiError(404, 'User not found');
    const [balances, referralCount, recentLedger] = await Promise.all([
      getBalances(String(user._id)),
      User.countDocuments({ referredBy: user._id }),
      LedgerEntry.find({ user: user._id }).sort({ createdAt: -1 }).limit(20),
    ]);
    res.json({ success: true, data: { user, balances, referralCount, recentLedger } });
  })
);

router.put(
  '/users/:id/status',
  requireAdminAuth,
  requirePermission('users.update', 'users.ban'),
  audit('user.status_change', 'User'),
  asyncHandler(async (req, res) => {
    const { status } = z.object({ status: z.enum(['active', 'suspended', 'banned', 'pending_delete']) }).parse(req.body);
    const user = await User.findByIdAndUpdate(req.params.id, { status }, { new: true }).select('-password');
    if (!user) throw new ApiError(404, 'User not found');
    res.json({ success: true, data: user });
  })
);

router.put(
  '/users/:id/wallet-adjust',
  requireAdminAuth,
  requirePermission('wallet.adjust'),
  audit('wallet.adjust', 'User'),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        wallet: z.enum(['video', 'social']),
        amount: z.number().positive(),
        type: z.enum(['credit', 'debit']),
        reason: z.string().min(3),
      })
      .parse(req.body);
    const user = await User.findById(req.params.id);
    if (!user) throw new ApiError(404, 'User not found');
    const { balance } = await applyLedger({
      userId: user._id,
      wallet: data.wallet,
      type: data.type,
      amount: data.amount,
      reason: 'admin_adjustment',
      note: data.reason,
      createdBy: req.admin!._id,
    });
    res.json({ success: true, data: { balance } });
  })
);

// ---- Admin ledger (fully dynamic) ----
router.get(
  '/ledger',
  requireAdminAuth,
  requirePermission('wallet.read'),
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        wallet: z.enum(['video', 'social']).optional(),
        type: z.enum(['credit', 'debit']).optional(),
        reason: z.string().max(60).optional(),
        search: z.string().max(200).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(req.query);

    const filter: Record<string, unknown> = {};
    if (q.wallet) filter.wallet = q.wallet;
    if (q.type) filter.type = q.type;
    if (q.reason) filter.reason = q.reason;
    if (q.search) {
      const rx = new RegExp(q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const users = await User.find({ $or: [{ name: rx }, { email: rx }, { referralCode: rx }] }).select('_id').limit(1000).lean();
      filter.user = { $in: users.map((u) => u._id) };
    }

    const skip = (q.page - 1) * q.limit;
    const [entries, total] = await Promise.all([
      LedgerEntry.find(filter)
        .populate('user', 'name email referralCode')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(q.limit)
        .lean(),
      LedgerEntry.countDocuments(filter),
    ]);
    res.json({ success: true, data: { entries, total, page: q.page, pages: Math.ceil(total / q.limit) } });
  })
);

router.get(
  '/ledger-stats',
  requireAdminAuth,
  requirePermission('wallet.read'),
  asyncHandler(async (_req, res) => {
    const since7 = new Date();
    since7.setHours(0, 0, 0, 0);
    since7.setDate(since7.getDate() - 6);

    const [outstanding, creditByWallet, debitByWallet, totalEntries, flow7Raw, byReasonRaw] = await Promise.all([
      Wallet.aggregate([{ $group: { _id: '$wallet', total: { $sum: '$balance' } } }]),
      LedgerEntry.aggregate([{ $match: { type: 'credit' } }, { $group: { _id: '$wallet', total: { $sum: '$amount' } } }]),
      LedgerEntry.aggregate([{ $match: { type: 'debit' } }, { $group: { _id: '$wallet', total: { $sum: '$amount' } } }]),
      LedgerEntry.countDocuments({}),
      LedgerEntry.aggregate([
        { $match: { createdAt: { $gte: since7 } } },
        {
          $group: {
            _id: { date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, type: '$type' },
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
      ]),
      LedgerEntry.aggregate([
        { $group: { _id: { reason: '$reason', type: '$type' }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: 8 },
      ]),
    ]);

    const byWallet = (rows: Array<{ _id: string; total: number }>) => {
      const out = { video: 0, social: 0 };
      for (const r of rows) if (r._id === 'video') out.video = r.total; else if (r._id === 'social') out.social = r.total;
      return out;
    };
    const outstandingBy = byWallet(outstanding as Array<{ _id: string; total: number }>);
    const creditsBy = byWallet(creditByWallet as Array<{ _id: string; total: number }>);
    const debitsBy = byWallet(debitByWallet as Array<{ _id: string; total: number }>);

    const flowMap = new Map<string, { credits: number; debits: number; creditCount: number; debitCount: number }>();
    for (const row of flow7Raw as Array<{ _id: { date: string; type: string }; total: number; count: number }>) {
      const e = flowMap.get(row._id.date) ?? { credits: 0, debits: 0, creditCount: 0, debitCount: 0 };
      if (row._id.type === 'credit') { e.credits = row.total; e.creditCount = row.count; }
      else { e.debits = row.total; e.debitCount = row.count; }
      flowMap.set(row._id.date, e);
    }
    const days = Array.from({ length: 7 }, (_, i) => {
      const key = new Date(since7.getTime() + i * 864e5).toISOString().slice(0, 10);
      const e = flowMap.get(key);
      return { date: key, credits: e?.credits ?? 0, debits: e?.debits ?? 0, creditCount: e?.creditCount ?? 0, debitCount: e?.debitCount ?? 0 };
    });

    const byReason = (byReasonRaw as Array<{ _id: { reason: string; type: string }; total: number; count: number }>)
      .map((r) => ({ reason: r._id.reason, type: r._id.type, total: r.total, count: r.count }));

    res.json({
      success: true,
      data: {
        totals: {
          outstanding: outstandingBy.video + outstandingBy.social,
          outstandingVideo: outstandingBy.video,
          outstandingSocial: outstandingBy.social,
          credits: creditsBy.video + creditsBy.social,
          creditsVideo: creditsBy.video,
          creditsSocial: creditsBy.social,
          debits: debitsBy.video + debitsBy.social,
          debitsVideo: debitsBy.video,
          debitsSocial: debitsBy.social,
          entries: totalEntries,
        },
        days,
        byReason,
      },
    });
  })
);

// ---- Videos ----
router.get(
  '/videos',
  requireAdminAuth,
  requirePermission('content.read'),
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        status: z.enum(['draft', 'published', 'archived']).optional(),
        search: z.string().max(200).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      })
      .parse(req.query);
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.search) filter.title = new RegExp(q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const skip = (q.page - 1) * q.limit;
    const [videos, total, countsRaw] = await Promise.all([
      Video.find(filter).populate('category', 'name').sort({ createdAt: -1 }).skip(skip).limit(q.limit),
      Video.countDocuments(filter),
      Video.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    ]);
    const counts: Record<string, number> = { draft: 0, published: 0, archived: 0 };
    for (const c of countsRaw as Array<{ _id: string; count: number }>) counts[c._id] = c.count;
    res.json({ success: true, data: { videos, total, page: q.page, pages: Math.ceil(total / q.limit), counts } });
  })
);

router.post(
  '/videos',
  requireAdminAuth,
  requirePermission('content.manage'),
  audit('video.create', 'Video'),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        title: z.string().min(1),
        description: z.string().optional(),
        url: z.string().url(),
        thumbnail: z.string().url(),
        category: z.string(),
        duration: z.number().optional(),
        rewardCoins: z.number().min(0).default(0),
        rewardWallet: z.enum(['video', 'social']).default('video'),
        status: z.enum(['draft', 'published', 'archived']).default('draft'),
        isFeatured: z.boolean().default(false),
        isTrending: z.boolean().default(false),
      })
      .parse(req.body);
    const video = await Video.create({ ...data, createdBy: req.admin!._id });
    res.status(201).json({ success: true, data: video });
  })
);

router.put(
  '/videos/:id',
  requireAdminAuth,
  requirePermission('content.manage'),
  audit('video.update', 'Video'),
  asyncHandler(async (req, res) => {
    const video = await Video.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!video) throw new ApiError(404, 'Video not found');
    res.json({ success: true, data: video });
  })
);

router.delete(
  '/videos/:id',
  requireAdminAuth,
  requirePermission('content.manage'),
  audit('video.delete', 'Video'),
  asyncHandler(async (req, res) => {
    const video = await Video.findByIdAndDelete(req.params.id);
    if (!video) throw new ApiError(404, 'Video not found');
    res.json({ success: true, message: 'Video deleted' });
  })
);

// ---- Content stats ----
router.get(
  '/content-stats',
  requireAdminAuth,
  requirePermission('content.read'),
  asyncHandler(async (_req, res) => {
    const since7 = new Date();
    since7.setHours(0, 0, 0, 0);
    since7.setDate(since7.getDate() - 6);

    const [statusAgg, featured, trending, created7Raw, catAgg, bannersActive, bannersTotal, adsAgg, topCatRaw] = await Promise.all([
      Video.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      Video.countDocuments({ isFeatured: true }),
      Video.countDocuments({ isTrending: true }),
      Video.aggregate([
        { $match: { createdAt: { $gte: since7 } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      ]),
      Category.aggregate([{ $group: { _id: '$isActive', count: { $sum: 1 } } }]),
      Banner.countDocuments({ isActive: true }),
      Banner.countDocuments({}),
      AdPlacement.aggregate([{ $group: { _id: '$enabled', count: { $sum: 1 } } }]),
      Video.aggregate([
        { $match: { category: { $ne: null } } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
        { $lookup: { from: 'categories', localField: '_id', foreignField: '_id', as: 'c' } },
        { $unwind: { path: '$c', preserveNullAndEmptyArrays: true } },
        { $project: { count: 1, name: '$c.name' } },
      ]),
    ]);

    const statusMap: Record<string, number> = { draft: 0, published: 0, archived: 0 };
    for (const r of statusAgg as Array<{ _id: string; count: number }>) statusMap[r._id] = r.count;
    const catMap: Record<string, number> = { active: 0, inactive: 0 };
    for (const r of catAgg as Array<{ _id: boolean; count: number }>) catMap[r._id ? 'active' : 'inactive'] = r.count;
    const adsMap: Record<string, number> = { enabled: 0, disabled: 0 };
    for (const r of adsAgg as Array<{ _id: boolean; count: number }>) adsMap[r._id ? 'enabled' : 'disabled'] = r.count;

    const flowMap = new Map((created7Raw as Array<{ _id: string; count: number }>).map((r) => [r._id, r.count]));
    const days = Array.from({ length: 7 }, (_, i) => {
      const key = new Date(since7.getTime() + i * 864e5).toISOString().slice(0, 10);
      return { date: key, created: flowMap.get(key) ?? 0 };
    });

    res.json({
      success: true,
      data: {
        totals: {
          videos: statusMap.draft + statusMap.published + statusMap.archived,
          published: statusMap.published,
          draft: statusMap.draft,
          archived: statusMap.archived,
          featured,
          trending,
          categoriesActive: catMap.active,
          categoriesInactive: catMap.inactive,
          bannersActive,
          bannersTotal,
          adsEnabled: adsMap.enabled,
          adsTotal: adsMap.enabled + adsMap.disabled,
        },
        days,
        topCategories: (topCatRaw as Array<{ _id: string | null; count: number; name?: string }>).map((r) => ({
          categoryId: r._id,
          name: r.name ?? 'Uncategorized',
          count: r.count,
        })),
      },
    });
  })
);

// ---- Categories (admin) ----
const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'category';
async function uniqueSlug(base: string, excludeId?: string) {
  let slug = base;
  for (let i = 2; i < 50; i++) {
    const existing = await Category.findOne({ slug, ...(excludeId ? { _id: { $ne: excludeId } } : {}) });
    if (!existing) return slug;
    slug = `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

router.get(
  '/categories',
  requireAdminAuth,
  requirePermission('content.read'),
  asyncHandler(async (_req, res) => {
    const [categories, countRaw] = await Promise.all([
      Category.find().sort({ order: 1, name: 1 }).lean(),
      Video.aggregate([
        { $match: { category: { $ne: null } } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
      ]),
    ]);
    const counts = new Map((countRaw as Array<{ _id: string; count: number }>).map((r) => [String(r._id), r.count]));
    res.json({
      success: true,
      data: { categories: categories.map((c) => ({ ...c, videoCount: counts.get(String(c._id)) ?? 0 })) },
    });
  })
);

router.post(
  '/categories',
  requireAdminAuth,
  requirePermission('content.manage'),
  audit('category.create', 'Category'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(2).max(80),
        icon: z.string().max(10).optional(),
        order: z.number().int().min(0).max(9999).optional(),
        isActive: z.boolean().optional(),
      })
      .parse(req.body);
    const slug = await uniqueSlug(slugify(body.name));
    const category = await Category.create({ ...body, slug });
    res.status(201).json({ success: true, data: category });
  })
);

router.put(
  '/categories/:id',
  requireAdminAuth,
  requirePermission('content.manage'),
  audit('category.update', 'Category'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(2).max(80).optional(),
        icon: z.string().max(10).optional(),
        order: z.number().int().min(0).max(9999).optional(),
        isActive: z.boolean().optional(),
      })
      .parse(req.body);
    const existing = await Category.findById(req.params.id);
    if (!existing) throw new ApiError(404, 'Category not found');
    if (body.name && body.name !== existing.name) existing.slug = await uniqueSlug(slugify(body.name), String(existing._id));
    if (body.icon !== undefined) existing.icon = body.icon;
    if (body.order !== undefined) existing.order = body.order;
    if (body.isActive !== undefined) existing.isActive = body.isActive;
    if (body.name !== undefined) existing.name = body.name;
    await existing.save();
    res.json({ success: true, data: existing });
  })
);

router.delete(
  '/categories/:id',
  requireAdminAuth,
  requirePermission('content.manage'),
  audit('category.delete', 'Category'),
  asyncHandler(async (req, res) => {
    const videos = await Video.countDocuments({ category: req.params.id });
    if (videos > 0) throw new ApiError(400, `Cannot delete — ${videos} video(s) use this category`);
    const category = await Category.findByIdAndDelete(req.params.id);
    if (!category) throw new ApiError(404, 'Category not found');
    res.json({ success: true, data: { _id: category._id } });
  })
);

// ---- Banners (admin) ----
router.get(
  '/banners',
  requireAdminAuth,
  requirePermission('content.read'),
  asyncHandler(async (_req, res) => {
    const banners = await Banner.find().sort({ order: 1, createdAt: -1 }).lean();
    res.json({ success: true, data: { banners } });
  })
);

router.post(
  '/banners',
  requireAdminAuth,
  requirePermission('content.manage'),
  audit('banner.create', 'Banner'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        title: z.string().min(2).max(200),
        imageUrl: z.string().url(),
        targetUrl: z.string().url().optional(),
        order: z.number().int().min(0).max(9999).optional(),
        isActive: z.boolean().optional(),
        startsAt: z.coerce.date().optional(),
        endsAt: z.coerce.date().optional(),
      })
      .parse(req.body);
    const banner = await Banner.create(body);
    res.status(201).json({ success: true, data: banner });
  })
);

router.put(
  '/banners/:id',
  requireAdminAuth,
  requirePermission('content.manage'),
  audit('banner.update', 'Banner'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        title: z.string().min(2).max(200).optional(),
        imageUrl: z.string().url().optional(),
        targetUrl: z.string().url().optional(),
        order: z.number().int().min(0).max(9999).optional(),
        isActive: z.boolean().optional(),
        startsAt: z.coerce.date().optional(),
        endsAt: z.coerce.date().optional(),
      })
      .parse(req.body);
    const banner = await Banner.findByIdAndUpdate(req.params.id, body, { new: true });
    if (!banner) throw new ApiError(404, 'Banner not found');
    res.json({ success: true, data: banner });
  })
);

router.delete(
  '/banners/:id',
  requireAdminAuth,
  requirePermission('content.manage'),
  audit('banner.delete', 'Banner'),
  asyncHandler(async (req, res) => {
    const banner = await Banner.findByIdAndDelete(req.params.id);
    if (!banner) throw new ApiError(404, 'Banner not found');
    res.json({ success: true, data: { _id: banner._id } });
  })
);

// ---- Ad placements (admin) ----
const DEFAULT_PLACEMENTS = [
  { name: 'Home Banner', format: 'banner', placementKey: 'banner_home' },
  { name: 'Feed Interstitial', format: 'interstitial', placementKey: 'interstitial_feed' },
  { name: 'Rewarded Video', format: 'rewarded', placementKey: 'rewarded_video' },
] as const;

router.get(
  '/ad-placements',
  requireAdminAuth,
  requirePermission('ads.read'),
  asyncHandler(async (_req, res) => {
    if ((await AdPlacement.countDocuments({})) === 0) await AdPlacement.insertMany(DEFAULT_PLACEMENTS);
    const placements = await AdPlacement.find().sort({ placementKey: 1 }).lean();
    res.json({ success: true, data: { placements } });
  })
);

router.put(
  '/ad-placements/:id',
  requireAdminAuth,
  requirePermission('ads.manage'),
  audit('ad_placement.update', 'AdPlacement'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        enabled: z.boolean().optional(),
        frequencyCap: z.number().int().min(0).max(1000).optional(),
        network: z.string().max(40).optional(),
        unitId: z.string().max(120).optional(),
        name: z.string().min(2).max(80).optional(),
      })
      .parse(req.body);
    const placement = await AdPlacement.findByIdAndUpdate(req.params.id, body, { new: true });
    if (!placement) throw new ApiError(404, 'Placement not found');
    res.json({ success: true, data: placement });
  })
);

// ---- Tasks ----
router.get(
  '/tasks',
  requireAdminAuth,
  requirePermission('tasks.read'),
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        status: z.enum(['draft', 'active', 'paused', 'completed']).optional(),
        search: z.string().max(200).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      })
      .parse(req.query);
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.search) filter.title = new RegExp(q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const skip = (q.page - 1) * q.limit;
    const [tasks, total, countsRaw, subsRaw] = await Promise.all([
      Task.find(filter).sort({ createdAt: -1 }).skip(skip).limit(q.limit),
      Task.countDocuments(filter),
      Task.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      TaskSubmission.aggregate([
        { $group: { _id: { task: '$task', status: '$status' }, count: { $sum: 1 } } },
      ]),
    ]);
    const counts: Record<string, number> = { draft: 0, active: 0, paused: 0, completed: 0 };
    for (const c of countsRaw as Array<{ _id: string; count: number }>) counts[c._id] = c.count;
    const byTask: Record<string, Record<string, number>> = {};
    for (const c of subsRaw as Array<{ _id: { task: string; status: string }; count: number }>) {
      const k = String(c._id.task);
      byTask[k] = byTask[k] ?? { pending: 0, approved: 0, rejected: 0, total: 0 };
      byTask[k][c._id.status] = c.count;
      byTask[k].total += c.count;
    }
    res.json({
      success: true,
      data: {
        tasks: tasks.map((t) => ({ ...t.toObject(), submissions: byTask[String(t._id)] ?? { pending: 0, approved: 0, rejected: 0, total: 0 } })),
        total,
        page: q.page,
        pages: Math.ceil(total / q.limit),
        counts,
      },
    });
  })
);

router.post(
  '/tasks',
  requireAdminAuth,
  requirePermission('tasks.read'),
  audit('task.create', 'Task'),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        title: z.string().min(1),
        description: z.string().min(1),
        instructions: z.string().optional(),
        proofType: z.enum(['screenshot', 'url', 'text']),
        rewardCoins: z.number().min(1),
        rewardWallet: z.enum(['video', 'social']).default('social'),
        totalSlots: z.number().optional(),
        status: z.enum(['draft', 'active', 'paused']).default('draft'),
        eligibility: z
          .object({ minLevel: z.number().int().min(0).optional(), requiresKyc: z.boolean().optional(), maxSubmissions: z.number().int().min(1).optional() })
          .optional(),
        startsAt: z.coerce.date().optional(),
        endsAt: z.coerce.date().optional(),
      })
      .parse(req.body);
    const task = await Task.create({ ...data, createdBy: req.admin!._id });
    res.status(201).json({ success: true, data: task });
  })
);

router.put(
  '/tasks/:id',
  requireAdminAuth,
  requirePermission('tasks.read'),
  audit('task.update', 'Task'),
  asyncHandler(async (req, res) => {
    const task = await Task.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!task) throw new ApiError(404, 'Task not found');
    res.json({ success: true, data: task });
  })
);

router.delete(
  '/tasks/:id',
  requireAdminAuth,
  requirePermission('tasks.read'),
  audit('task.delete', 'Task'),
  asyncHandler(async (req, res) => {
    const submissions = await TaskSubmission.countDocuments({ task: req.params.id });
    if (submissions > 0) throw new ApiError(400, `Cannot delete — ${submissions} submission(s) exist. Pause it instead.`);
    const task = await Task.findByIdAndDelete(req.params.id);
    if (!task) throw new ApiError(404, 'Task not found');
    res.json({ success: true, data: { _id: task._id } });
  })
);

router.get(
  '/task-stats',
  requireAdminAuth,
  requirePermission('tasks.read'),
  asyncHandler(async (_req, res) => {
    const since7 = new Date();
    since7.setHours(0, 0, 0, 0);
    since7.setDate(since7.getDate() - 6);

    const [statusAgg, redAgg, flow7Raw, coinsPaidRaw, topRaw] = await Promise.all([
      Task.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      TaskSubmission.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      TaskSubmission.aggregate([
        { $match: { createdAt: { $gte: since7 } } },
        { $group: { _id: { date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, status: '$status' }, count: { $sum: 1 } } },
      ]),
      TaskSubmission.aggregate([
        { $match: { status: 'approved' } },
        { $lookup: { from: 'tasks', localField: 'task', foreignField: '_id', as: 't' } },
        { $unwind: { path: '$t' } },
        { $group: { _id: null, coins: { $sum: '$t.rewardCoins' }, count: { $sum: 1 } } },
      ]),
      TaskSubmission.aggregate([
        { $group: { _id: '$task', count: { $sum: 1 }, pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
        { $lookup: { from: 'tasks', localField: '_id', foreignField: '_id', as: 't' } },
        { $unwind: { path: '$t', preserveNullAndEmptyArrays: true } },
        { $project: { count: 1, pending: 1, title: '$t.title', rewardCoins: '$t.rewardCoins' } },
      ]),
    ]);

    const taskMap: Record<string, number> = { draft: 0, active: 0, paused: 0, completed: 0 };
    for (const r of statusAgg as Array<{ _id: string; count: number }>) taskMap[r._id] = r.count;
    const redMap: Record<string, number> = { pending: 0, approved: 0, rejected: 0 };
    for (const r of redAgg as Array<{ _id: string; count: number }>) redMap[r._id] = r.count;

    const flowMap = new Map<string, { pending: number; approved: number; rejected: number }>();
    for (const row of flow7Raw as Array<{ _id: { date: string; status: string }; count: number }>) {
      const e = flowMap.get(row._id.date) ?? { pending: 0, approved: 0, rejected: 0 };
      e[row._id.status as 'pending' | 'approved' | 'rejected'] = row.count;
      flowMap.set(row._id.date, e);
    }
    const days = Array.from({ length: 7 }, (_, i) => {
      const key = new Date(since7.getTime() + i * 864e5).toISOString().slice(0, 10);
      const e = flowMap.get(key);
      return { date: key, pending: e?.pending ?? 0, approved: e?.approved ?? 0, rejected: e?.rejected ?? 0 };
    });

    const totalSubs = redMap.pending + redMap.approved + redMap.rejected;
    const reviewed = redMap.approved + redMap.rejected;

    res.json({
      success: true,
      data: {
        totals: {
          tasks: taskMap.draft + taskMap.active + taskMap.paused + taskMap.completed,
          active: taskMap.active,
          draft: taskMap.draft,
          paused: taskMap.paused,
          completed: taskMap.completed,
          pending: redMap.pending,
          approved: redMap.approved,
          rejected: redMap.rejected,
          totalSubmissions: totalSubs,
          approvalRate: reviewed === 0 ? 0 : Math.round((redMap.approved / reviewed) * 100),
          coinsPaid: (coinsPaidRaw as Array<{ _id: null; coins: number }>)[0]?.coins ?? 0,
        },
        days,
        topTasks: (topRaw as Array<{ _id: string | null; count: number; pending: number; title?: string; rewardCoins?: number }>).map((r) => ({
          taskId: r._id,
          title: r.title ?? 'Deleted task',
          rewardCoins: r.rewardCoins ?? 0,
          count: r.count,
          pending: r.pending,
        })),
      },
    });
  })
);

// ---- Task submissions ----
router.get(
  '/task-submissions',
  requireAdminAuth,
  requirePermission('tasks.verify'),
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        status: z.enum(['pending', 'approved', 'rejected']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      })
      .parse(req.query);
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    const skip = (q.page - 1) * q.limit;
    const [submissions, total, countsRaw] = await Promise.all([
      TaskSubmission.find(filter)
        .populate('task', 'title rewardCoins rewardWallet proofType')
        .populate('user', 'name email referralCode')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(q.limit),
      TaskSubmission.countDocuments(filter),
      TaskSubmission.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    ]);
    const counts: Record<string, number> = { pending: 0, approved: 0, rejected: 0 };
    for (const c of countsRaw as Array<{ _id: string; count: number }>) counts[c._id] = c.count;
    res.json({ success: true, data: { submissions, total, page: q.page, pages: Math.ceil(total / q.limit), counts } });
  })
);

router.put(
  '/task-submissions/:id',
  requireAdminAuth,
  requirePermission('tasks.verify'),
  audit('task_submission.review', 'TaskSubmission'),
  asyncHandler(async (req, res) => {
    const { status, rejectionReason } = z
      .object({ status: z.enum(['approved', 'rejected']), rejectionReason: z.string().optional() })
      .parse(req.body);
    const submission = await TaskSubmission.findById(req.params.id).populate('task');
    if (!submission) throw new ApiError(404, 'Submission not found');
    if (submission.status !== 'pending') throw new ApiError(400, 'Already reviewed');
    const task = submission.task as unknown as { rewardCoins: number; rewardWallet: 'video' | 'social' };

    submission.status = status;
    submission.reviewedBy = req.admin!._id;
    submission.reviewedAt = new Date();
    if (status === 'rejected') submission.rejectionReason = rejectionReason;
    await submission.save();

    if (status === 'approved' && task.rewardCoins > 0) {
      await applyLedger({
        userId: submission.user,
        wallet: task.rewardWallet,
        type: 'credit',
        amount: task.rewardCoins,
        reason: 'task_reward',
        refModel: 'TaskSubmission',
        refId: submission._id,
        createdBy: req.admin!._id,
      });
    }
    res.json({ success: true, data: submission });
  })
);

// ---- Withdrawals ----
router.get(
  '/withdrawals',
  requireAdminAuth,
  requirePermission('finance.read'),
  asyncHandler(async (req, res) => {
    const { status, page = 1, limit = 20 } = req.query;
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    const skip = (Number(page) - 1) * Number(limit);
    const [withdrawals, total, countsRaw] = await Promise.all([
      Withdrawal.find(filter).populate('user', 'name email mobile').sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
      Withdrawal.countDocuments(filter),
      Withdrawal.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    ]);
    const counts: Record<string, number> = { pending: 0, approved: 0, paid: 0, rejected: 0 };
    for (const c of countsRaw as Array<{ _id: string; count: number }>) counts[c._id] = c.count;
    res.json({ success: true, data: { withdrawals, total, page: Number(page), pages: Math.ceil(total / Number(limit)), counts } });
  })
);

router.put(
  '/withdrawals/:id',
  requireAdminAuth,
  requirePermission('finance.approve'),
  audit('withdrawal.review', 'Withdrawal'),
  asyncHandler(async (req, res) => {
    const { status, rejectionReason, paymentRef } = z
      .object({ status: z.enum(['approved', 'rejected', 'paid']), rejectionReason: z.string().optional(), paymentRef: z.string().optional() })
      .parse(req.body);
    const withdrawal = await Withdrawal.findById(req.params.id);
    if (!withdrawal) throw new ApiError(404, 'Withdrawal not found');
    if (withdrawal.status !== 'pending' && !(withdrawal.status === 'approved' && status === 'paid'))
      throw new ApiError(400, 'Invalid status transition');

    if (status === 'rejected') {
      // refund
      await applyLedger({
        userId: withdrawal.user,
        wallet: withdrawal.wallet,
        type: 'credit',
        amount: withdrawal.amount,
        reason: 'admin_adjustment',
        refModel: 'Withdrawal',
        refId: withdrawal._id,
        note: 'Withdrawal rejected — refund',
        createdBy: req.admin!._id,
      });
    }

    withdrawal.status = status;
    withdrawal.reviewedBy = req.admin!._id;
    withdrawal.reviewedAt = new Date();
    if (rejectionReason) withdrawal.rejectionReason = rejectionReason;
    if (paymentRef) withdrawal.paymentRef = paymentRef;
    await withdrawal.save();
    res.json({ success: true, data: withdrawal });
  })
);

// ---- Deposits ----
router.get(
  '/deposits',
  requireAdminAuth,
  requirePermission('finance.read'),
  asyncHandler(async (req, res) => {
    const { status, page = 1, limit = 20 } = req.query;
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    const skip = (Number(page) - 1) * Number(limit);
    const [deposits, total, countsRaw] = await Promise.all([
      Deposit.find(filter).populate('user', 'name email').sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
      Deposit.countDocuments(filter),
      Deposit.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    ]);
    const counts: Record<string, number> = { pending: 0, completed: 0, failed: 0 };
    for (const c of countsRaw as Array<{ _id: string; count: number }>) counts[c._id] = c.count;
    res.json({ success: true, data: { deposits, total, page: Number(page), pages: Math.ceil(total / Number(limit)), counts } });
  })
);

router.get(
  '/finance-stats',
  requireAdminAuth,
  requirePermission('finance.read'),
  asyncHandler(async (_req, res) => {
    const since7 = new Date();
    since7.setHours(0, 0, 0, 0);
    since7.setDate(since7.getDate() - 6);

    const [wdAgg, dpAgg, wdFlow, dpFlow, wdByMethod, wdByWallet, dpByGateway] = await Promise.all([
      Withdrawal.aggregate([
        { $group: { _id: { status: '$status' }, count: { $sum: 1 }, sum: { $sum: '$amount' } } },
      ]),
      Deposit.aggregate([
        { $group: { _id: { status: '$status' }, count: { $sum: 1 }, sum: { $sum: '$amount' } } },
      ]),
      Withdrawal.aggregate([
        { $match: { status: 'paid', createdAt: { $gte: since7 } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 }, sum: { $sum: '$amount' } } },
      ]),
      Deposit.aggregate([
        { $match: { status: 'completed', createdAt: { $gte: since7 } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 }, sum: { $sum: '$amount' } } },
      ]),
      Withdrawal.aggregate([
        { $match: { status: { $in: ['pending', 'approved', 'paid'] } } },
        { $group: { _id: '$method', count: { $sum: 1 }, sum: { $sum: '$amount' } } },
        { $sort: { sum: -1 } },
      ]),
      Withdrawal.aggregate([
        { $group: { _id: '$wallet', count: { $sum: 1 }, sum: { $sum: '$amount' } } },
      ]),
      Deposit.aggregate([
        { $group: { _id: '$gateway', count: { $sum: 1 }, sum: { $sum: '$amount' } } },
        { $sort: { sum: -1 } },
      ]),
    ]);

    const wdMap: Record<string, { count: number; sum: number }> = {};
    for (const r of wdAgg as Array<{ _id: { status: string }; count: number; sum: number }>)
      wdMap[r._id.status] = { count: r.count, sum: r.sum };
    const dpMap: Record<string, { count: number; sum: number }> = {};
    for (const r of dpAgg as Array<{ _id: { status: string }; count: number; sum: number }>)
      dpMap[r._id.status] = { count: r.count, sum: r.sum };

    const wdFlowMap = new Map((wdFlow as Array<{ _id: string; count: number; sum: number }>).map((r) => [r._id, r]));
    const dpFlowMap = new Map((dpFlow as Array<{ _id: string; count: number; sum: number }>).map((r) => [r._id, r]));
    const days = Array.from({ length: 7 }, (_, i) => {
      const key = new Date(since7.getTime() + i * 864e5).toISOString().slice(0, 10);
      return {
        date: key,
        paid: wdFlowMap.get(key)?.sum ?? 0,
        paidCount: wdFlowMap.get(key)?.count ?? 0,
        deposits: dpFlowMap.get(key)?.sum ?? 0,
        depositCount: dpFlowMap.get(key)?.count ?? 0,
      };
    });

    res.json({
      success: true,
      data: {
        withdrawals: {
          pending: wdMap.pending ?? { count: 0, sum: 0 },
          approved: wdMap.approved ?? { count: 0, sum: 0 },
          paid: wdMap.paid ?? { count: 0, sum: 0 },
          rejected: wdMap.rejected ?? { count: 0, sum: 0 },
          inflight: (wdMap.pending?.sum ?? 0) + (wdMap.approved?.sum ?? 0),
          inflightCount: (wdMap.pending?.count ?? 0) + (wdMap.approved?.count ?? 0),
        },
        deposits: {
          pending: dpMap.pending ?? { count: 0, sum: 0 },
          completed: dpMap.completed ?? { count: 0, sum: 0 },
          failed: dpMap.failed ?? { count: 0, sum: 0 },
        },
        days,
        byMethod: (wdByMethod as Array<{ _id: string; count: number; sum: number }>).map((r) => ({ method: r._id, count: r.count, sum: r.sum })),
        byWallet: (wdByWallet as Array<{ _id: string; count: number; sum: number }>).map((r) => ({ wallet: r._id, count: r.count, sum: r.sum })),
        byGateway: (dpByGateway as Array<{ _id: string; count: number; sum: number }>).map((r) => ({ gateway: r._id, count: r.count, sum: r.sum })),
      },
    });
  })
);

router.put(
  '/deposits/:id',
  requireAdminAuth,
  requirePermission('finance.approve'),
  audit('deposit.review', 'Deposit'),
  asyncHandler(async (req, res) => {
    const { status, gatewayRef } = z.object({ status: z.enum(['completed', 'failed']), gatewayRef: z.string().optional() }).parse(req.body);
    const deposit = await Deposit.findById(req.params.id);
    if (!deposit) throw new ApiError(404, 'Deposit not found');
    if (deposit.status !== 'pending') throw new ApiError(400, 'Already processed');
    deposit.status = status;
    if (gatewayRef) deposit.gatewayRef = gatewayRef;
    await deposit.save();
    if (status === 'completed') {
      await applyLedger({
        userId: deposit.user,
        wallet: 'social',
        type: 'credit',
        amount: deposit.amount,
        reason: 'deposit',
        refModel: 'Deposit',
        refId: deposit._id,
        createdBy: req.admin!._id,
      });
    }
    res.json({ success: true, data: deposit });
  })
);

// ---- Vouchers ----
router.get(
  '/vouchers',
  requireAdminAuth,
  requirePermission('vouchers.read'),
  asyncHandler(async (_req, res) => {
    const [vouchers, countsRaw] = await Promise.all([
      Voucher.find().sort({ createdAt: -1 }).lean(),
      VoucherRedemption.aggregate([{ $group: { _id: { voucher: '$voucher', status: '$status' }, count: { $sum: 1 } } }]),
    ]);
    const byVoucher: Record<string, Record<string, number>> = {};
    for (const c of countsRaw as Array<{ _id: { voucher: string; status: string }; count: number }>) {
      const k = String(c._id.voucher);
      byVoucher[k] = byVoucher[k] ?? { pending: 0, fulfilled: 0, failed: 0, total: 0 };
      byVoucher[k][c._id.status] = c.count;
      byVoucher[k].total += c.count;
    }
    res.json({ success: true, data: { vouchers: vouchers.map((v) => ({ ...v, redemptions: byVoucher[String(v._id)] ?? { pending: 0, fulfilled: 0, failed: 0, total: 0 } })) } });
  })
);

router.post(
  '/vouchers',
  requireAdminAuth,
  requirePermission('vouchers.manage'),
  audit('voucher.create', 'Voucher'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        title: z.string().min(2).max(200),
        description: z.string().max(1000).optional(),
        provider: z.string().min(2).max(60),
        coinCost: z.number().int().min(1).max(1_000_000_00),
        faceValue: z.number().min(0).max(1_000_000_00).optional(),
        stock: z.number().int().min(0).max(1_000_000).optional(),
        isActive: z.boolean().optional(),
      })
      .parse(req.body);
    const voucher = await Voucher.create(body);
    res.status(201).json({ success: true, data: voucher });
  })
);

router.put(
  '/vouchers/:id',
  requireAdminAuth,
  requirePermission('vouchers.manage'),
  audit('voucher.update', 'Voucher'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        title: z.string().min(2).max(200).optional(),
        description: z.string().max(1000).optional(),
        provider: z.string().min(2).max(60).optional(),
        coinCost: z.number().int().min(1).max(1_000_000_00).optional(),
        faceValue: z.number().min(0).max(1_000_000_00).optional(),
        stock: z.number().int().min(0).max(1_000_000).optional(),
        isActive: z.boolean().optional(),
      })
      .parse(req.body);
    const voucher = await Voucher.findByIdAndUpdate(req.params.id, body, { new: true });
    if (!voucher) throw new ApiError(404, 'Voucher not found');
    res.json({ success: true, data: voucher });
  })
);

router.patch(
  '/vouchers/:id/toggle',
  requireAdminAuth,
  requirePermission('vouchers.manage'),
  audit('voucher.toggle', 'Voucher'),
  asyncHandler(async (req, res) => {
    const voucher = await Voucher.findById(req.params.id);
    if (!voucher) throw new ApiError(404, 'Voucher not found');
    voucher.isActive = !voucher.isActive;
    await voucher.save();
    res.json({ success: true, data: voucher });
  })
);

router.delete(
  '/vouchers/:id',
  requireAdminAuth,
  requirePermission('vouchers.manage'),
  audit('voucher.delete', 'Voucher'),
  asyncHandler(async (req, res) => {
    const redemptions = await VoucherRedemption.countDocuments({ voucher: req.params.id });
    if (redemptions > 0) throw new ApiError(400, 'Cannot delete — redemptions exist. Disable it instead.');
    const voucher = await Voucher.findByIdAndDelete(req.params.id);
    if (!voucher) throw new ApiError(404, 'Voucher not found');
    res.json({ success: true, data: { _id: voucher._id } });
  })
);

router.get(
  '/voucher-redemptions',
  requireAdminAuth,
  requirePermission('vouchers.read'),
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        status: z.enum(['pending', 'fulfilled', 'failed']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(req.query);
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    const skip = (q.page - 1) * q.limit;
    const [redemptions, total, countsRaw] = await Promise.all([
      VoucherRedemption.find(filter)
        .populate('user', 'name email referralCode')
        .populate('voucher', 'title provider coinCost faceValue')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(q.limit)
        .lean(),
      VoucherRedemption.countDocuments(filter),
      VoucherRedemption.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    ]);
    const counts: Record<string, number> = { pending: 0, fulfilled: 0, failed: 0 };
    for (const c of countsRaw as Array<{ _id: string; count: number }>) counts[c._id] = c.count;
    res.json({ success: true, data: { redemptions, total, page: q.page, pages: Math.ceil(total / q.limit), counts } });
  })
);

router.put(
  '/voucher-redemptions/:id',
  requireAdminAuth,
  requirePermission('vouchers.manage'),
  audit('voucher.redemption.review', 'VoucherRedemption'),
  asyncHandler(async (req, res) => {
    const { status, code } = z
      .object({ status: z.enum(['fulfilled', 'failed']), code: z.string().min(2).max(120).optional() })
      .parse(req.body);
    const redemption = await VoucherRedemption.findById(req.params.id).populate('voucher', 'title');
    if (!redemption) throw new ApiError(404, 'Redemption not found');
    if (redemption.status !== 'pending') throw new ApiError(400, 'Already processed');
    if (status === 'fulfilled' && !code) throw new ApiError(400, 'Voucher code required to fulfill');
    redemption.status = status;
    if (code) redemption.code = code;
    await redemption.save();
    res.json({ success: true, data: redemption });
  })
);

router.get(
  '/voucher-stats',
  requireAdminAuth,
  requirePermission('vouchers.read'),
  asyncHandler(async (_req, res) => {
    const since7 = new Date();
    since7.setHours(0, 0, 0, 0);
    since7.setDate(since7.getDate() - 6);

    const [pkgAgg, stockAgg, redAgg, flow7Raw, topRaw] = await Promise.all([
      Voucher.aggregate([{ $group: { _id: '$isActive', count: { $sum: 1 } } }]),
      Voucher.aggregate([{ $match: { isActive: true } }, { $group: { _id: null, stock: { $sum: { $ifNull: ['$stock', 0] } } } }]),
      VoucherRedemption.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      VoucherRedemption.aggregate([
        { $match: { createdAt: { $gte: since7 } } },
        { $group: { _id: { date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, status: '$status' }, count: { $sum: 1 } } },
      ]),
      VoucherRedemption.aggregate([
        { $group: { _id: '$voucher', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
        { $lookup: { from: 'vouchers', localField: '_id', foreignField: '_id', as: 'v' } },
        { $unwind: { path: '$v', preserveNullAndEmptyArrays: true } },
        { $project: { count: 1, title: '$v.title', coinCost: '$v.coinCost', provider: '$v.provider' } },
      ]),
    ]);

    const pkgMap: Record<string, number> = { active: 0, inactive: 0 };
    for (const r of pkgAgg as Array<{ _id: boolean; count: number }>) pkgMap[r._id ? 'active' : 'inactive'] = r.count;
    const redMap: Record<string, number> = { pending: 0, fulfilled: 0, failed: 0 };
    for (const r of redAgg as Array<{ _id: string; count: number }>) redMap[r._id] = r.count;

    const flowMap = new Map<string, { pending: number; fulfilled: number; failed: number }>();
    for (const row of flow7Raw as Array<{ _id: { date: string; status: string }; count: number }>) {
      const e = flowMap.get(row._id.date) ?? { pending: 0, fulfilled: 0, failed: 0 };
      e[row._id.status as 'pending' | 'fulfilled' | 'failed'] = row.count;
      flowMap.set(row._id.date, e);
    }
    const days = Array.from({ length: 7 }, (_, i) => {
      const key = new Date(since7.getTime() + i * 864e5).toISOString().slice(0, 10);
      const e = flowMap.get(key);
      return { date: key, pending: e?.pending ?? 0, fulfilled: e?.fulfilled ?? 0, failed: e?.failed ?? 0 };
    });

    res.json({
      success: true,
      data: {
        totals: {
          activePackages: pkgMap.active,
          inactivePackages: pkgMap.inactive,
          stock: (stockAgg as Array<{ _id: null; stock: number }>)[0]?.stock ?? 0,
          pending: redMap.pending,
          fulfilled: redMap.fulfilled,
          failed: redMap.failed,
          totalRedemptions: redMap.pending + redMap.fulfilled + redMap.failed,
        },
        days,
        topVouchers: (topRaw as Array<{ _id: string | null; count: number; title?: string; coinCost?: number; provider?: string }>).map((r) => ({
          voucherId: r._id,
          title: r.title ?? 'Deleted voucher',
          coinCost: r.coinCost ?? 0,
          provider: r.provider ?? '—',
          count: r.count,
        })),
      },
    });
  })
);

// ---- Referral config ----
router.get(
  '/referral-config',
  requireAdminAuth,
  requirePermission('referral.config'),
  asyncHandler(async (_req, res) => {
    let config = await ReferralConfig.findOne();
    if (!config) config = await ReferralConfig.create({ levelRewards: [] });
    res.json({ success: true, data: config });
  })
);

router.put(
  '/referral-config',
  requireAdminAuth,
  requirePermission('referral.config'),
  audit('referral.config_update', 'ReferralConfig'),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        maxLevels: z.number().min(1).max(10),
        levelRewards: z.array(z.object({ level: z.number().min(1).max(10), coins: z.number().min(0), wallet: z.enum(['video', 'social']) })),
        dailyJoinLimit: z.number().min(0),
        commissionEnabled: z.boolean(),
        commissionPercent: z.number().min(0).max(100),
      })
      .parse(req.body);
    let config = await ReferralConfig.findOne();
    if (!config) config = new ReferralConfig();
    Object.assign(config, data);
    await config.save();
    res.json({ success: true, data: config });
  })
);

// ---- Referral stats (admin, fully dynamic) ----
router.get(
  '/referral-stats',
  requireAdminAuth,
  requirePermission('referral.read'),
  asyncHandler(async (_req, res) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const since7 = new Date(today.getTime() - 6 * 864e5);

    const [
      referredUsers,
      referrerGroups,
      dailyJoins,
      rewardByWallet,
      commissionRaw,
      joins7dRaw,
      rewards7dRaw,
      byLevelRaw,
      topRaw,
      recentJoins,
    ] = await Promise.all([
      User.countDocuments({ referredBy: { $ne: null }, status: { $ne: 'deleted' } }),
      User.aggregate([
        { $match: { referredBy: { $ne: null }, status: { $ne: 'deleted' } } },
        { $group: { _id: '$referredBy' } },
        { $count: 'total' },
      ]),
      User.countDocuments({ referredBy: { $ne: null }, createdAt: { $gte: today } }),
      LedgerEntry.aggregate([
        { $match: { reason: 'referral_reward' } },
        { $group: { _id: '$wallet', total: { $sum: '$amount' } } },
      ]),
      LedgerEntry.aggregate([
        { $match: { reason: 'referral_commission' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      User.aggregate([
        { $match: { referredBy: { $ne: null }, createdAt: { $gte: since7 } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      ]),
      LedgerEntry.aggregate([
        { $match: { reason: 'referral_reward', createdAt: { $gte: since7 } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, coins: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      LedgerEntry.aggregate([
        { $match: { reason: 'referral_reward' } },
        { $group: { _id: '$note', users: { $sum: 1 }, coins: { $sum: '$amount' } } },
        { $sort: { _id: 1 } },
      ]),
      User.aggregate([
        { $match: { referredBy: { $ne: null }, status: { $ne: 'deleted' } } },
        { $group: { _id: '$referredBy', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
      User.find({ referredBy: { $ne: null } })
        .select('name referralCode status createdAt referredBy')
        .populate('referredBy', 'name referralCode')
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
    ]);

    const joinMap = new Map<string, number>((joins7dRaw as Array<{ _id: string; count: number }>).map((r) => [r._id, r.count]));
    const coinMap = new Map<string, { coins: number; count: number }>(
      (rewards7dRaw as Array<{ _id: string; coins: number; count: number }>).map((r) => [r._id, { coins: r.coins, count: r.count }])
    );
    const days = Array.from({ length: 7 }, (_, i) => {
      const key = new Date(since7.getTime() + i * 864e5).toISOString().slice(0, 10);
      return { date: key, joins: joinMap.get(key) ?? 0, coins: coinMap.get(key)?.coins ?? 0, rewards: coinMap.get(key)?.count ?? 0 };
    });

    const byLevel = (byLevelRaw as Array<{ _id: string | null; users: number; coins: number }>)
      .map((r): { level: number; users: number; coins: number } | null => {
        const match = /^Level (\d+) referral reward$/.exec(r._id ?? '');
        return match ? { level: Number(match[1]), users: r.users, coins: r.coins } : null;
      })
      .filter((x) => x !== null)
      .sort((a, b) => a.level - b.level);

    const topIds = (topRaw as Array<{ _id: unknown; count: number }>).map((t) => t._id);
    const [topUsers, topCoins] = await Promise.all([
      User.find({ _id: { $in: topIds } }).select('name referralCode').lean(),
      LedgerEntry.aggregate([
        { $match: { reason: 'referral_reward', user: { $in: topIds } } },
        { $group: { _id: '$user', coins: { $sum: '$amount' } } },
      ]),
    ]);
    const nameById = new Map(topUsers.map((u) => [String(u._id), u]));
    const coinsById = new Map((topCoins as Array<{ _id: unknown; coins: number }>).map((c) => [String(c._id), c.coins]));
    const topReferrers = (topRaw as Array<{ _id: unknown; count: number }>)
      .map((t) => {
        const u = nameById.get(String(t._id));
        return u ? { id: String(t._id), name: u.name, referralCode: u.referralCode, count: t.count, coins: coinsById.get(String(t._id)) ?? 0 } : null;
      })
      .filter(Boolean);

    const rewardsByWallet = { video: 0, social: 0 };
    for (const row of rewardByWallet as Array<{ _id: string; total: number }>) {
      if (row._id === 'video') rewardsByWallet.video = row.total;
      if (row._id === 'social') rewardsByWallet.social = row.total;
    }

    res.json({
      success: true,
      data: {
        totals: {
          referredUsers,
          referrers: referrerGroups[0]?.total ?? 0,
          dailyJoins,
          rewardsPaid: rewardsByWallet.video + rewardsByWallet.social,
          rewardsVideo: rewardsByWallet.video,
          rewardsSocial: rewardsByWallet.social,
          commission: commissionRaw[0]?.total ?? 0,
        },
        days,
        byLevel,
        topReferrers,
        recentJoins,
      },
    });
  })
);

// ---- Roles ----
router.get(
  '/roles',
  requireAdminAuth,
  requirePermission('roles.read'),
  asyncHandler(async (_req, res) => {
    const [roles, adminCountsRaw] = await Promise.all([
      Role.find().sort({ isSystem: -1, name: 1 }),
      AdminUser.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]),
    ]);
    const adminCounts = new Map((adminCountsRaw as Array<{ _id: string | null; count: number }>).map((r) => [String(r._id), r.count]));
    const totalAdmins = (adminCountsRaw as Array<{ count: number }>).reduce((a, r) => a + r.count, 0);
    const system = roles.filter((r) => r.isSystem).length;
    res.json({
      success: true,
      data: {
        roles: roles.map((r) => ({ ...r.toObject(), adminCount: adminCounts.get(String(r._id)) ?? 0 })),
        allPermissions: ALL_PERMISSIONS,
        stats: { total: roles.length, system, custom: roles.length - system, totalAdmins, permissionCount: ALL_PERMISSIONS.length },
      },
    });
  })
);

router.post(
  '/roles',
  requireAdminAuth,
  requirePermission('roles.manage'),
  audit('role.create', 'Role'),
  asyncHandler(async (req, res) => {
    const data = z.object({ name: z.string().min(2), permissions: z.array(z.string()) }).parse(req.body);
    const role = await Role.create(data);
    res.status(201).json({ success: true, data: role });
  })
);

router.put(
  '/roles/:id',
  requireAdminAuth,
  requirePermission('roles.manage'),
  audit('role.update', 'Role'),
  asyncHandler(async (req, res) => {
    const role = await Role.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!role) throw new ApiError(404, 'Role not found');
    res.json({ success: true, data: role });
  })
);

router.delete(
  '/roles/:id',
  requireAdminAuth,
  requirePermission('roles.manage'),
  audit('role.delete', 'Role'),
  asyncHandler(async (req, res) => {
    const role = await Role.findById(req.params.id);
    if (!role) throw new ApiError(404, 'Role not found');
    if (role.isSystem) throw new ApiError(400, 'Cannot delete system role');
    const admins = await AdminUser.countDocuments({ role: role._id });
    if (admins > 0) throw new ApiError(400, 'Role is in use');
    await role.deleteOne();
    res.json({ success: true, message: 'Role deleted' });
  })
);

// ---- Audit ----
router.get(
  '/audit-logs',
  requireAdminAuth,
  requirePermission('audit.read'),
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        entity: z.string().max(60).optional(),
        search: z.string().max(200).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(req.query);
    const filter: Record<string, unknown> = {};
    if (q.entity) filter.entity = q.entity;
    if (q.search) {
      const rx = new RegExp(q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ action: rx }, { actorEmail: rx }, { entity: rx }];
    }
    const skip = (q.page - 1) * q.limit;
    const [logs, total, entities] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(q.limit),
      AuditLog.countDocuments(filter),
      AuditLog.distinct('entity'),
    ]);
    res.json({ success: true, data: { logs, total, page: q.page, pages: Math.ceil(total / q.limit), entities: (entities as string[]).sort() } });
  })
);

// ---- Reports ----
router.get(
  '/reports',
  requireAdminAuth,
  requirePermission('reports.read'),
  asyncHandler(async (_req, res) => {
    const since14 = new Date();
    since14.setHours(0, 0, 0, 0);
    since14.setDate(since14.getDate() - 13);

    const [
      userStatusAgg, kycAgg, referredCount,
      ledgerInRaw, ledgerOutRaw, watchAgg,
      depositsInRaw, payoutsOutRaw,
      signups14Raw, flow14Raw, views14Raw,
      topEarnersRaw, topVideos,
    ] = await Promise.all([
      User.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      User.aggregate([{ $group: { _id: '$kycStatus', count: { $sum: 1 } } }]),
      User.countDocuments({ referredBy: { $ne: null } }),
      LedgerEntry.aggregate([
        { $match: { type: 'credit' } },
        { $group: { _id: '$wallet', total: { $sum: '$amount' } } },
      ]),
      LedgerEntry.aggregate([
        { $match: { type: 'debit' } },
        { $group: { _id: '$wallet', total: { $sum: '$amount' } } },
      ]),
      ViewEvent.aggregate([
        {
          $group: {
            _id: null,
            watchedSeconds: { $sum: '$watchedSeconds' },
            views: { $sum: 1 },
            rewarded: { $sum: { $cond: ['$rewarded', 1, 0] } },
          },
        },
      ]),
      Deposit.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Withdrawal.aggregate([
        { $match: { status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      User.aggregate([
        { $match: { createdAt: { $gte: since14 } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      ]),
      LedgerEntry.aggregate([
        { $match: { createdAt: { $gte: since14 } } },
        { $group: { _id: { date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, type: '$type' }, total: { $sum: '$amount' } } },
      ]),
      ViewEvent.aggregate([
        { $match: { createdAt: { $gte: since14 } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      ]),
      LedgerEntry.aggregate([
        { $match: { type: 'credit' } },
        {
          $group: {
            _id: '$user',
            total: { $sum: '$amount' },
            video: { $sum: { $cond: [{ $eq: ['$wallet', 'video'] }, '$amount', 0] } },
            social: { $sum: { $cond: [{ $eq: ['$wallet', 'social'] }, '$amount', 0] } },
          },
        },
        { $sort: { total: -1 } },
        { $limit: 10 },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
        { $unwind: { path: '$u', preserveNullAndEmptyArrays: true } },
        { $project: { total: 1, video: 1, social: 1, name: '$u.name', email: '$u.email' } },
      ]),
      Video.find().sort({ views: -1 }).limit(5).select('title thumbnail views likes rewardCoins status').lean(),
    ]);

    const walletSum = (rows: Array<{ _id: string; total: number }>, key: string) =>
      rows.reduce((a, r) => (r._id === key ? a + r.total : a), 0);
    const inRows = ledgerInRaw as Array<{ _id: string; total: number }>;
    const outRows = ledgerOutRaw as Array<{ _id: string; total: number }>;
    const coinsInVideo = walletSum(inRows, 'video');
    const coinsInSocial = walletSum(inRows, 'social');
    const coinsOutTotal = walletSum(outRows, 'video') + walletSum(outRows, 'social');

    const statusMap: Record<string, number> = { active: 0, suspended: 0, banned: 0, pending_delete: 0, deleted: 0 };
    for (const r of userStatusAgg as Array<{ _id: string; count: number }>) statusMap[r._id] = r.count;
    const kycMap: Record<string, number> = { none: 0, pending: 0, verified: 0, rejected: 0 };
    for (const r of kycAgg as Array<{ _id: string; count: number }>) kycMap[r._id] = r.count;

    const totals = {
      users: userStatusAgg.reduce((a: number, r: { count: number }) => a + r.count, 0) - statusMap.deleted,
      activeUsers: statusMap.active,
      suspendedUsers: statusMap.suspended,
      bannedUsers: statusMap.banned,
      kycNone: kycMap.none,
      kycPending: kycMap.pending,
      kycVerified: kycMap.verified,
      kycRejected: kycMap.rejected,
      referred: referredCount,
      coinsIn: coinsInVideo + coinsInSocial,
      coinsInVideo,
      coinsInSocial,
      coinsOut: coinsOutTotal,
      outstanding: coinsInVideo + coinsInSocial - coinsOutTotal,
      watchMinutes: Math.round(((watchAgg as Array<{ watchedSeconds: number }>)[0]?.watchedSeconds ?? 0) / 60),
      views: (watchAgg as Array<{ views: number }>)[0]?.views ?? 0,
      rewardedViews: (watchAgg as Array<{ rewarded: number }>)[0]?.rewarded ?? 0,
      depositsIn: (depositsInRaw as Array<{ total: number }>)[0]?.total ?? 0,
      depositsCount: (depositsInRaw as Array<{ count: number }>)[0]?.count ?? 0,
      payoutsOut: (payoutsOutRaw as Array<{ total: number }>)[0]?.total ?? 0,
      payoutsCount: (payoutsOutRaw as Array<{ count: number }>)[0]?.count ?? 0,
    };

    const signupMap = new Map((signups14Raw as Array<{ _id: string; count: number }>).map((r) => [r._id, r.count]));
    const flowMap = new Map<string, { coinsIn: number; coinsOut: number }>();
    for (const row of flow14Raw as Array<{ _id: { date: string; type: string }; total: number }>) {
      const e = flowMap.get(row._id.date) ?? { coinsIn: 0, coinsOut: 0 };
      if (row._id.type === 'credit') e.coinsIn = row.total;
      else e.coinsOut = row.total;
      flowMap.set(row._id.date, e);
    }
    const viewMap = new Map((views14Raw as Array<{ _id: string; count: number }>).map((r) => [r._id, r.count]));
    const days = Array.from({ length: 14 }, (_, i) => {
      const key = new Date(since14.getTime() + i * 864e5).toISOString().slice(0, 10);
      const f = flowMap.get(key);
      return {
        date: key,
        signups: signupMap.get(key) ?? 0,
        coinsIn: f?.coinsIn ?? 0,
        coinsOut: f?.coinsOut ?? 0,
        views: viewMap.get(key) ?? 0,
      };
    });

    const topEarners = (topEarnersRaw as Array<{ _id: string | null; total: number; video: number; social: number; name?: string; email?: string }>).map((r) => ({
      userId: r._id,
      name: r.name ?? 'Unknown user',
      email: r.email ?? '—',
      total: r.total,
      video: r.video,
      social: r.social,
    }));

    res.json({ success: true, data: { totals, days, topEarners, topVideos } });
  })
);

// ---- Settings ----
const settingsSchema = z
  .object({
    appName: z.string().min(1).max(80),
    androidDownloadUrl: z
      .string()
      .max(500)
      .refine((v) => v === '' || /^https?:\/\/\S+$/.test(v), 'Android URL must be a valid http(s) URL'),
    iosDownloadUrl: z
      .string()
      .max(500)
      .refine((v) => v === '' || /^https?:\/\/\S+$/.test(v), 'iOS URL must be a valid http(s) URL'),
    minWithdrawal: z.coerce.number().int().min(0).max(1_000_000),
    signupBonus: z.coerce.number().int().min(0).max(100_000),
    maintenanceMode: z.boolean(),
  })
  .strict();

router.get(
  '/settings',
  requireAdminAuth,
  requirePermission('settings.read'),
  asyncHandler(async (_req, res) => {
    const settings = await Setting.find().lean();
    const map: Record<string, unknown> = {};
    const meta: Record<string, string> = {};
    settings.forEach((s) => {
      map[s.key] = s.value;
      meta[s.key] = new Date(s.updatedAt ?? Date.now()).toISOString();
    });
    res.json({ success: true, data: map, meta });
  })
);

router.put(
  '/settings',
  requireAdminAuth,
  requirePermission('settings.manage'),
  audit('settings.update', 'Setting'),
  asyncHandler(async (req, res) => {
    const parsed = settingsSchema.parse(req.body);
    for (const [key, value] of Object.entries(parsed)) {
      await Setting.findOneAndUpdate({ key }, { key, value }, { upsert: true });
    }
    res.json({ success: true, message: 'Settings updated' });
  })
);

export default router;
