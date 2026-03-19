import { Document, Schema } from 'mongoose';

export type UserRole = 
  | 'student' 
  | 'student_provider' 
  | 'service_provider' 
  | 'landlord' 
  | 'hostel_rep' 
  | 'campus_ambassador' 
  | 'admin';

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
  wallet?: Schema.Types.ObjectId;
  shops: Schema.Types.ObjectId[];
  properties: Schema.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}
