import axios from 'axios';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse = require('pdf-parse');
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { uploadTenderDocument } from './storageService';

// ============================================================================
// DCE DOCUMENT INGESTION (download + parse RC/CCAP/CCTP/AAPC attachments)
// ============================================================================
//
// The BOAMP open-data API (dataCollectionService.ts) only ever gives notice
// metadata - title, buyer, dates, amount. It never includes the actual
// consultation file (dossier de consultation des entreprises). The real DCE
// lives on the buyer's own e-procurement platform (a "profil acheteur" -
// PLACE, e-marchespublics, AWS-hosted local portals, etc.), which the BOAMP
// notice links out to.
//
// This module is honest about that split:
//  - if a candidate link resolves directly to a PDF, we download it and
//    extract real text -> status 'parsed'.
//  - if a candidate link is an HTML page, we look one level deep for an
//    actual document link on it (common on buyer platforms that show a
//    "pieces jointes" list before the file itself) - if we find one, follow
//    it; if not, we record the link as 'external_platform_only' rather than
//    pretending we read something we didn't.
//  - nothing here ever fabricates extracted text.

const MAX_CANDIDATES_PER_OPPORTUNITY = 8;
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB
const MAX_STORED_TEXT_CHARS = 120000; // keeps DB rows bounded; full file stays in storage
const FETCH_TIMEOUT_MS = 20000;

// No \b word-boundary anchors: candidate text is often a snake_case or
// hyphenated key/URL segment (e.g. "ccap_url", "doc-ccap-2026.pdf"), where \b
// doesn't match between "ccap" and an adjacent "_" or "-" (both are \w-safe
// characters as far as \b is concerned). Plain case-insensitive substring
// matching is deliberately looser here since these are short, fairly
// distinctive French procurement acronyms.
const LABEL_HINTS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /ccap/i, label: 'CCAP' },
  { pattern: /cctp/i, label: 'CCTP' },
  { pattern: /reglement.*consultation|(^|[^a-z])rc([^a-z]|$)/i, label: 'RC' },
  { pattern: /aapc|avis.*publicite/i, label: 'AAPC' },
  { pattern: /dc1/i, label: 'DC1' },
  { pattern: /dc2/i, label: 'DC2' },
  { pattern: /dume/i, label: 'DUME' },
  { pattern: /dce|dossier.*consultation/i, label: 'DCE' },
];

const guessLabel = (text: string): string => {
  for (const { pattern, label } of LABEL_HINTS) {
    if (pattern.test(text)) return label;
  }
  return 'Autre';
};

const looksLikeUrl = (value: string): boolean => /^https?:\/\/[^\s"'<>]+$/i.test(value.trim());

/**
 * Recursively walks the raw source record (whatever shape a given connector
 * stored) and collects every string that looks like a URL, deduped, with a
 * best-effort label guessed from the surrounding JSON key / the URL itself.
 * Deliberately generic rather than BOAMP-specific field names, because the
 * actual field that carries an attachment link isn't consistently documented
 * across BOAMP/PLACE/TED and varies by notice type - scanning values is more
 * robust than hardcoding a field name that may not exist on a given record.
 */
export const extractCandidateDocumentUrls = (raw: any): Array<{ url: string; labelHint: string }> => {
  const found = new Map<string, string>(); // url -> labelHint

  const walk = (node: any, keyHint: string) => {
    if (found.size >= MAX_CANDIDATES_PER_OPPORTUNITY * 3) return; // bound worst-case fanout
    if (node == null) return;

    if (typeof node === 'string') {
      if (looksLikeUrl(node) && !found.has(node)) {
        found.set(node, guessLabel(`${keyHint} ${node}`));
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, keyHint);
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, k);
    }
  };

  walk(raw, '');

  // Prefer candidates whose URL/key hints at being a document over generic
  // links (e.g. a buyer's homepage) when we have more than the cap allows.
  const entries = Array.from(found.entries()).map(([url, labelHint]) => ({ url, labelHint }));
  entries.sort((a, b) => {
    const aDoc = a.labelHint !== 'Autre' || /\.pdf($|\?)/i.test(a.url) ? 0 : 1;
    const bDoc = b.labelHint !== 'Autre' || /\.pdf($|\?)/i.test(b.url) ? 0 : 1;
    return aDoc - bDoc;
  });

  return entries.slice(0, MAX_CANDIDATES_PER_OPPORTUNITY);
};

