import { Document, Schema } from 'mongoose';

export type UserRole = 
  | 'student' 
  | 'student_provider' 
  | 'service_provider' 
  | 'landlord' 
  | 'hostel_rep' 
  | 'campus_ambassador' 
  | 'admin';

export type ServiceCategory = 
  | 'Painting' | 'Plumbing' | 'Electrical' | 'Carpentry' | 'Cleaning' 
  | 'Gardening' | 'AC Maintenance' | 'Pest Control' | 'Interior Decorating' 
  | 'Flooring' | 'Roofing' | 'Security Systems' | 'Solar Installation' 
  | 'Appliance Repair' | 'Masonry' | 'Moving Services' | 'Waste Management' 
  | 'Upholstery' | 'Laundry' | 'Gas Refill';

export interface IUser extends Document {
  fullname: string;
  username: string;
  email: string;
  password: string;
  gender?: string;
  religion?: string;
  phone_number?: string;
  level?: string;
  institution?: string;
  faculty?: string;
  department?: string;
  role: UserRole;
  category?: ServiceCategory;
  isVerified: boolean;
  otp?: string;
  otpExpires?: Date;
  wallet?: Schema.Types.ObjectId;
  shops: Schema.Types.ObjectId[];
  properties: Schema.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}
