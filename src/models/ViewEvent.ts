import mongoose, { Schema, Document } from 'mongoose';

export interface IViewEvent extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  video: mongoose.Types.ObjectId;
  watchedSeconds: number;
  rewarded: boolean;
  createdAt: Date;
}

const viewEventSchema = new Schema<IViewEvent>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    video: { type: Schema.Types.ObjectId, ref: 'Video', required: true },
    watchedSeconds: { type: Number, default: 0 },
    rewarded: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

viewEventSchema.index({ user: 1, video: 1, createdAt: -1 });

export const ViewEvent = mongoose.model<IViewEvent>('ViewEvent', viewEventSchema);
