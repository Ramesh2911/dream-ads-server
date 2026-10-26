import mongoose, { Schema, Document } from 'mongoose';

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  email?: string;
  mobile?: string;
  password: string;
  name: string;
  dob?: Date;
  avatar?: string;
  referralCode: string;
  referredBy?: mongoose.Types.ObjectId;
  status: 'active' | 'suspended' | 'banned' | 'pending_delete' | 'deleted';
  isAgeVerified: boolean;
  kycStatus: 'none' | 'pending' | 'verified' | 'rejected';
  kycDocuments?: { type: string; url: string; status: string; reason?: string }[];
  fcmToken?: string;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    email: { type: String, unique: true, sparse: true, trim: true, lowercase: true },
    mobile: { type: String, unique: true, sparse: true, trim: true },
    password: { type: String, required: true },    name: { type: String, required: true, trim: true },
    dob: { type: Date },
    avatar: { type: String },
    referralCode: { type: String, unique: true, required: true },
    referredBy: { type: Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: ['active', 'suspended', 'banned', 'pending_delete', 'deleted'], default: 'active' },
    isAgeVerified: { type: Boolean, default: false },
    kycStatus: { type: String, enum: ['none', 'pending', 'verified', 'rejected'], default: 'none' },
    kycDocuments: [{ type: String, url: String, status: String, reason: String }],
    fcmToken: { type: String },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

export const User = mongoose.model<IUser>('User', userSchema);
