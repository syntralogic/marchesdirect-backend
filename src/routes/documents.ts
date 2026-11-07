import { Router, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { AuthRequest } from '../middleware/auth';
import { resolveCompanyFileUrl, normaliseCompanyFileReference } from '../services/storageService';

const router = Router();

// GET /api/documents - list documents for the logged-in company, with expiry status
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.query; // 'valid' | 'expiring' | 'expired'

    let extraCondition = '';
    if (status === 'expired') {
      extraCondition = "AND is_expired = true";
    } else if (status === 'expiring') {
      extraCondition = "AND is_expired = false AND expiry_date IS NOT NULL AND expiry_date <= CURRENT_DATE + INTERVAL '30 days'";
    } else if (status === 'valid') {
      extraCondition = "AND is_expired = false AND (expiry_date IS NULL OR expiry_date > CURRENT_DATE + INTERVAL '30 days')";
    }

    const result = await db.query(
      `SELECT * FROM company_documents
       WHERE company_id = $1 AND deleted_at IS NULL ${extraCondition}
       ORDER BY expiry_date ASC NULLS LAST`,
      [req.user!.companyId]
    );

    const withResolvedUrls = await Promise.all(
      result.rows.map(async (doc) => ({ ...doc, file_url: await resolveCompanyFileUrl(doc.file_url, req.user!.companyId) }))
    );

    res.json(withResolvedUrls);
  } catch (err: any) {
    logger.error('Documents list error:', err);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// GET /api/documents/:id
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      'SELECT * FROM company_documents WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL',
      [req.params.id, req.user!.companyId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    res.json({ ...result.rows[0], file_url: await resolveCompanyFileUrl(result.rows[0].file_url, req.user!.companyId) });
  } catch (err: any) {
    logger.error('Document fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch document' });
  }
});

// PUT /api/documents/:id - replace an expired/updated document (same reusable slot)
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { fileUrl, fileSizeBytes, fileMimeType, issuedDate, expiryDate } = req.body;
    const ownedRef = fileUrl == null ? null : normaliseCompanyFileReference(fileUrl, req.user!.companyId);
    if (fileUrl != null && !ownedRef) return res.status(400).json({ error: 'Envoyez ce fichier depuis votre espace entreprise.' });

    const result = await db.query(
      `UPDATE company_documents SET
         file_url = COALESCE($1, file_url),
         file_size_bytes = COALESCE($2, file_size_bytes),
         file_mime_type = COALESCE($3, file_mime_type),
         file_uploaded_at = NOW(),
         issued_date = COALESCE($4, issued_date),
         expiry_date = COALESCE($5, expiry_date),
         is_expired = false,
         expiry_reminder_sent = false,
         updated_at = NOW()
       WHERE id = $6 AND company_id = $7
       RETURNING *`,
      [ownedRef, fileSizeBytes, fileMimeType, issuedDate, expiryDate, req.params.id, req.user!.companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    res.json({ ...result.rows[0], file_url: await resolveCompanyFileUrl(result.rows[0].file_url, req.user!.companyId) });
  } catch (err: any) {
    logger.error('Document update error:', err);
    res.status(500).json({ error: 'Failed to update document' });
  }
});

export default router;

