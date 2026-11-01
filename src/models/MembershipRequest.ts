import mongoose, { Schema, Document } from 'mongoose';

export interface IMembershipRequest extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  method: 'upi' | 'usdt';
  amount: number;
  utr?: string;
  txHash?: string;
  screenshot: string;
  status: 'pending' | 'approved' | 'rejected';
  rejectionReason?: string;
  reviewedBy?: mongoose.Types.ObjectId;
  reviewedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const membershipRequestSchema = new Schema<IMembershipRequest>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    method: { type: String, enum: ['upi', 'usdt'], required: true },
    amount: { type: Number, required: true, min: 1 },
    utr: { type: String, trim: true },
    txHash: { type: String, trim: true },
    screenshot: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    rejectionReason: String,
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
    reviewedAt: Date,
  },
  { timestamps: true }
);

export const MembershipRequest = mongoose.model<IMembershipRequest>('MembershipRequest', membershipRequestSchema);
