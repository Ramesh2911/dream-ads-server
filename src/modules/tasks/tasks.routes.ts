import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { Task } from '../../models/Task';
import { TaskSubmission } from '../../models/TaskSubmission';
import { AdminUser } from '../../models/AdminUser';
import { env } from '../../config/env';
import { asyncHandler, ApiError } from '../../middleware/error';
import { requireUserAuth } from '../../middleware/auth';

const router = Router();

// ---- Screenshot proof storage ----
const uploadRoot = path.resolve(env.uploadDir, 'tasks');
fs.mkdirSync(uploadRoot, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadRoot),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.-]+/g, '_').slice(-80);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
  },
});

const ALLOWED_IMAGE = ['image/png', 'image/jpeg', 'image/webp'];

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE.includes(file.mimetype)) {
      return cb(new ApiError(400, 'Screenshot must be PNG, JPG or WEBP'));
    }
    cb(null, true);
  },
});

function handleScreenshotUpload(req: Request, res: Response, next: NextFunction) {
  // only parse multipart when a file field is present
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) return next();
  upload.single('screenshot')(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof ApiError) return next(err);
      const e = err as { code?: string; message?: string };
      if (e.code === 'LIMIT_FILE_SIZE') return next(new ApiError(400, 'Screenshot must be 5MB or smaller'));
      return next(new ApiError(400, e.message || 'Upload failed'));
    }
    next();
  });
}

router.get(
  '/',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const { status = 'active', page = 1, limit = 20 } = req.query;
    const filter: Record<string, unknown> = { status };
    const skip = (Number(page) - 1) * Number(limit);
    const [tasks, total] = await Promise.all([
      Task.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
      Task.countDocuments(filter),
    ]);
    const userId = req.user!._id;
    const submissions = await TaskSubmission.find({ user: userId, task: { $in: tasks.map((t) => t._id) } });
    const submittedMap = new Map(submissions.map((s) => [String(s.task), s.status]));
    const data = tasks.map((t) => ({
      ...t.toObject(),
      mySubmissionStatus: submittedMap.get(String(t._id)) || null,
    }));
    res.json({ success: true, data: { tasks: data, total, page: Number(page), pages: Math.ceil(total / Number(limit)) } });
  })
);

router.get(
  '/:id',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const task = await Task.findById(req.params.id);
    if (!task) throw new ApiError(404, 'Task not found');
    const submission = await TaskSubmission.findOne({ task: task._id, user: req.user!._id });
    res.json({ success: true, data: { task, submission } });
  })
);

router.post(
  '/:id/submit',
  requireUserAuth,
  handleScreenshotUpload,
  asyncHandler(async (req, res) => {
    // multipart: fields land in req.body as strings; JSON: whole body
    const raw = {
      proofUrl: req.body?.proofUrl,
      proofText: req.body?.proofText,
    };
    const { proofUrl, proofText } = z
      .object({ proofUrl: z.string().url().optional(), proofText: z.string().max(2000).optional() })
      .parse(raw);

    const task = await Task.findById(req.params.id);
    if (!task || task.status !== 'active') throw new ApiError(404, 'Task not available');
    const existing = await TaskSubmission.findOne({ task: task._id, user: req.user!._id });
    if (existing) throw new ApiError(409, 'Already submitted');
    if (task.totalSlots && task.filledSlots >= task.totalSlots) throw new ApiError(400, 'No slots left');

    if (task.proofType === 'screenshot') {
      if (!req.file) throw new ApiError(400, 'Screenshot file required');
    } else if (task.proofType === 'url' && !proofUrl) {
      throw new ApiError(400, 'URL proof required');
    } else if (task.proofType === 'text' && !proofText) {
      throw new ApiError(400, 'Text proof required');
    }

    const submission = await TaskSubmission.create({
      task: task._id,
      user: req.user!._id,
      proofUrl: task.proofType === 'screenshot' ? undefined : proofUrl,
      proofText,
      proofFile: req.file?.filename,
    });

    if (task.proofType === 'screenshot' && req.file) {
      submission.proofUrl = `/api/tasks/submissions/${submission._id}/proof`;
      await submission.save();
    }

    task.filledSlots += 1;
    if (task.totalSlots && task.filledSlots >= task.totalSlots) task.status = 'completed';
    await task.save();
    res.status(201).json({ success: true, data: submission });
  })
);

/** Serve screenshot proof — submitter or admin only. */
router.get(
  '/submissions/:submissionId/proof',
  asyncHandler(async (req, res) => {
    const submission = await TaskSubmission.findById(req.params.submissionId);
    if (!submission || !submission.proofUrl?.startsWith('/api/tasks/submissions/')) {
      throw new ApiError(404, 'Proof not found');
    }
    // auth: submitter (Bearer) or admin (Bearer)
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new ApiError(401, 'Authentication required');

    let allowed = false;
    try {
      const payload = jwt.verify(header.slice(7), env.jwtAccessSecret) as jwt.JwtPayload;
      if (payload.type === 'access') {
        if (payload.sub === String(submission.user)) allowed = true;
        else {
          const admin = await AdminUser.findById(payload.sub);
          if (admin && admin.status === 'active') allowed = true;
        }
      }
    } catch {
      allowed = false;
    }
    if (!allowed) throw new ApiError(403, 'Not allowed');

    if (!submission.proofFile) throw new ApiError(404, 'Proof file missing');
    const filePath = path.join(uploadRoot, submission.proofFile);
    if (!fs.existsSync(filePath)) throw new ApiError(404, 'Proof file missing');
    const ext = path.extname(submission.proofFile).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(filePath);
  })
);

export default router;
