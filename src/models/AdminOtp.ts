import mongoose, { Schema, Document } from 'mongoose';

export interface IAdminOtp extends Document {
  _id: mongoose.Types.ObjectId;
  email: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  createdAt: Date;
}

/** Short-lived password-reset OTP for admin accounts (auto-purged by TTL index). */
const adminOtpSchema = new Schema<IAdminOtp>(
  {
    email: { type: String, required: true, trim: true, lowercase: true, index: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0, min: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

adminOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AdminOtp = mongoose.model<IAdminOtp>('AdminOtp', adminOtpSchema);
