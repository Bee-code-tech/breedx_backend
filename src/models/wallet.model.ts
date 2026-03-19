import { Schema, model } from 'mongoose';
import { IWallet } from '@interfaces/wallet';

const walletSchema = new Schema<IWallet>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    balance: {
      type: Number,
      default: 0,
    },
    withdrawal_pin: {
      type: String,
      required: true,
    },
    account_number: String,
    bank_code: String,
    bvn: String,
    nin: String,
  },
  {
    timestamps: true,
  }
);

export default model<IWallet>('Wallet', walletSchema);
