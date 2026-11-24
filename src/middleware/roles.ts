import { NextFunction, Response } from 'express';
import User from '../models/user.model';
import { AuthRequest } from '../types/auth';

// Checked against the database each time, so a change by an admin applies at
// once (the access token's role could be minutes old). Use after `protect`.

export const requireAdmin = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = await User.findById(req.user!.id).select('role').lean();
    if (user?.role !== 'admin') {
      res.status(403).json({ success: false, message: 'Admins only', code: 'FORBIDDEN' });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
};

export const requirePartner = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = await User.findById(req.user!.id).select('isPartner').lean();
    if (!user?.isPartner) {
      res.status(403).json({ success: false, message: 'Partners only', code: 'FORBIDDEN' });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
};
