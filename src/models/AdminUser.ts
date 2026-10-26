import mongoose, { Schema, Document } from 'mongoose';

export interface IAdminUser extends Document {
  _id: mongoose.Types.ObjectId;
  email: string;
  password: string;
  name: string;
  role: mongoose.Types.ObjectId;
  totpSecret?: string;
  totpEnabled: boolean;
  status: 'active' | 'disabled';
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const adminUserSchema = new Schema<IAdminUser>(
  {
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    password: { type: String, required: true },
    name: { type: String, required: true },
    role: { type: Schema.Types.ObjectId, ref: 'Role', required: true },
    totpSecret: { type: String },
    totpEnabled: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

export const AdminUser = mongoose.model<IAdminUser>('AdminUser', adminUserSchema);