type FetchResult =
  | { kind: 'pdf'; buffer: Buffer; contentType: string; extractedText: string }
  | { kind: 'external_platform_only'; followedFrom?: string }
  | { kind: 'not_a_document' }
  | { kind: 'failed'; error: string };

const isPdfBuffer = (buf: Buffer, contentType: string | undefined): boolean =>
  (contentType || '').toLowerCase().includes('application/pdf') || buf.slice(0, 5).toString('utf-8') === '%PDF-';

/**
 * Fetches one candidate URL and classifies what it actually is. Follows at
 * most one extra hop if the first response is an HTML page that itself links
 * to a PDF (common pattern: buyer platform shows a "pieces jointes" listing
 * page before the file) - never crawls deeper than that.
 */
const fetchAndClassify = async (url: string, allowFollow = true): Promise<FetchResult> => {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: FETCH_TIMEOUT_MS,
      maxContentLength: MAX_FILE_SIZE_BYTES,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400,
      headers: { 'User-Agent': 'MarchesDirect-DCE-Ingestion/1.0' },
    });

    const contentType: string = String(response.headers['content-type'] || '');
    const buffer = Buffer.from(response.data);

    if (isPdfBuffer(buffer, contentType)) {
      let extractedText = '';
      try {
        const parsed = await pdfParse(buffer);
        extractedText = (parsed.text || '').trim();
      } catch (parseErr) {
        logger.warn(`[DCE Ingestion] PDF downloaded but text extraction failed for ${url}:`, parseErr);
      }
      return { kind: 'pdf', buffer, contentType: 'application/pdf', extractedText };
    }

    if (contentType.includes('text/html') && allowFollow) {
      const $ = cheerio.load(buffer.toString('utf-8'));
      const hrefs = new Set<string>();
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        const text = $(el).text() || '';
        if (/\.pdf($|\?)/i.test(href) || /dce|telecharg|piece.*jointe|reglement|ccap|cctp/i.test(`${href} ${text}`)) {
          try {
            hrefs.add(new URL(href, url).toString());
          } catch {
            /* ignore malformed href */
          }
        }
      });

      for (const candidate of Array.from(hrefs).slice(0, 3)) {
        const nested = await fetchAndClassify(candidate, false); // only one hop
        if (nested.kind === 'pdf') return nested;
      }

      // It's a real page, we looked, and there's nothing directly
      // downloadable - most likely a buyer portal requiring manual access.
      return { kind: 'external_platform_only' };
    }

    // Some other binary type (zip of the DCE, a .doc, etc.) - we don't parse
    // it, but it's a genuine document worth keeping a pointer to rather than
    // discarding, so the buyer's platform link isn't lost.
    return { kind: 'not_a_document' };
  } catch (err: any) {
    return { kind: 'failed', error: err?.message || String(err) };
  }
};

const alreadyIngested = async (opportunityId: string, sourceUrl: string): Promise<boolean> => {
  const existing = await db.query(
    'SELECT 1 FROM tender_documents WHERE opportunity_id = $1 AND source_url = $2',
    [opportunityId, sourceUrl]
  );
  return existing.rows.length > 0;
};

/**
 * Discovers and downloads whatever DCE attachments can be found for one
 * opportunity, from whatever URLs are present in its raw source record.
 * Safe to call more than once per opportunity - already-ingested source_urls
 * are skipped (UNIQUE(opportunity_id, source_url) also enforces this at the
 * DB level as a second line of defense).
 */
