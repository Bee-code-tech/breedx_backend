export const generateOTP = (): string => {
  // Generate a random 4-digit number
  return Math.floor(1000 + Math.random() * 9000).toString();
};
