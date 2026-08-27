import { Router, Response } from 'express';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { AuthRequest, checkCompanyAccess } from '../middleware/auth';
import { resolveFileUrl } from '../services/storageService';

const router = Router();

// GET /api/companies/me - fetch own company profile
router.get('/me', async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      'SELECT * FROM companies WHERE id = $1 AND deleted_at IS NULL',
      [req.user!.companyId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }
    res.json(result.rows[0]);
  } catch (err: any) {
    logger.error('Company fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch company' });
  }
});

// PUT /api/companies/me - update own company profile
router.put('/me', async (req: AuthRequest, res: Response) => {
  try {
    const fields = [
      'name', 'kbis_number', 'legal_form', 'siret', 'phone', 'website_url',
      'address_street', 'address_city', 'address_postal_code',
      'industry_sector', 'employee_count', 'annual_revenue', 'founding_year',
      'working_radius_km', 'location_latitude', 'location_longitude',
    ];

    const updates: string[] = [];
    const params: any[] = [];
    let idx = 1;

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${idx++}`);
        params.push(req.body[field]);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(req.user!.companyId);
    const result = await db.query(
      `UPDATE companies SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${idx} AND deleted_at IS NULL RETURNING *`,
      params
    );

    res.json(result.rows[0]);
  } catch (err: any) {
    logger.error('Company update error:', err);
    res.status(500).json({ error: 'Failed to update company' });
  }
});

// ============================================================================
// REUSABLE COMPANY FILE (Klekoon logic, Milestone 9): save once, reuse everywhere
// ============================================================================

// -- Documents --
router.get('/me/documents', async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      'SELECT * FROM company_documents WHERE company_id = $1 AND deleted_at IS NULL ORDER BY document_type',
      [req.user!.companyId]
    );

    const documentsWithResolvedUrls = await Promise.all(
      result.rows.map(async (doc) => ({ ...doc, file_url: await resolveFileUrl(doc.file_url) }))
    );

    res.json(documentsWithResolvedUrls);
  } catch (err: any) {
    logger.error('Documents fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

router.post('/me/documents', async (req: AuthRequest, res: Response) => {
  try {
    const { documentType, documentName, description, fileUrl, fileSizeBytes, fileMimeType, issuedDate, expiryDate } = req.body;

    if (!documentType || !fileUrl) {
      return res.status(400).json({ error: 'documentType and fileUrl are required' });
    }

    const result = await db.query(
      `INSERT INTO company_documents
        (company_id, document_type, document_name, description, file_url, file_size_bytes,
         file_mime_type, file_uploaded_at, issued_date, expiry_date, uploaded_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9, $10)
       RETURNING *`,
      [
        req.user!.companyId, documentType, documentName, description, fileUrl,
        fileSizeBytes, fileMimeType, issuedDate, expiryDate, req.user!.id,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    logger.error('Document upload error:', err);
    res.status(500).json({ error: 'Failed to save document' });
  }
});

router.delete('/me/documents/:id', async (req: AuthRequest, res: Response) => {
  try {
    await db.query(
      'UPDATE company_documents SET deleted_at = NOW() WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user!.companyId]
    );
    res.json({ success: true });
  } catch (err: any) {
    logger.error('Document delete error:', err);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// -- Certifications --
router.get('/me/certifications', async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      'SELECT * FROM company_certifications WHERE company_id = $1 ORDER BY certification_name',
      [req.user!.companyId]
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch certifications' });
  }
});

router.post('/me/certifications', async (req: AuthRequest, res: Response) => {
  try {
    const { certificationName, certificationCode, issuedBy, issuedDate, expiryDate, documentUrl } = req.body;
    const result = await db.query(
      `INSERT INTO company_certifications
        (company_id, certification_name, certification_code, issued_by, issued_date, expiry_date, document_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.user!.companyId, certificationName, certificationCode, issuedBy, issuedDate, expiryDate, documentUrl]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to save certification' });
  }
});

// -- References (past projects, for tech memo reuse) --
router.get('/me/references', async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      'SELECT * FROM company_references WHERE company_id = $1 ORDER BY completion_date DESC',
      [req.user!.companyId]
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch references' });
  }
});

