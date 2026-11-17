import mongoose, { Schema, Document } from 'mongoose';

export interface IDeletionRequest extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  name: string;
  idNo: string;
  phone: string;
  email: string;
  notes?: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewedBy?: mongoose.Types.ObjectId;
  reviewedAt?: Date;
  rejectReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const deletionRequestSchema = new Schema<IDeletionRequest>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    idNo: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    notes: { type: String, trim: true, maxlength: 500 },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
    reviewedAt: { type: Date },
    rejectReason: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

deletionRequestSchema.index({ status: 1, createdAt: -1 });

export const DeletionRequest = mongoose.model<IDeletionRequest>('DeletionRequest', deletionRequestSchema);
