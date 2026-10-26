import mongoose, { Schema, Document } from 'mongoose';

export interface IChatMessage extends Document {
  _id: mongoose.Types.ObjectId;
  session: mongoose.Types.ObjectId;
  sender: 'user' | 'companion';
  text?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'audio';
  createdAt: Date;
}

const chatMessageSchema = new Schema<IChatMessage>(
  {
    session: { type: Schema.Types.ObjectId, ref: 'ChatSession', required: true, index: true },
    sender: { type: String, enum: ['user', 'companion'], required: true },
    text: String,
    mediaUrl: String,
    mediaType: { type: String, enum: ['image', 'audio'] },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const ChatMessage = mongoose.model<IChatMessage>('ChatMessage', chatMessageSchema);
