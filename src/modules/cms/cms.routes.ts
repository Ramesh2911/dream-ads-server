import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { AppUpdate } from '../../models/AppUpdate';
import { Announcement } from '../../models/Announcement';
import { Setting } from '../../models/Setting';
import { env } from '../../config/env';
import { asyncHandler, ApiError } from '../../middleware/error';

const router = Router();

// ---- Public: active app updates (What's new) ----
router.get(
  '/app-updates',
  asyncHandler(async (_req, res) => {
    const items = await AppUpdate.find({ isActive: true })
      .sort({ priority: -1, createdAt: -1 })
      .limit(20)
      .select('title content priority createdAt')
      .lean();
    res.json({ success: true, data: items });
  })
);

// ---- Public: active announcements (home ticker) ----
router.get(
  '/announcements',
  asyncHandler(async (_req, res) => {
    const items = await Announcement.find({ isActive: true })
      .sort({ priority: -1, createdAt: -1 })
      .limit(20)
      .select('text priority createdAt')
      .lean();
    res.json({ success: true, data: items });
  })
);

// ---- Public: app config (social links, landing PDF) ----
router.get(
  '/app-config',
  asyncHandler(async (_req, res) => {
    const [social, pdf, goal] = await Promise.all([
      Setting.findOne({ key: 'socialLinks' }).lean(),
      Setting.findOne({ key: 'landingPdf' }).lean(),
      Setting.findOne({ key: 'dailyGoalReward' }).lean(),
    ]);
    const links = Array.isArray(social?.value)
      ? (social!.value as Array<{ platform?: unknown; url?: unknown }>)
          .filter((l) => l && typeof l.platform === 'string' && typeof l.url === 'string')
          .map((l) => ({ platform: l.platform as string, url: l.url as string }))
      : [];
    const pdfFile = typeof pdf?.value === 'string' && /^[\w.-]{1,120}$/.test(pdf.value) ? pdf.value : null;
    res.json({
      success: true,
      data: {
        socialLinks: links,
        landingPdf: pdfFile && fs.existsSync(path.join(env.uploadDir, 'landing', pdfFile)) ? '/api/landing-pdf' : null,
        dailyGoalReward: Number(goal?.value ?? 0),
      },
    });
  })
);

// ---- Public: serve landing page PDF ----
router.get(
  '/landing-pdf',
  asyncHandler(async (_req, res) => {
    const stored = await Setting.findOne({ key: 'landingPdf' }).lean();
    const file = typeof stored?.value === 'string' ? stored.value : '';
    if (!file || !/^[\w.-]{1,120}$/.test(file)) throw new ApiError(404, 'PDF not available');
    const full = path.resolve(env.uploadDir, 'landing', file);
    if (!fs.existsSync(full)) throw new ApiError(404, 'PDF not available');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="landing.pdf"');
    res.setHeader('Cache-Control', 'public, max-age=300');
    fs.createReadStream(full).pipe(res);
  })
);

export default router;
