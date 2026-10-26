import mongoose, { Schema, Document } from 'mongoose';

export interface IDeposit extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  amount: number;
  gateway: string;
  gatewayRef?: string;
  status: 'pending' | 'completed' | 'failed';
  createdAt: Date;
  updatedAt: Date;
}

const depositSchema = new Schema<IDeposit>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true, min: 1 },
    gateway: { type: String, default: 'manual' },
    gatewayRef: String,
    status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  },
  { timestamps: true }
);

export const Deposit = mongoose.model<IDeposit>('Deposit', depositSchema);
