import mongoose, { Schema, Document } from 'mongoose';

export interface IVoucherRedemption extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  voucher: mongoose.Types.ObjectId;
  code?: string;
  status: 'pending' | 'fulfilled' | 'failed';
  createdAt: Date;
}

const voucherRedemptionSchema = new Schema<IVoucherRedemption>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    voucher: { type: Schema.Types.ObjectId, ref: 'Voucher', required: true },
    code: String,
    status: { type: String, enum: ['pending', 'fulfilled', 'failed'], default: 'pending' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const VoucherRedemption = mongoose.model<IVoucherRedemption>('VoucherRedemption', voucherRedemptionSchema);
