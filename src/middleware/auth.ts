import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { ApiError, asyncHandler } from './error';
import { AdminUser, IAdminUser } from '../models/AdminUser';
import { User, IUser } from '../models/User';
import { Permission } from '../models/Role';

declare global {
  namespace Express {
    interface Request {
      user?: IUser;
      admin?: IAdminUser;
      adminPermissions?: Permission[];
    }
  }
}

export function signAccessToken(userId: string) {
  return jwt.sign({ sub: userId, type: 'access' }, env.jwtAccessSecret, {
    expiresIn: env.jwtAccessExpiry,
  } as jwt.SignOptions);
}

export function signRefreshToken(userId: string) {
  return jwt.sign({ sub: userId, type: 'refresh' }, env.jwtRefreshSecret, {
    expiresIn: env.jwtRefreshExpiry,
  } as jwt.SignOptions);
}

export const requireUserAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new ApiError(401, 'Authentication required');
  try {
    const payload = jwt.verify(header.slice(7), env.jwtAccessSecret) as jwt.JwtPayload;
    if (payload.type !== 'access') throw new Error('wrong token type');
    const user = await User.findById(payload.sub);
    if (!user || user.status === 'deleted') throw new ApiError(401, 'Account not found');
    if (user.status === 'banned') throw new ApiError(403, 'Account banned');
    if (user.status === 'suspended') throw new ApiError(403, 'Account suspended');
    req.user = user;
    next();
  } catch {
    throw new ApiError(401, 'Invalid or expired token');
  }
});

export const requireAdminAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new ApiError(401, 'Authentication required');
  try {
    const payload = jwt.verify(header.slice(7), env.jwtAccessSecret) as jwt.JwtPayload;
    if (payload.type !== 'access') throw new Error('wrong token type');
    const admin = await AdminUser.findById(payload.sub).populate('role');
    if (!admin || admin.status !== 'active') throw new ApiError(401, 'Admin account inactive');
    req.admin = admin;
    const role = admin.role as unknown as { name: string; permissions: Permission[] };
    req.adminPermissions = role?.name === 'Super Admin' ? (['*'] as unknown as Permission[]) : role?.permissions || [];
    next();
  } catch {
    throw new ApiError(401, 'Invalid or expired token');
  }
});

export function requirePermission(...perms: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.admin) return next(new ApiError(401, 'Authentication required'));
    const has = req.adminPermissions || [];
    if (has.includes('*' as unknown as Permission) || perms.every((p) => has.includes(p))) {
      return next();
    }
    return next(new ApiError(403, 'Insufficient permissions'));
  };
}
