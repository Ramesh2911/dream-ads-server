import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import { Inquiry, INQUIRY_STATUSES } from '../../models/Inquiry';
import { env } from '../../config/env';
import { asyncHandler, ApiError } from '../../middleware/error';
import { requireAdminAuth, requirePermission } from '../../middleware/auth';
import { audit } from '../../middleware/audit';

const router = Router();

// ---- Attachment storage (public corporate inquiries only) ----
const uploadRoot = path.resolve(env.uploadDir, 'inquiries');
fs.mkdirSync(uploadRoot, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadRoot),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.-]+/g, '_').slice(-80);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
  },
});

const ALLOWED_MIME = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
];

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new ApiError(400, 'File type not allowed (PDF, DOC/DOCX, PNG, JPG, WEBP, TXT only)'));
    }
    cb(null, true);
  },
});

function handleUpload(req: Request, res: Response, next: NextFunction) {
  upload.single('attachment')(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof ApiError) return next(err);
      const e = err as { code?: string; message?: string };
      if (e.code === 'LIMIT_FILE_SIZE') return next(new ApiError(400, 'Attachment must be 5MB or smaller'));
      return next(new ApiError(400, e.message || 'Upload failed'));
    }
    next();
  });
}

// ---- Public: create inquiry (corporate website contact form) ----
const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many submissions, please try again later' },
});

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().max(30).optional().or(z.literal('')).transform((v) => v || undefined),
  company: z.string().trim().max(200).optional().or(z.literal('')).transform((v) => v || undefined),
  subject: z.enum(['project', 'career', 'partnership', 'support', 'other']).default('project'),
  service: z.string().trim().max(200).optional().or(z.literal('')).transform((v) => v || undefined),
  role: z.string().trim().max(200).optional().or(z.literal('')).transform((v) => v || undefined),
  budget: z.string().trim().max(60).optional().or(z.literal('')).transform((v) => v || undefined),
  timeline: z.string().trim().max(60).optional().or(z.literal('')).transform((v) => v || undefined),
  message: z.string().trim().min(10).max(5000),
  source: z.enum(['corporate', 'direct']).default('corporate'),
  // multipart fields arrive as strings — parse JSON when needed
  estimate: z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v === 'string') {
      try {
        return JSON.parse(v);
      } catch {
        return undefined;
      }
    }
    return v;
  }, z
    .object({
      platform: z.string().max(60).optional(),
      features: z.array(z.string().max(60)).max(20).optional(),
      timeline: z.string().max(30).optional(),
      complexity: z.number().int().min(1).max(3).optional(),
    })
    .optional()),
});

router.post(
  '/',
  createLimiter,
  handleUpload,
  asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      if (req.file) fs.unlink(req.file.path, () => {});
      throw parsed.error;
    }

    const doc = await Inquiry.create({
      ...parsed.data,
      attachment: req.file
        ? {
            filename: req.file.filename,
            originalName: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
          }
        : undefined,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json({
      success: true,
      message: 'Inquiry submitted — our team will respond shortly',
      data: { id: doc._id, status: doc.status },
    });
  })
);

// ---- Admin: list inquiries ----
router.get(
  '/',
  requireAdminAuth,
  requirePermission('leads.read'),
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        status: z.enum(INQUIRY_STATUSES).optional(),
        subject: z.enum(['project', 'career', 'partnership', 'support', 'other']).optional(),
        search: z.string().max(200).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      })
      .parse(req.query);

    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.subject) filter.subject = q.subject;
    if (q.search) {
      const rx = new RegExp(q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { email: rx }, { company: rx }, { message: rx }];
    }

    const [items, total, statusCounts] = await Promise.all([
      Inquiry.find(filter)
        .sort({ createdAt: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit)
        .lean(),
      Inquiry.countDocuments(filter),
      Inquiry.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    ]);

    const counts: Record<string, number> = {};
    for (const row of statusCounts as Array<{ _id: string; count: number }>) counts[row._id] = row.count;

    res.json({
      success: true,
      data: { items, total, counts, page: q.page, pages: Math.ceil(total / q.limit) },
    });
  })
);

// ---- Admin: single inquiry ----
router.get(
  '/:id',
  requireAdminAuth,
  requirePermission('leads.read'),
  asyncHandler(async (req, res) => {
    const doc = await Inquiry.findById(req.params.id).lean();
    if (!doc) throw new ApiError(404, 'Inquiry not found');
    res.json({ success: true, data: doc });
  })
);

// ---- Admin: update status / add note ----
const updateSchema = z.object({
  status: z.enum(INQUIRY_STATUSES).optional(),
  note: z.string().trim().min(1).max(2000).optional(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});

router.put(
  '/:id',
  requireAdminAuth,
  requirePermission('leads.manage'),
  audit('lead.update', 'Inquiry'),
  asyncHandler(async (req, res) => {
    const { status, note } = updateSchema.parse(req.body);
    const doc = await Inquiry.findById(req.params.id);
    if (!doc) throw new ApiError(404, 'Inquiry not found');

    if (status) doc.status = status;
    if (note) doc.notes.push({ body: note, by: req.admin?.email || 'admin', at: new Date() });
    await doc.save();

    res.json({ success: true, data: doc });
  })
);

// ---- Attachment download (admin) ----
router.get(
  '/:id/attachment',
  requireAdminAuth,
  requirePermission('leads.read'),
  asyncHandler(async (req, res) => {
    const doc = await Inquiry.findById(req.params.id).lean();
    if (!doc?.attachment) throw new ApiError(404, 'No attachment on this inquiry');
    const filePath = path.resolve(uploadRoot, doc.attachment.filename);
    if (!fs.existsSync(filePath)) throw new ApiError(404, 'Attachment file missing');
    res.download(filePath, doc.attachment.originalName);
  })
);

export default router;
