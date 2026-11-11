import mongoose, { Schema, Document } from 'mongoose';

export interface IAnnouncement extends Document {
  _id: mongoose.Types.ObjectId;
  text: string;
  priority: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const announcementSchema = new Schema<IAnnouncement>(
  {
    text: { type: String, required: true, trim: true, maxlength: 300 },
    priority: { type: Number, default: 1, min: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Announcement = mongoose.model<IAnnouncement>('Announcement', announcementSchema);
