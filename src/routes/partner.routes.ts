import { Router } from 'express';
import {
  getPayoutDetails,
  partnerEarnings,
  partnerOverview,
  partnerReferrals,
  setPayoutDetails,
} from '../controllers/partner.controller';
import { protect } from '../middleware/auth';
import { requirePartner } from '../middleware/roles';

const router = Router();
router.use(protect, requirePartner);

router.get('/overview', partnerOverview);
router.get('/referrals', partnerReferrals);
router.get('/earnings', partnerEarnings);
router.get('/payout-details', getPayoutDetails);
router.put('/payout-details', setPayoutDetails);

export default router;
