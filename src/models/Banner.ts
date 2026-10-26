import mongoose, { Schema, Document } from 'mongoose';

export interface IBanner extends Document {
  _id: mongoose.Types.ObjectId;
  title: string;
  imageUrl: string;
  targetUrl?: string;
  order: number;
  isActive: boolean;
  startsAt?: Date;
  endsAt?: Date;
  createdAt: Date;
}

const bannerSchema = new Schema<IBanner>(
  {
    title: { type: String, required: true },
    imageUrl: { type: String, required: true },
    targetUrl: { type: String },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    startsAt: { type: Date },
    endsAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const Banner = mongoose.model<IBanner>('Banner', bannerSchema);
