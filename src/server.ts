import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { spawn } from 'child_process';
import { env } from './config/env';
import { connectDB } from './config/database';
import { errorHandler, notFound } from './middleware/error';
import { logger } from './utils/logger';

import authRoutes from './modules/auth/auth.routes';
import videosRoutes from './modules/videos/videos.routes';
import tasksRoutes from './modules/tasks/tasks.routes';
import referralsRoutes from './modules/referrals/referrals.routes';
import walletRoutes from './modules/wallet/wallet.routes';
import financeRoutes from './modules/finance/finance.routes';
import adminRoutes from './modules/admin/admin.routes';
import inquiriesRoutes from './modules/inquiries/inquiries.routes';

const app = express();

// LiteSpeed/cPanel sits in front of this app and sets X-Forwarded-For.
// Trust exactly one hop so express-rate-limit sees the real client IP
// (and stops rejecting requests with ERR_ERL_UNEXPECTED_X_FORWARDED_FOR).
app.set('trust proxy', 1);

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: env.corsOrigin, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.get('/api/health', (_req, res) => res.json({ success: true, status: 'ok', time: new Date().toISOString() }));

app.get('/api/deploy-marker', (_req, res) => res.json({ marker: 'corp-deploy-v3' }));

// CI-triggered worker restart: after Fileman uploads, GitHub Actions calls this
// so the supervisor respawns lsnode with the fresh code (no WHMCS/CGI needed).
const RESTART_KEY = process.env.RESTART_KEY || 'da-restart-7f3a9b2e';
app.post('/api/internal/restart', (req, res) => {
  if (req.headers['x-restart-key'] !== RESTART_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const target = String(req.body?.app || req.query?.app || '');
  if (!['website', 'backend'].includes(target)) {
    return res.status(400).json({ error: 'app must be website|backend' });
  }
  const appDir = `/home/dreamads/${target}/`;
  const install = req.body?.install === true || req.query?.install === '1';
  logger.info(`restart requested for ${target} install=${install}`);
  // Respond BEFORE the heavy work. Doing `npm install` synchronously here
  // blocked the event loop for up to 3 minutes, so LiteSpeed timed out and
  // CI saw a 503 before this handler could ever reply.
  res.json({ success: true, restarted: target, install });
  setTimeout(() => {
    const cmd = [
      install ? `cd '${appDir}' && npm install --omit=dev --no-audit --no-fund` : '',
      // bracket trick: regex [l]snode matches lsnode but our own cmdline has
      // literal [l]snode so pkill never kills the caller mid-request
      `pkill -9 -f '[l]snode.*${appDir}' || true`,
    ]
      .filter(Boolean)
      .join('; ');
    let done = false;
    const die = () => {
      if (done) return;
      done = true;
      try { process.kill(process.pid, 'SIGKILL'); } catch { /* already gone */ }
      process.exit(0);
    };
    // only the backend worker respawns itself; a website restart must leave us alone
    const dieLater = () => { if (target === 'backend') setTimeout(die, 250); };
    try {
      const child = spawn('/bin/sh', ['-c', cmd], { stdio: 'ignore' });
      child.on('exit', dieLater);
      child.on('error', (e) => {
        logger.error(`restart spawn failed for ${target}: ${e}`);
        dieLater();
      });
    } catch (e) {
      logger.error(`restart spawn failed for ${target}: ${e}`);
      dieLater();
    }
    // safety net: never leave the worker stuck on old code
    if (target === 'backend') setTimeout(die, 240000);
  }, 400);
});

app.use('/api/auth', authRoutes);
app.use('/api', videosRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/referrals', referralsRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/finance', financeRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/inquiries', inquiriesRoutes);
app.use('/api/inquiry', inquiriesRoutes);

app.use(notFound);
app.use(errorHandler);

async function start() {
  await connectDB();
  app.listen(env.port, () => logger.info(`Server running on :${env.port}`));
}

if (!process.env.VITEST) {
  start();
}

export { app };
