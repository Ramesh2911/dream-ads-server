import mongoose, { Schema, Document } from 'mongoose';

export const INQUIRY_STATUSES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

export const INQUIRY_SUBJECTS = ['project', 'career', 'partnership', 'support', 'other'] as const;
export type InquirySubject = (typeof INQUIRY_SUBJECTS)[number];

export interface IInquiryAttachment {
  filename: string;
  originalName: string;
  mimetype: string;
  size: number;
}

export interface IInquiryNote {
  body: string;
  by: string;
  at: Date;
}

export interface IInquiry extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  email: string;
  phone?: string;
  company?: string;
  subject: InquirySubject;
  service?: string;
  role?: string;
  budget?: string;
  timeline?: string;
  message: string;
  estimate?: { platform?: string; features?: string[]; timeline?: string; complexity?: number };
  source: 'corporate' | 'direct';
  attachment?: IInquiryAttachment | null;
  status: InquiryStatus;
  notes: IInquiryNote[];
  ip?: string;
  userAgent?: string;
  createdAt: Date;
  updatedAt: Date;
}

const inquirySchema = new Schema<IInquiry>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 200 },
    phone: { type: String, trim: true, maxlength: 30 },
    company: { type: String, trim: true, maxlength: 200 },
    subject: { type: String, enum: INQUIRY_SUBJECTS, required: true, default: 'project' },
    service: { type: String, trim: true, maxlength: 200 },
    role: { type: String, trim: true, maxlength: 200 },
    budget: { type: String, trim: true, maxlength: 60 },
    timeline: { type: String, trim: true, maxlength: 60 },
    message: { type: String, required: true, trim: true, maxlength: 5000 },
    estimate: {
      platform: { type: String },
      features: [{ type: String }],
      timeline: { type: String },
      complexity: { type: Number },
    },
    source: { type: String, enum: ['corporate', 'direct'], default: 'corporate' },
    attachment: {
      filename: String,
      originalName: String,
      mimetype: String,
      size: Number,
      _id: false,
    },
    status: { type: String, enum: INQUIRY_STATUSES, default: 'new', index: true },
    notes: [
      {
        body: { type: String, required: true, maxlength: 2000 },
        by: { type: String, required: true },
        at: { type: Date, default: Date.now },
        _id: false,
      },
    ],
    ip: { type: String },
    userAgent: { type: String },
  },
  { timestamps: true }
);

inquirySchema.index({ createdAt: -1 });
inquirySchema.index({ email: 1 });

export const Inquiry = mongoose.model<IInquiry>('Inquiry', inquirySchema);
