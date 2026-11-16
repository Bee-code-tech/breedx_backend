import { Schema, Types, model } from 'mongoose';

export interface IAnnouncement {
  _id: Types.ObjectId;
  space: Types.ObjectId;
  author: Types.ObjectId;
  /** Kept so the name still shows after the author leaves. */
  authorName: string;
  title: string;
  body: string;
  /** Sent even in quiet hours, and marked in the tab. */
  important: boolean;
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// A message from a space's owner or admins to everyone in it
const announcementSchema = new Schema<IAnnouncement>(
  {
    space: { type: Schema.Types.ObjectId, ref: 'Space', required: true },
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: { type: String, required: true },
    title: { type: String, default: '', trim: true },
    body: { type: String, required: true, trim: true },
    important: { type: Boolean, default: false },
    pinned: { type: Boolean, default: false },
  },
  { timestamps: true }
);

announcementSchema.index({ space: 1, pinned: -1, createdAt: -1 });

export default model<IAnnouncement>('Announcement', announcementSchema);
