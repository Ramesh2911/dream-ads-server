import mongoose, { Schema, Document } from 'mongoose';

export interface ITask extends Document {
  _id: mongoose.Types.ObjectId;
  title: string;
  description: string;
  instructions?: string;
  proofType: 'screenshot' | 'url' | 'text';
  rewardCoins: number;
  rewardWallet: 'video' | 'social';
  eligibility: { minLevel?: number; requiresKyc?: boolean; maxSubmissions?: number };
  status: 'draft' | 'active' | 'paused' | 'completed';
  totalSlots?: number;
  filledSlots: number;
  startsAt?: Date;
  endsAt?: Date;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const taskSchema = new Schema<ITask>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    instructions: { type: String },
    proofType: { type: String, enum: ['screenshot', 'url', 'text'], required: true },
    rewardCoins: { type: Number, required: true, min: 0 },
    rewardWallet: { type: String, enum: ['video', 'social'], default: 'social' },
    eligibility: {
      minLevel: Number,
      requiresKyc: Boolean,
      maxSubmissions: Number,
    },
    status: { type: String, enum: ['draft', 'active', 'paused', 'completed'], default: 'draft' },
    totalSlots: Number,
    filledSlots: { type: Number, default: 0 },
    startsAt: Date,
    endsAt: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
  },
  { timestamps: true }
);

export const Task = mongoose.model<ITask>('Task', taskSchema);
