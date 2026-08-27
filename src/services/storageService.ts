import AWS from 'aws-sdk';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger';

// ============================================================================
// FILE STORAGE (replaces the URL-paste placeholder for company documents)
// ============================================================================
//
// Uses real AWS S3 when AWS_S3_BUCKET + AWS credentials are configured (the
// production path - all client accounts, including hosting/storage, are
// meant to be created under the client's own name per Payment_Terms_v1_2).
// Falls back to local disk storage (served via /uploads static route) when
// S3 isn't configured yet, so upload actually works end-to-end in dev/staging
// without blocking on the client creating an AWS account first. The fallback
// is logged loudly on every startup so it's never silently mistaken for the
// production path.

const S3_BUCKET = process.env.AWS_S3_BUCKET;
const S3_REGION = process.env.AWS_REGION || 'eu-west-3';
const LOCAL_UPLOAD_DIR = process.env.LOCAL_UPLOAD_DIR || path.join(process.cwd(), 'uploads');

const s3 = S3_BUCKET
  ? new AWS.S3({
      region: S3_REGION,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    })
  : null;

export const storageMode = (): 'S3' | 'LOCAL_DISK' => (s3 ? 'S3' : 'LOCAL_DISK');

if (!s3) {
  logger.warn(
    '[storageService] AWS_S3_BUCKET not set - using local disk storage at ' +
      `${LOCAL_UPLOAD_DIR}. This is fine for dev/staging but NOT for production: ` +
      'files won\u2019t survive a redeploy and won\u2019t be under the client\u2019s own account. ' +
      'Set AWS_S3_BUCKET + AWS credentials before going live.'
  );
  if (!fs.existsSync(LOCAL_UPLOAD_DIR)) {
    fs.mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });
  }
}

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15MB

export class UploadValidationError extends Error {}

export function validateUpload(file: Express.Multer.File) {
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    throw new UploadValidationError(`Type de fichier non autorisé : ${file.mimetype}. Formats acceptés : PDF, JPG, PNG, DOC, DOCX.`);
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new UploadValidationError('Fichier trop volumineux (15 Mo maximum).');
  }
}

/**
 * Uploads a file buffer and returns its publicly-fetchable URL.
 * companyId is used as a folder prefix so one company's documents are never
 * mixed with another's, and so leaked URLs are at least attributable.
 */
export async function uploadCompanyFile(
  companyId: string,
  originalName: string,
  mimetype: string,
  buffer: Buffer
): Promise<{ url: string; sizeBytes: number }> {
  const ext = path.extname(originalName) || '';
  const safeName = `${crypto.randomUUID()}${ext}`;
  const key = `companies/${companyId}/${safeName}`;

  if (s3 && S3_BUCKET) {
    await s3
      .putObject({
        Bucket: S3_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: mimetype,
        // Documents are administrative (KBIS, insurance, DC1/DC2...) - never
        // public. Access happens through the API using a presigned URL.
        ACL: 'private',
      })
      .promise();

    return { url: key, sizeBytes: buffer.length }; // store the S3 key; resolve to a presigned URL on read
  }

  // Local disk fallback
  const dir = path.join(LOCAL_UPLOAD_DIR, 'companies', companyId);
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, safeName);
  fs.writeFileSync(filepath, buffer);

  return { url: `/uploads/companies/${companyId}/${safeName}`, sizeBytes: buffer.length };
}

/**
 * Uploads a downloaded DCE attachment (RC/CCAP/CCTP/etc.) fetched from a
 * connector source. Same S3-with-local-disk-fallback behaviour as
 * uploadCompanyFile, but keyed by opportunityId instead of companyId since
 * these documents are shared across every company bidding on the tender, not
 * owned by one company - see tender_documents in schema.sql.
 */
export async function uploadTenderDocument(
  opportunityId: string,
  safeName: string,
  mimetype: string,
  buffer: Buffer
): Promise<{ url: string; sizeBytes: number }> {
  const key = `tenders/${opportunityId}/${safeName}`;

  if (s3 && S3_BUCKET) {
    await s3
      .putObject({
        Bucket: S3_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: mimetype,
        ACL: 'private',
      })
      .promise();

    return { url: key, sizeBytes: buffer.length };
  }

  const dir = path.join(LOCAL_UPLOAD_DIR, 'tenders', opportunityId);
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, safeName);
  fs.writeFileSync(filepath, buffer);

  return { url: `/uploads/tenders/${opportunityId}/${safeName}`, sizeBytes: buffer.length };
}

/**
 * Resolves a stored reference (S3 key or local path) into a URL the browser
 * can actually fetch. For S3, that means a short-lived presigned URL since
 * objects are private; for local disk, the static /uploads path already works.
 */
export async function resolveFileUrl(storedRef: string): Promise<string> {
  if (s3 && S3_BUCKET && !storedRef.startsWith('/uploads/')) {
    return s3.getSignedUrlPromise('getObject', {
      Bucket: S3_BUCKET,
      Key: storedRef,
      Expires: 300, // 5 minutes
    });
  }
  return storedRef;
}
