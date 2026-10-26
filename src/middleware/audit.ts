import { Request, Response, NextFunction } from 'express';
import { AuditLog } from '../models/AuditLog';

/**
 * Fire-and-forget audit logger for sensitive admin actions.
 */
export function audit(action: string, entity: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const admin = req.admin;
    if (admin) {
      AuditLog.create({
        actor: admin._id,
        actorEmail: admin.email,
        action,
        entity,
        entityId: req.params.id || (req.body?.id as string) || undefined,
        before: req.body?.before,
        after: req.body?.after ?? req.body,
        ip: req.ip,
      }).catch(() => {});
    }
    next();
  };
}
