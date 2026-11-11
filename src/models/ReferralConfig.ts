import mongoose, { Schema, Document } from 'mongoose';

export interface ILevelTarget {
  level: number;
  target: number;
}

export interface ILevelUpBonus {
  level: number;
  coins: number;
  wallet: 'video' | 'social';
}

/** Client's 10-level table: team size required per level (3^N). Display-only. */
export const DEFAULT_LEVEL_TARGETS: ILevelTarget[] = [
  { level: 1, target: 3 },
  { level: 2, target: 9 },
  { level: 3, target: 27 },
  { level: 4, target: 81 },
  { level: 5, target: 243 },
  { level: 6, target: 729 },
  { level: 7, target: 2187 },
  { level: 8, target: 6561 },
  { level: 9, target: 19683 },
  { level: 10, target: 59049 },
];

/** One-time level-up bonuses (credited once when user's teamCount reaches target). */
export const DEFAULT_LEVEL_UP_BONUSES: ILevelUpBonus[] = [
  { level: 1, coins: 0, wallet: 'social' },
  { level: 2, coins: 50, wallet: 'social' },
  { level: 3, coins: 100, wallet: 'social' },
  { level: 4, coins: 200, wallet: 'social' },
  { level: 5, coins: 500, wallet: 'social' },
  { level: 6, coins: 1000, wallet: 'social' },
  { level: 7, coins: 2500, wallet: 'social' },
  { level: 8, coins: 5000, wallet: 'social' },
  { level: 9, coins: 10000, wallet: 'social' },
  { level: 10, coins: 0, wallet: 'social' },
];

export interface IReferralConfig extends Document {
  _id: mongoose.Types.ObjectId;
  maxLevels: number;
  levelRewards: { level: number; coins: number; wallet: 'video' | 'social' }[];
  levelTargets: ILevelTarget[];
  levelUpBonuses: ILevelUpBonus[];
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
    levelTargets: [
      {
        level: Number,
        target: { type: Number, min: 1 },
      },
    ],
    levelUpBonuses: [
      {
        level: Number,
        coins: { type: Number, min: 0 },
        wallet: { type: String, enum: ['video', 'social'], default: 'social' },
      },
    ],
    dailyJoinLimit: { type: Number, default: 100 },
    commissionEnabled: { type: Boolean, default: false },
    commissionPercent: { type: Number, default: 0, min: 0, max: 100 },
  },
  { timestamps: true }
);

/**
 * API-safe config JSON — fills levelTargets / levelUpBonuses defaults for
 * documents created before these fields existed (fully dynamic via DB).
 */
export function referralConfigJson(config: IReferralConfig | null | undefined) {
  if (!config) {
    return {
      maxLevels: 10,
      levelRewards: [] as { level: number; coins: number; wallet: 'video' | 'social' }[],
      levelTargets: DEFAULT_LEVEL_TARGETS,
      levelUpBonuses: DEFAULT_LEVEL_UP_BONUSES,
      dailyJoinLimit: 100,
      commissionEnabled: false,
      commissionPercent: 0,
    };
  }
  const obj = config.toObject ? config.toObject() : { ...config };
  return {
    ...obj,
    levelTargets: Array.isArray(config.levelTargets) && config.levelTargets.length > 0 ? config.levelTargets : DEFAULT_LEVEL_TARGETS,
    levelUpBonuses: Array.isArray(config.levelUpBonuses) && config.levelUpBonuses.length > 0 ? config.levelUpBonuses : DEFAULT_LEVEL_UP_BONUSES,
  };
}

export const ReferralConfig = mongoose.model<IReferralConfig>('ReferralConfig', referralConfigSchema);
