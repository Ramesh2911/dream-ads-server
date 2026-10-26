import mongoose, { Schema, Document } from 'mongoose';

export interface IChatSession extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  companionName: string;
  companionAvatar?: string;
  coinCostPerMessage: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const chatSessionSchema = new Schema<IChatSession>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    companionName: { type: String, required: true },
    companionAvatar: String,
    coinCostPerMessage: { type: Number, default: 1 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const ChatSession = mongoose.model<IChatSession>('ChatSession', chatSessionSchema);