export const ingestOpportunityDocuments = async (opportunityId: string): Promise<void> => {
  try {
    const oppResult = await db.query('SELECT id, raw_data FROM opportunities WHERE id = $1', [opportunityId]);
    if (oppResult.rows.length === 0) return;

    const rawData = oppResult.rows[0].raw_data;
    await db.query(`UPDATE opportunities SET dce_documents_status = 'processing' WHERE id = $1`, [opportunityId]);

    const candidates = extractCandidateDocumentUrls(rawData);

    if (candidates.length === 0) {
      await db.query(`UPDATE opportunities SET dce_documents_status = 'no_documents_found' WHERE id = $1`, [
        opportunityId,
      ]);
      return;
    }

    let parsedCount = 0;
    let externalOnlyCount = 0;
    let failedCount = 0;

    for (const candidate of candidates) {
      if (await alreadyIngested(opportunityId, candidate.url)) continue;

      const result = await fetchAndClassify(candidate.url);

      if (result.kind === 'pdf') {
        const hash = crypto.createHash('sha256').update(result.buffer).digest('hex');
        const safeName = `${crypto.randomUUID()}.pdf`;

        try {
          const { url: fileUrl, sizeBytes } = await uploadTenderDocument(
            opportunityId,
            safeName,
            result.contentType,
            result.buffer
          );

          await db.query(
            `INSERT INTO tender_documents
              (opportunity_id, document_label, source_url, file_url, file_hash, mime_type,
               file_size_bytes, status, extracted_text)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'parsed', $8)
             ON CONFLICT (opportunity_id, source_url) DO NOTHING`,
            [
              opportunityId,
              candidate.labelHint,
              candidate.url,
              fileUrl,
              hash,
              result.contentType,
              sizeBytes,
              result.extractedText.slice(0, MAX_STORED_TEXT_CHARS),
            ]
          );
          parsedCount++;
        } catch (uploadErr: any) {
          logger.error(`[DCE Ingestion] Storage upload failed for ${candidate.url}:`, uploadErr);
          await db.query(
            `INSERT INTO tender_documents (opportunity_id, document_label, source_url, status, error_message)
             VALUES ($1, $2, $3, 'failed', $4)
             ON CONFLICT (opportunity_id, source_url) DO NOTHING`,
            [opportunityId, candidate.labelHint, candidate.url, uploadErr?.message || String(uploadErr)]
          );
          failedCount++;
        }
      } else if (result.kind === 'external_platform_only') {
        await db.query(
          `INSERT INTO tender_documents (opportunity_id, document_label, source_url, status)
           VALUES ($1, $2, $3, 'external_platform_only')
           ON CONFLICT (opportunity_id, source_url) DO NOTHING`,
          [opportunityId, candidate.labelHint, candidate.url]
        );
        externalOnlyCount++;
      } else if (result.kind === 'not_a_document') {
        await db.query(
          `INSERT INTO tender_documents (opportunity_id, document_label, source_url, status)
           VALUES ($1, $2, $3, 'not_a_document')
           ON CONFLICT (opportunity_id, source_url) DO NOTHING`,
          [opportunityId, candidate.labelHint, candidate.url]
        );
      } else {
        await db.query(
          `INSERT INTO tender_documents (opportunity_id, document_label, source_url, status, error_message)
           VALUES ($1, $2, $3, 'failed', $4)
           ON CONFLICT (opportunity_id, source_url) DO NOTHING`,
          [opportunityId, candidate.labelHint, candidate.url, result.error]
        );
        failedCount++;
      }
    }

    const finalStatus =
      parsedCount > 0 ? 'fetched' : externalOnlyCount > 0 ? 'external_platform_only' : failedCount > 0 ? 'failed' : 'no_documents_found';

    await db.query(`UPDATE opportunities SET dce_documents_status = $1 WHERE id = $2`, [finalStatus, opportunityId]);

    logger.info(
      `[DCE Ingestion] Opportunity ${opportunityId}: ${parsedCount} parsed, ${externalOnlyCount} external-only, ${failedCount} failed -> ${finalStatus}`
    );
  } catch (err) {
    logger.error(`[DCE Ingestion] Failed for opportunity ${opportunityId}:`, err);
    await db.query(`UPDATE opportunities SET dce_documents_status = 'failed' WHERE id = $1`, [opportunityId]).catch(
      () => undefined
    );
  }
};

/**
 * Picks up a bounded batch of opportunities still waiting on document
 * ingestion. Called by the background job (jobs/documentIngestion.ts) rather
 * than inline during BOAMP collection, so a slow/broken buyer platform can
 * never block or slow down the main connector's fetch-1000-notices loop.
 */
export const runPendingDocumentIngestion = async (batchSize = 15): Promise<number> => {
  const pending = await db.query(
    `SELECT id FROM opportunities
     WHERE dce_documents_status = 'pending' OR dce_documents_status IS NULL
     ORDER BY created_at DESC
     LIMIT $1`,
    [batchSize]
  );

  for (const row of pending.rows) {
    await ingestOpportunityDocuments(row.id);
  }

  return pending.rows.length;
};
