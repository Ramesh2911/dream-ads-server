import mongoose, { Schema, Document } from 'mongoose';

export interface IVoucher extends Document {
  _id: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  provider: string;
  coinCost: number;
  faceValue?: number;
  imageUrl?: string;
  isActive: boolean;
  stock?: number;
  createdAt: Date;
  updatedAt: Date;
}

const voucherSchema = new Schema<IVoucher>(
  {
    title: { type: String, required: true },
    description: String,
    provider: { type: String, required: true },
    coinCost: { type: Number, required: true, min: 1 },
    faceValue: Number,
    imageUrl: String,
    isActive: { type: Boolean, default: true },
    stock: Number,
  },
  { timestamps: true }
);

export const Voucher = mongoose.model<IVoucher>('Voucher', voucherSchema);
