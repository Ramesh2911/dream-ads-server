import mongoose, { Schema, Document } from 'mongoose';

export type WalletType = 'video' | 'social';
export type TxType = 'credit' | 'debit';
export type TxReason =
  | 'watch_reward' | 'task_reward' | 'referral_reward' | 'referral_commission'
  | 'withdrawal' | 'deposit' | 'voucher_purchase' | 'chat_access'
  | 'admin_adjustment' | 'signup_bonus' | 'recharge';

export interface ILedgerEntry extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  wallet: WalletType;
  type: TxType;
  amount: number;
  balanceAfter: number;
  reason: TxReason;
  refModel?: string;
  refId?: mongoose.Types.ObjectId;
  note?: string;
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
}

const ledgerSchema = new Schema<ILedgerEntry>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    wallet: { type: String, enum: ['video', 'social'], required: true },
    type: { type: String, enum: ['credit', 'debit'], required: true },
    amount: { type: Number, required: true, min: 0 },
    balanceAfter: { type: Number, required: true },
    reason: {
      type: String,
      enum: ['watch_reward', 'task_reward', 'referral_reward', 'referral_commission', 'withdrawal', 'deposit', 'voucher_purchase', 'chat_access', 'admin_adjustment', 'signup_bonus', 'recharge'],
      required: true,
    },
    refModel: { type: String },
    refId: { type: Schema.Types.ObjectId },
    note: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

ledgerSchema.index({ user: 1, wallet: 1, createdAt: -1 });

export const LedgerEntry = mongoose.model<ILedgerEntry>('LedgerEntry', ledgerSchema);
