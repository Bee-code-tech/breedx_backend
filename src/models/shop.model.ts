import { Schema, model } from 'mongoose';
import { IShop } from '@interfaces/shop';

const shopSchema = new Schema<IShop>(
  {
    owner: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    image: String,
    description: String,
    opening_time: String,
    closing_time: String,
    delivery_fee: Number,
    products: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Product',
      },
    ],
  },
  {
    timestamps: true,
  }
);

export default model<IShop>('Shop', shopSchema);
