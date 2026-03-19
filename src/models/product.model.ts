import { Schema, model } from 'mongoose';
import { IProduct } from '@interfaces/product';

const productSchema = new Schema<IProduct>(
  {
    shop: {
      type: Schema.Types.ObjectId,
      ref: 'Shop',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    image: String,
    description: String,
    price: {
      type: Number,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

export default model<IProduct>('Product', productSchema);
