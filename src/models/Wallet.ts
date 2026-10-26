import mongoose, { Schema, Document } from 'mongoose';
import { WalletType } from './LedgerEntry';

export interface IWallet extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  wallet: WalletType;
  balance: number;
  updatedAt: Date;
}

const walletSchema = new Schema<IWallet>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    wallet: { type: String, enum: ['video', 'social'], required: true },
    balance: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

walletSchema.index({ user: 1, wallet: 1 }, { unique: true });

export const Wallet = mongoose.model<IWallet>('Wallet', walletSchema);
