import { Router } from 'express';
import { claimReferral, getReferrals, publicReferral } from '../controllers/referral.controller';
import { protect } from '../middleware/auth';

const router = Router();

// Public: the invite page shows whose link it is before anyone signs in
router.get('/code/:code', publicReferral);

router.get('/', protect, getReferrals);
router.post('/claim', protect, claimReferral);

export default router;
