import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
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

app.use(helmet());
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

app.use('/api/auth', authRoutes);
app.use('/api', videosRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/referrals', referralsRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/finance', financeRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/inquiries', inquiriesRoutes);

app.use(notFound);
app.use(errorHandler);

async function start() {
  await connectDB();
  app.listen(env.port, () => logger.info(`Server running on :${env.port}`));
}

if (require.main === module) {
  start();
}

export { app };
