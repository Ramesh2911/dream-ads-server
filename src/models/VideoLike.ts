import mongoose, { Schema, Document } from 'mongoose';

export interface IVideoLike extends Document {
  _id: mongoose.Types.ObjectId;
  video: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  createdAt: Date;
}

const videoLikeSchema = new Schema<IVideoLike>(
  {
    video: { type: Schema.Types.ObjectId, ref: 'Video', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

videoLikeSchema.index({ video: 1, user: 1 }, { unique: true });

export const VideoLike = mongoose.model<IVideoLike>('VideoLike', videoLikeSchema);
