import { Schema, model } from 'mongoose';

export const PARTNERSHIP_TYPES = ['companies', 'agencies', 'organizations', 'individuals'] as const;
export type PartnershipType = (typeof PARTNERSHIP_TYPES)[number];

export interface IPartnershipRequest {
  name: string;
  organization?: string;
  email: string;
  phone?: string;
  type: PartnershipType;
  website?: string;
  topic?: string;
  message: string;
  createdAt: Date;
  updatedAt: Date;
}

const partnershipSchema = new Schema<IPartnershipRequest>(
  {
    name: { type: String, required: true, trim: true },
    organization: { type: String, trim: true },
    // One request per email: a second one is answered with 409
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    type: { type: String, enum: PARTNERSHIP_TYPES, required: true },
    website: { type: String, trim: true },
    topic: { type: String, trim: true },
    message: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

export default model<IPartnershipRequest>('PartnershipRequest', partnershipSchema);
