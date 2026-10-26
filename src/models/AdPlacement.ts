import mongoose, { Schema, Document } from 'mongoose';

export interface IAdPlacement extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  format: 'banner' | 'interstitial' | 'rewarded';
  placementKey: string;
  enabled: boolean;
  frequencyCap?: number;
  network?: string;
  unitId?: string;
  updatedAt: Date;
}

const adPlacementSchema = new Schema<IAdPlacement>(
  {
    name: { type: String, required: true },
    format: { type: String, enum: ['banner', 'interstitial', 'rewarded'], required: true },
    placementKey: { type: String, required: true, unique: true },
    enabled: { type: Boolean, default: false },
    frequencyCap: Number,
    network: String,
    unitId: String,
  },
  { timestamps: true }
);

export const AdPlacement = mongoose.model<IAdPlacement>('AdPlacement', adPlacementSchema);
