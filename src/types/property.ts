import { Document, Schema } from 'mongoose';

export interface IProperty extends Document {
  landlord: Schema.Types.ObjectId;
  name: string;
  address: string;
  location: {
    type: 'Point';
    coordinates: [number, number]; // [longitude, latitude]
  };
  images: string[];
  amenities: string[];
  price: number;
  rooms_total: number;
  bank_details: {
    bank_name: string;
    account_number: string;
    account_name: string;
  };
  createdAt: Date;
  updatedAt: Date;
}
