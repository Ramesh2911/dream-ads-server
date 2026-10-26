import mongoose, { Schema, Document } from 'mongoose';

export interface ITaskSubmission extends Document {
  _id: mongoose.Types.ObjectId;
  task: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  proofUrl?: string;
  proofText?: string;
  status: 'pending' | 'approved' | 'rejected';
  rejectionReason?: string;
  reviewedBy?: mongoose.Types.ObjectId;
  reviewedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const taskSubmissionSchema = new Schema<ITaskSubmission>(
  {
    task: { type: Schema.Types.ObjectId, ref: 'Task', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    proofUrl: String,
    proofText: String,
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    rejectionReason: String,
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
    reviewedAt: Date,
  },
  { timestamps: true }
);

taskSubmissionSchema.index({ task: 1, user: 1 }, { unique: true });

export const TaskSubmission = mongoose.model<ITaskSubmission>('TaskSubmission', taskSubmissionSchema);
