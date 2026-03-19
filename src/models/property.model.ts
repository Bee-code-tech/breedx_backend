import { Schema, model } from 'mongoose';
import { IProperty } from '@interfaces/property';

const propertySchema = new Schema<IProperty>(
  {
    landlord: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    address: {
      type: String,
      required: true,
    },
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        required: true,
      },
    },
    images: [String],
    amenities: [String],
    price: {
      type: Number,
      required: true,
    },
    rooms_total: {
      type: Number,
      required: true,
      default: 0,
    },
    bank_details: {
      bank_name: String,
      account_number: String,
      account_name: String,
    },
  },
  {
    timestamps: true,
  }
);

// Index for geospatial queries (e.g., find properties near me)
propertySchema.index({ location: '2dsphere' });

export default model<IProperty>('Property', propertySchema);
