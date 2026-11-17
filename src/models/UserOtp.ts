import mongoose, { Schema, Document } from 'mongoose';

export type OtpPurpose = 'register' | 'reset';

export interface IUserOtp extends Document {
  _id: mongoose.Types.ObjectId;
  email: string;
  purpose: OtpPurpose;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  createdAt: Date;
}

/** Short-lived email OTP for user registration / password reset (auto-purged by TTL index). */
const userOtpSchema = new Schema<IUserOtp>(
  {
    email: { type: String, required: true, trim: true, lowercase: true, index: true },
    purpose: { type: String, enum: ['register', 'reset'], required: true, index: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0, min: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

userOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const UserOtp = mongoose.model<IUserOtp>('UserOtp', userOtpSchema);
