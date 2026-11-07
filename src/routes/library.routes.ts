import { Router } from 'express';
import {
  completeUpload,
  copyFile,
  createLibrary,
  deleteLibrary,
  getFileContent,
  getLibrary,
  getUsage,
  listLibraries,
  listSaved,
  moveFile,
  removeFile,
  setSaved,
  startUpload,
  updateFile,
  updateLibrary,
} from '../controllers/library.controller';
import { protect } from '../middleware/auth';
import { refreshLimiter } from '../middleware/rateLimit';

const router = Router();

router.use(protect);

// Fixed paths before /:id so they're never read as a library id
router.get('/', listLibraries);
router.post('/', createLibrary);
router.get('/usage', getUsage);
router.get('/saved', listSaved);

router.get('/:id', getLibrary);
router.patch('/:id', updateLibrary);
router.delete('/:id', deleteLibrary);

// Upload: start → browser PUTs the file to uploadUrl → complete
router.post('/:id/uploads', refreshLimiter, startUpload);
router.post('/:id/files/:fileId/complete', completeUpload);

router.patch('/:id/files/:fileId', updateFile);
router.delete('/:id/files/:fileId', removeFile);
router.post('/:id/files/:fileId/copy', copyFile);
router.post('/:id/files/:fileId/move', moveFile);
router.put('/:id/files/:fileId/save', setSaved(true));
router.delete('/:id/files/:fileId/save', setSaved(false));
router.get('/:id/files/:fileId/content', getFileContent);

export default router;
