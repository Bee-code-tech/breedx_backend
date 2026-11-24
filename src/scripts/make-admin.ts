// Usage: npm run make-admin -- someone@example.com
// Gives that account admin access (the first admin has to be made this way).
import mongoose from 'mongoose';
import env from '../config/env';
import User from '../models/user.model';

const main = async () => {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) throw new Error('Pass an email: npm run make-admin -- you@example.com');
  await mongoose.connect(env.MONGODB_URI);
  const user = await User.findOneAndUpdate({ email }, { role: 'admin' }, { new: true });
  console.log(user ? `${user.email} is now an admin.` : `No account with ${email}.`);
  await mongoose.disconnect();
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
