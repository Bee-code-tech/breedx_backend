import { Document, Schema } from 'mongoose';

export interface IWallet extends Document {
  user: Schema.Types.ObjectId;
  balance: number;
  withdrawal_pin: string;
  account_number: string;
  bank_code: string;
  bvn: string;
  nin: string;
  createdAt: Date;
  updatedAt: Date;
}
