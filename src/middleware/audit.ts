import { Request, Response, NextFunction } from 'express';
import { AuditLog } from '../models/AuditLog';

/**
 * Fire-and-forget audit logger for sensitive admin actions.
 */
export function audit(action: string, entity: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const admin = req.admin;
    if (admin) {
      const raw = req.body?.after ?? req.body;
      // Never write raw credentials into audit logs
      const after =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? { ...raw, ...(typeof (raw as { password?: unknown }).password === 'string' ? { password: '[redacted]' } : {}) }
          : raw;
      AuditLog.create({
        actor: admin._id,
        actorEmail: admin.email,
        action,
        entity,
        entityId: req.params.id || (req.body?.id as string) || undefined,
        before: req.body?.before,
        after,
        ip: req.ip,
      }).catch(() => {});
    }
    next();
  };
}
