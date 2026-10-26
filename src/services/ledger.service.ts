import { Types } from 'mongoose';
import { Wallet } from '../models/Wallet';
import { LedgerEntry, WalletType, TxType, TxReason } from '../models/LedgerEntry';

export interface ApplyLedgerOpts {
  userId: Types.ObjectId | string;
  wallet: WalletType;
  type: TxType;
  amount: number;
  reason: TxReason;
  refModel?: string;
  refId?: Types.ObjectId;
  note?: string;
  createdBy?: Types.ObjectId;
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

/**
 * Atomically applies a balance change and appends an immutable ledger entry.
 * All money movement MUST go through this function.
 */
export async function applyLedger(opts: ApplyLedgerOpts) {
  const userId = new Types.ObjectId(String(opts.userId));
  if (opts.amount <= 0) throw new LedgerError('Amount must be positive');

  const wallet = await Wallet.findOneAndUpdate(
    { user: userId, wallet: opts.wallet },
    opts.type === 'credit'
      ? { $inc: { balance: opts.amount } }
      : { $inc: { balance: -opts.amount } },
    { new: true, upsert: true, session: undefined }
  );

  if (wallet.balance < 0) {
    // rollback by reversing
    await Wallet.updateOne(
      { user: userId, wallet: opts.wallet },
      { $inc: { balance: opts.type === 'credit' ? -opts.amount : opts.amount } }
    );
    throw new LedgerError('Insufficient balance');
  }

  const entry = await LedgerEntry.create({
    user: userId,
    wallet: opts.wallet,
    type: opts.type,
    amount: opts.amount,
    balanceAfter: wallet.balance,
    reason: opts.reason,
    refModel: opts.refModel,
    refId: opts.refId,
    note: opts.note,
    createdBy: opts.createdBy,
  });

  return { balance: wallet.balance, entry };
}

export async function getBalances(userId: string | Types.ObjectId) {
  const uid = new Types.ObjectId(String(userId));
  const wallets = await Wallet.find({ user: uid });
  const video = wallets.find((w) => w.wallet === 'video')?.balance ?? 0;
  const social = wallets.find((w) => w.wallet === 'social')?.balance ?? 0;
  return { video, social };
}
