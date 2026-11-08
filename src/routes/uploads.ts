import { Router, Response } from 'express';
import multer from 'multer';
import { AuthRequest } from '../middleware/auth';
import {
  uploadCompanyFile,
  validateUpload,
  UploadValidationError,
  uploadAvatar,
  validateAvatarUpload,
  resolveAvatarUrl,
} from '../services/storageService';
import { db } from '../config/database';
import { logger } from '../utils/logger';

const router = Router();

// Memory storage: files are validated and streamed to S3/disk in the handler,
// never trusted to disk unvalidated first.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 10, parts: 11, fieldSize: 8192 } });
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5, parts: 6, fieldSize: 8192 } });

// POST /api/uploads/avatar - profile picture, replaces the previous one.
// Separate from the generic upload endpoint above because avatars need
// tighter validation (images only, 5MB cap - see validateAvatarUpload),
// live under a fixed per-user key instead of accumulating files, and get
// written straight to users.avatar_url instead of being handed back for the
// caller to attach to some other record.
router.post('/avatar', avatarUpload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided (expected multipart field "file")' });
    }

    validateAvatarUpload(req.file);

    const { url } = await uploadAvatar(req.user!.id, req.file.mimetype, req.file.buffer);

    await db.query('UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2', [url, req.user!.id]);

    // 8 nov. : nouvelle photo visible tout de suite malgré le cache navigateur (adresse servie par le serveur + ?v=).
    const fresh = resolveAvatarUrl(url); res.status(201).json({ avatarUrl: fresh.startsWith('http') ? `${fresh}${fresh.includes('?') ? '&' : '?'}v=${Date.now()}` : fresh });
  } catch (err: any) {
    if (err instanceof UploadValidationError) {
      return res.status(400).json({ error: err.message });
    }
    logger.error('Avatar upload error:', err);
    res.status(500).json({ error: "Échec de l'envoi de la photo de profil" });
  }
});

// POST /api/uploads - upload a single file, returns the URL to store on a
// company_documents / company_certifications record.
router.post('/', upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided (expected multipart field "file")' });
    }

    validateUpload(req.file);

    const { url, sizeBytes } = await uploadCompanyFile(
      req.user!.companyId,
      req.file.originalname,
      req.file.mimetype,
      req.file.buffer
    );

    res.status(201).json({ url, sizeBytes, mimeType: req.file.mimetype, originalName: req.file.originalname });
  } catch (err: any) {
    if (err instanceof UploadValidationError) {
      return res.status(400).json({ error: err.message });
    }
    logger.error('File upload error:', err);
    res.status(500).json({ error: "Échec de l'envoi du fichier" });
  }
});

export default router;

