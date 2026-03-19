import { Schema, model } from 'mongoose';
import { IUser } from '@interfaces/user';

const userSchema = new Schema<IUser>(
  {
    fullname: {
      type: String,
      required: [true, 'Fullname is required'],
      trim: true,
    },
    username: {
      type: String,
      required: [true, 'Username is required'],
      unique: true,
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      select: false,
    },
    gender: {
      type: String,
      enum: ['male', 'female', 'other'],
    },
    religion: String,
    phone_number: String,
    level: String,
    institution: String,
    faculty: String,
    department: String,
    role: {
      type: String,
      enum: [
        'student',
        'student_provider',
        'service_provider',
        'landlord',
        'hostel_rep',
        'campus_ambassador',
        'admin',
      ],
      default: 'student',
    },
    wallet: {
      type: Schema.Types.ObjectId,
      ref: 'Wallet',
    },
    shops: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Shop',
      },
    ],
    properties: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Property',
      },
    ],
  },
  {
    timestamps: true,
  }
);

const User = model<IUser>('User', userSchema);
export default User;
