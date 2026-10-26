import mongoose, { Schema, Document } from 'mongoose';

export interface IReferralConfig extends Document {
  _id: mongoose.Types.ObjectId;
  maxLevels: number;
  levelRewards: { level: number; coins: number; wallet: 'video' | 'social' }[];
  dailyJoinLimit: number;
  commissionEnabled: boolean;
  commissionPercent: number;
  updatedAt: Date;
}

const referralConfigSchema = new Schema<IReferralConfig>(
  {
    maxLevels: { type: Number, default: 10 },
    levelRewards: [
      {
        level: Number,
        coins: Number,
        wallet: { type: String, enum: ['video', 'social'], default: 'social' },
      },
    ],
    dailyJoinLimit: { type: Number, default: 100 },
    commissionEnabled: { type: Boolean, default: false },
    commissionPercent: { type: Number, default: 0, min: 0, max: 100 },
  },
  { timestamps: true }
);

export const ReferralConfig = mongoose.model<IReferralConfig>('ReferralConfig', referralConfigSchema);