router.post('/me/references', async (req: AuthRequest, res: Response) => {
  try {
    const { projectName, description, clientName, contractValue, contractType, completionDate, skillsDemonstrated, photosUrls } = req.body;
    const result = await db.query(
      `INSERT INTO company_references
        (company_id, project_name, description, client_name, contract_value, contract_type, completion_date, skills_demonstrated, photos_urls)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        req.user!.companyId, projectName, description, clientName, contractValue,
        contractType, completionDate, JSON.stringify(skillsDemonstrated || []), JSON.stringify(photosUrls || []),
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to save reference' });
  }
});

// -- Resources (staff/equipment, for proposal generation) --
router.get('/me/resources', async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      'SELECT * FROM company_resources WHERE company_id = $1 ORDER BY resource_type',
      [req.user!.companyId]
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch resources' });
  }
});

router.post('/me/resources', async (req: AuthRequest, res: Response) => {
  try {
    const { resourceType, name, category, quantity, description, skillsOrSpecs } = req.body;
    const result = await db.query(
      `INSERT INTO company_resources (company_id, resource_type, name, category, quantity, description, skills_or_specs)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.user!.companyId, resourceType, name, category, quantity, description, JSON.stringify(skillsOrSpecs || {})]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to save resource' });
  }
});

// -- Policies (quality/safety/HR text, reused across bids) --
router.get('/me/policies', async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      'SELECT * FROM company_policies WHERE company_id = $1 ORDER BY policy_type',
      [req.user!.companyId]
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch policies' });
  }
});

router.post('/me/policies', async (req: AuthRequest, res: Response) => {
  try {
    const { policyType, policyText, effectiveDate } = req.body;
    const result = await db.query(
      `INSERT INTO company_policies (company_id, policy_type, policy_text, effective_date)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user!.companyId, policyType, policyText, effectiveDate]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to save policy' });
  }
});

// -- Pricing catalog (reusable BPU line items - Milestone 9.2) --
// Built once by the company; used to pre-fill a new bid's pricing schedule
// so they only adjust quantities/prices specific to that tender instead of
// retyping a full BPU from scratch every time. See /bid/:bidId/generate.
router.get('/me/pricing-catalog', async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      'SELECT * FROM company_pricing_items WHERE company_id = $1 AND is_active = true ORDER BY category, label',
      [req.user!.companyId]
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch pricing catalog' });
  }
});

router.post('/me/pricing-catalog', async (req: AuthRequest, res: Response) => {
  try {
    const { label, category, unit, defaultUnitPrice } = req.body;
    if (!label) {
      return res.status(400).json({ error: 'label is required' });
    }
    const result = await db.query(
      `INSERT INTO company_pricing_items (company_id, label, category, unit, default_unit_price)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.user!.companyId, label, category || null, unit || null, defaultUnitPrice || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to save pricing item' });
  }
});

router.put('/me/pricing-catalog/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { label, category, unit, defaultUnitPrice, isActive } = req.body;
    const result = await db.query(
      `UPDATE company_pricing_items SET
         label = COALESCE($1, label),
         category = COALESCE($2, category),
         unit = COALESCE($3, unit),
         default_unit_price = COALESCE($4, default_unit_price),
         is_active = COALESCE($5, is_active),
         updated_at = NOW()
       WHERE id = $6 AND company_id = $7
       RETURNING *`,
      [label, category, unit, defaultUnitPrice, isActive, req.params.id, req.user!.companyId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pricing item not found' });
    }
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update pricing item' });
  }
});

// Soft-delete only (is_active = false) - past bids reference these amounts
// historically; hard-deleting would silently corrupt an already-submitted
// bid package's audit trail.
router.delete('/me/pricing-catalog/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      `UPDATE company_pricing_items SET is_active = false, updated_at = NOW()
       WHERE id = $1 AND company_id = $2 RETURNING id`,
      [req.params.id, req.user!.companyId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pricing item not found' });
    }
    res.status(204).send();
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to remove pricing item' });
  }
});

// GET /api/companies/:companyId - cross-company lookup guarded by checkCompanyAccess
router.get('/:companyId', checkCompanyAccess, async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      'SELECT id, name, industry_sector, address_city, verified FROM companies WHERE id = $1 AND deleted_at IS NULL',
      [req.params.companyId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }
    res.json(result.rows[0]);
  } catch (err: any) {
    logger.error('Company lookup error:', err);
    res.status(500).json({ error: 'Failed to fetch company' });
  }
});

export default router;
