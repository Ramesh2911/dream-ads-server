import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/** mongodb://user:pass@host/db → password masked (never log raw credentials) */
export function maskUri(uri: string) {
  try {
    const u = new URL(uri);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return uri.replace(/:\/\/[^@/]*@/, '://***@');
  }
}

export async function connectDB() {
  const isLocal = /^mongodb:\/\/(127\.0\.0\.1|localhost)/.test(env.mongoUri);
  if (isLocal && env.isProd) {
    logger.warn('MONGODB_URI points to localhost while NODE_ENV=production — expected Atlas/cloud URI');
  }
  try {
    await mongoose.connect(env.mongoUri, {
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000,
      maxPoolSize: 10,
    });
    const dbName = mongoose.connection.name;
    logger.info(`MongoDB connected${isLocal ? ' (local)' : ''} → db="${dbName}"`);
  } catch (err) {
    logger.error({ err: (err as Error).message, uri: maskUri(env.mongoUri) }, 'MongoDB connection failed');
    logger.error('Checks: 1) Atlas Network Access IP allowed  2) DB user/password  3) URI path ends with /dream-ads');
    process.exit(1);
  }
}

export async function disconnectDB() {
  await mongoose.disconnect();
}
