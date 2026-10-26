import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../utils/logger';
import { env } from '../config/env';

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const notFound = (req: Request, res: Response) => {
  res.status(404).json({ success: false, message: 'Route not found' });
};

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({ success: false, message: err.message, code: err.code });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
    });
  }
  if (err instanceof Error) {
    logger.error(err);
    return res.status(500).json({
      success: false,
      message: env.isProd ? 'Internal server error' : err.message,
    });
  }
  logger.error({ err }, 'Unknown error');
  return res.status(500).json({ success: false, message: 'Internal server error' });
}

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;
export const asyncHandler = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res, next)).catch(next);
