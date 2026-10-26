import { Router } from 'express';
import { z } from 'zod';
import { Task } from '../../models/Task';
import { TaskSubmission } from '../../models/TaskSubmission';
import { asyncHandler, ApiError } from '../../middleware/error';
import { requireUserAuth } from '../../middleware/auth';

const router = Router();

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
  asyncHandler(async (req, res) => {
    const { proofUrl, proofText } = z
      .object({ proofUrl: z.string().url().optional(), proofText: z.string().max(2000).optional() })
      .parse(req.body);
    const task = await Task.findById(req.params.id);
    if (!task || task.status !== 'active') throw new ApiError(404, 'Task not available');
    const existing = await TaskSubmission.findOne({ task: task._id, user: req.user!._id });
    if (existing) throw new ApiError(409, 'Already submitted');
    if (task.totalSlots && task.filledSlots >= task.totalSlots) throw new ApiError(400, 'No slots left');
    if (task.proofType === 'url' && !proofUrl) throw new ApiError(400, 'URL proof required');
    if (task.proofType === 'text' && !proofText) throw new ApiError(400, 'Text proof required');

    const submission = await TaskSubmission.create({
      task: task._id,
      user: req.user!._id,
      proofUrl,
      proofText,
    });
    task.filledSlots += 1;
    if (task.totalSlots && task.filledSlots >= task.totalSlots) task.status = 'completed';
    await task.save();
    res.status(201).json({ success: true, data: submission });
  })
);

export default router;
