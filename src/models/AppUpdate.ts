import mongoose, { Schema, Document } from 'mongoose';

export interface IAppUpdate extends Document {
  _id: mongoose.Types.ObjectId;
  title: string;
  content: string;
  priority: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const appUpdateSchema = new Schema<IAppUpdate>(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    content: { type: String, required: true, trim: true, maxlength: 2000 },
    priority: { type: Number, default: 1, min: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const AppUpdate = mongoose.model<IAppUpdate>('AppUpdate', appUpdateSchema);
