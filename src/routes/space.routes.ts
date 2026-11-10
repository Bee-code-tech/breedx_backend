import { Router } from 'express';
import {
  addMaterials,
  createCourse,
  createSpace,
  deleteCourse,
  deleteSpace,
  getSpace,
  inviteMembers,
  joinSpace,
  leaveSpace,
  listSpaces,
  previewInvite,
  removeMaterial,
  removeMember,
  renameMaterial,
  setMemberRole,
  updateCourse,
  updateSpace,
} from '../controllers/space.controller';
import {
  addEntry,
  getSchedule,
  hideFromHome,
  removeEntry,
  saveAll,
  setPrefs,
  setHomeSpace,
  updateEntry,
} from '../controllers/schedule.controller';
import {
  completeMaterialUpload,
  getMaterialContent,
  saveMaterialToLibrary,
  startMaterialUpload,
} from '../controllers/spaceMaterial.controller';
import { protect } from '../middleware/auth';
import { refreshLimiter } from '../middleware/rateLimit';

const router = Router();

router.use(protect);

// Fixed paths before /:slug so they're never read as a slug
router.get('/', listSpaces);
router.post('/', refreshLimiter, createSpace);
router.get('/invite/:code', previewInvite);
router.post('/invite/:code/join', refreshLimiter, joinSpace);

router.get('/:slug', getSpace);
router.patch('/:slug', updateSpace);
router.delete('/:slug', deleteSpace);
router.post('/:slug/leave', leaveSpace);

router.post('/:slug/invites', refreshLimiter, inviteMembers);
router.patch('/:slug/members/:memberId', setMemberRole);
router.delete('/:slug/members/:memberId', removeMember);

router.post('/:slug/courses', createCourse);
router.patch('/:slug/courses/:courseId', updateCourse);
router.delete('/:slug/courses/:courseId', deleteCourse);

router.post('/:slug/materials', addMaterials);
// Course materials as real files: start → browser PUTs to uploadUrl → complete
router.post('/:slug/courses/:courseId/uploads', refreshLimiter, startMaterialUpload);
router.post('/:slug/materials/:materialId/complete', completeMaterialUpload);
router.get('/:slug/materials/:materialId/content', getMaterialContent);
router.post('/:slug/materials/:materialId/save', saveMaterialToLibrary);
router.patch('/:slug/materials/:materialId', renameMaterial);
router.delete('/:slug/materials/:materialId', removeMaterial);

router.get('/:slug/schedule', getSchedule);
router.post('/:slug/schedule', addEntry);
// Before /:entryId so it isn't read as an entry id
router.put('/:slug/schedule/classes', saveAll('class'));
router.put('/:slug/schedule/exams', saveAll('exam'));
router.put('/:slug/schedule/tests', saveAll('test'));
router.put('/:slug/schedule/study', saveAll('study'));
router.patch('/:slug/schedule/prefs', setPrefs);
router.patch('/:slug/schedule/:entryId', updateEntry);
router.delete('/:slug/schedule/:entryId', removeEntry);
router.put('/:slug/home', setHomeSpace);
router.delete('/:slug/home', hideFromHome);

export default router;
