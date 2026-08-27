import { Request } from 'express';
import { db } from '../config/database';

// ============================================================================
// BRAND RESOLUTION (Milestone 10 - multi-brand duplication)
// ============================================================================
// Single source of truth for "which brand is this request for", matched by
// Host header against brands.domain, falling back to the oldest configured
// brand (local dev / a single-brand deployment). Previously this exact
// match-then-fallback logic was copy-pasted in brandsPublic.ts and
// seoPagesPublic.ts independently - centralizing it here is what actually
// lets a second brand go live without duplicating code, per the Milestone 10
// acceptance criteria ("no code duplication").
// ============================================================================

export interface ResolvedBrand {
  id: string;
  code: string;
  name: string;
  domain: string;
  logo_url: string | null;
  color_primary: string | null;
  color_secondary: string | null;
  language: string;
  region_focus: string | null;
}

const normalizeHost = (req: Request): string => (req.hostname || '').replace(/^www\./, '');

/**
 * Full brand row for the requesting Host. Used wherever the frontend needs
 * to theme itself (logo, colors) or an endpoint needs the complete record.
 */
export const resolveBrand = async (req: Request): Promise<ResolvedBrand | null> => {
  const host = normalizeHost(req);

  let result = await db.query(
    `SELECT id, code, name, domain, logo_url, color_primary, color_secondary, language, region_focus
     FROM brands WHERE domain = $1 LIMIT 1`,
    [host]
  );

  if (result.rows.length === 0) {
    result = await db.query(
      `SELECT id, code, name, domain, logo_url, color_primary, color_secondary, language, region_focus
       FROM brands ORDER BY created_at ASC LIMIT 1`
    );
  }

  return result.rows[0] ?? null;
};

/**
 * Just the id - the common case (scoping a company, a CRM lead, an SEO page
 * to the right brand) doesn't need the full row.
 */
export const resolveBrandId = async (req: Request): Promise<string | null> => {
  const brand = await resolveBrand(req);
  return brand?.id ?? null;
};
