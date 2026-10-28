import mongoose, { Schema, Document } from 'mongoose';

export interface IVideoSave extends Document {
  _id: mongoose.Types.ObjectId;
  video: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  createdAt: Date;
}

const videoSaveSchema = new Schema<IVideoSave>(
  {
    video: { type: Schema.Types.ObjectId, ref: 'Video', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

videoSaveSchema.index({ video: 1, user: 1 }, { unique: true });
videoSaveSchema.index({ user: 1, createdAt: -1 });

export const VideoSave = mongoose.model<IVideoSave>('VideoSave', videoSaveSchema);
