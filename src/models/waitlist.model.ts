import { Schema, model } from 'mongoose';

export interface IWaitlistEntry {
  email: string;
  createdAt: Date;
  updatedAt: Date;
}

const waitlistSchema = new Schema<IWaitlistEntry>(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
    },
  },
  { timestamps: true }
);

export default model<IWaitlistEntry>('WaitlistEntry', waitlistSchema);
