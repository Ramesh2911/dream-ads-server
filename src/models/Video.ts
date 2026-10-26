import mongoose, { Schema, Document } from 'mongoose';

export interface IVideo extends Document {
  _id: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  url: string;
  thumbnail: string;
  category: mongoose.Types.ObjectId;
  duration?: number;
  rewardCoins: number;
  rewardWallet: 'video' | 'social';
  status: 'draft' | 'published' | 'archived';
  isFeatured: boolean;
  isTrending: boolean;
  views: number;
  likes: number;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const videoSchema = new Schema<IVideo>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String },
    url: { type: String, required: true },
    thumbnail: { type: String, required: true },
    category: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    duration: { type: Number },
    rewardCoins: { type: Number, default: 0 },
    rewardWallet: { type: String, enum: ['video', 'social'], default: 'video' },
    status: { type: String, enum: ['draft', 'published', 'archived'], default: 'draft' },
    isFeatured: { type: Boolean, default: false },
    isTrending: { type: Boolean, default: false },
    views: { type: Number, default: 0 },
    likes: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
  },
  { timestamps: true }
);

videoSchema.index({ status: 1, category: 1, createdAt: -1 });

export const Video = mongoose.model<IVideo>('Video', videoSchema);
