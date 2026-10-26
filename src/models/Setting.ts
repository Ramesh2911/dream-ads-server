import mongoose, { Schema, Document } from 'mongoose';

export interface ISetting extends Document {
  _id: mongoose.Types.ObjectId;
  key: string;
  value: unknown;
  updatedAt: Date;
}

const settingSchema = new Schema<ISetting>(
  {
    key: { type: String, required: true, unique: true },
    value: Schema.Types.Mixed,
  },
  { timestamps: true }
);

export const Setting = mongoose.model<ISetting>('Setting', settingSchema);
