import mongoose, { Schema, Document } from 'mongoose';

export const ALL_PERMISSIONS = [
  'dashboard.view',
  'users.read', 'users.update', 'users.ban',
  'wallet.read', 'wallet.adjust',
  'referral.read', 'referral.config',
  'content.read', 'content.manage',
  'ads.read', 'ads.manage',
  'tasks.read', 'tasks.verify',
  'kyc.read', 'kyc.verify',
  'finance.read', 'finance.approve',
  'vouchers.read', 'vouchers.manage',
  'cms.read', 'cms.manage', 'cms.broadcast',
  'roles.read', 'roles.manage',
  'leads.read', 'leads.manage',
  'audit.read',
  'reports.read',
  'settings.read', 'settings.manage',
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

export interface IRole extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  permissions: Permission[];
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const roleSchema = new Schema<IRole>(
  {
    name: { type: String, required: true, unique: true },
    permissions: [{ type: String, enum: ALL_PERMISSIONS }],
    isSystem: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const Role = mongoose.model<IRole>('Role', roleSchema);
