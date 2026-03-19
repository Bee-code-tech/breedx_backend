import { Document, Schema } from 'mongoose';

export interface IShop extends Document {
  owner: Schema.Types.ObjectId;
  name: string;
  image: string;
  description: string;
  opening_time: string;
  closing_time: string;
  delivery_fee?: number;
  products: Schema.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}
