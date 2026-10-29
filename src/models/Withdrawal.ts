import mongoose, { Schema, Document } from 'mongoose';

export interface IWithdrawal extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  amount: number;
  wallet: 'video' | 'social';
  method: 'upi' | 'bank' | 'paytm';
  destination: string;
  accountNo?: string;
  ifsc?: string;
  bankName?: string;
  status: 'pending' | 'approved' | 'rejected' | 'paid';
  rejectionReason?: string;
  paymentRef?: string;
  reviewedBy?: mongoose.Types.ObjectId;
  reviewedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const withdrawalSchema = new Schema<IWithdrawal>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true, min: 1 },
    wallet: { type: String, enum: ['video', 'social'], required: true },
    method: { type: String, enum: ['upi', 'bank', 'paytm'], required: true },
    destination: { type: String, required: true },
    accountNo: { type: String, trim: true },
    ifsc: { type: String, trim: true },
    bankName: { type: String, trim: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'paid'], default: 'pending' },
    rejectionReason: String,
    paymentRef: String,
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
    reviewedAt: Date,
  },
  { timestamps: true }
);

export const Withdrawal = mongoose.model<IWithdrawal>('Withdrawal', withdrawalSchema);
