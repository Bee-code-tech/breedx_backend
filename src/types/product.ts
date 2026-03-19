import { Document, Schema } from 'mongoose';

export interface IProduct extends Document {
  shop: Schema.Types.ObjectId;
  name: string;
  image: string;
  description: string;
  price: number;
  createdAt: Date;
  updatedAt: Date;
}
