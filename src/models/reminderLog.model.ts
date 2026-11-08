import { Schema, model } from 'mongoose';

// Remembers which reminders went out, so a restart can't send one twice.
// Rows expire after a week.
const reminderLogSchema = new Schema({
  key: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now, expires: 7 * 24 * 60 * 60 },
});

export default model('ReminderLog', reminderLogSchema);
