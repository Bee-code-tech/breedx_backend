import { Schema, model, Document, Types } from 'mongoose';

/** Characters turned into speech this month, per voice tier, for the whole app. */
export interface ISpeechMonth extends Document {
  /** YYYY-MM (UTC), matching Google's monthly free allowance. */
  month: string;
  hd: number;
  wavenet: number;
}

/** Characters a student turned into speech today, for their daily allowance. */
export interface ISpeechDay extends Document {
  user: Types.ObjectId;
  /** YYYY-MM-DD (UTC). */
  day: string;
  chars: number;
}

const speechMonthSchema = new Schema<ISpeechMonth>({
  month: { type: String, required: true, unique: true },
  hd: { type: Number, default: 0 },
  wavenet: { type: Number, default: 0 },
});

const speechDaySchema = new Schema<ISpeechDay>({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  day: { type: String, required: true },
  chars: { type: Number, default: 0 },
});
speechDaySchema.index({ user: 1, day: 1 }, { unique: true });

export const SpeechMonth = model<ISpeechMonth>('SpeechMonth', speechMonthSchema);
export const SpeechDay = model<ISpeechDay>('SpeechDay', speechDaySchema);
