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

// The frontend (Vercel) and this API (Render) are on different domains.
// resolveFileUrl/resolveAvatarUrl's local-disk branch used to hand back the
// bare relative path (e.g. "/uploads/avatars/<id>/avatar.jpg") as-is. The
// browser then resolved that against the *frontend's* origin
// (marches-direct.vercel.app/uploads/...), which doesn't exist there - a
// guaranteed 404, not a flaky one, on every local-disk upload (avatars,
// company documents alike), independent of the ephemeral-disk problem below.
// RENDER_EXTERNAL_URL is set automatically by Render on every service;
// BACKEND_PUBLIC_URL is a manual override for any other host.
const PUBLIC_BACKEND_URL = (process.env.BACKEND_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

function toAbsoluteLocalUrl(relativePath: string): string {
  if (!PUBLIC_BACKEND_URL) return relativePath; // best effort - see boot warning below
  return `${PUBLIC_BACKEND_URL}${relativePath}`;
}

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
  if (!PUBLIC_BACKEND_URL) {
    logger.warn(
      '[storageService] Neither RENDER_EXTERNAL_URL nor BACKEND_PUBLIC_URL is set - ' +
        'local-disk file/avatar URLs will be returned as relative paths, which will ' +
        '404 on the frontend\u2019s own domain. Set BACKEND_PUBLIC_URL if this host is not on Render.'
    );
  }
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

const ALLOWED_AVATAR_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_AVATAR_SIZE_BYTES = 5 * 1024 * 1024; // 5MB - avatars are small, no reason to allow a 15MB upload

export function validateAvatarUpload(file: Express.Multer.File) {
  if (!ALLOWED_AVATAR_MIME_TYPES.has(file.mimetype)) {
    throw new UploadValidationError(`Type de fichier non autorisé : ${file.mimetype}. Formats acceptés : JPG, PNG, WEBP.`);
  }
  if (file.size > MAX_AVATAR_SIZE_BYTES) {
    throw new UploadValidationError('Image trop volumineuse (5 Mo maximum).');
  }
}

/**
 * Uploads a profile picture, keyed by userId rather than companyId - an
 * avatar belongs to the person, not the company record, and multiple users
 * can share one company account.
 */
export async function uploadAvatar(
  userId: string,
  mimetype: string,
  buffer: Buffer
): Promise<{ url: string; sizeBytes: number }> {
  const ext = mimetype === 'image/png' ? 'png' : mimetype === 'image/webp' ? 'webp' : 'jpg';
  // Fixed filename per user (not a random UUID) - a new upload should replace
  // the old avatar file, not accumulate orphaned images in storage forever.
  const key = `avatars/${userId}/avatar.${ext}`;

  if (s3 && S3_BUCKET) {
    await s3
      .putObject({
        Bucket: S3_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: mimetype,
        ACL: 'public-read', // avatars are meant to be publicly viewable, unlike company documents
      })
      .promise();

    return { url: key, sizeBytes: buffer.length };
  }

  const dir = path.join(LOCAL_UPLOAD_DIR, 'avatars', userId);
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, `avatar.${ext}`);
  fs.writeFileSync(filepath, buffer);

  return { url: `/uploads/avatars/${userId}/avatar.${ext}`, sizeBytes: buffer.length };
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
  return toAbsoluteLocalUrl(storedRef);
}

/**
 * Same idea as resolveFileUrl, but for avatars specifically: they're
 * uploaded with a public-read ACL (see uploadAvatar), so a permanent public
 * URL is correct here rather than a 5-minute presigned link that would
 * expire mid-page-load or break browser image caching.
 */
export function resolveAvatarUrl(storedRef: string): string {
  if (s3 && S3_BUCKET && !storedRef.startsWith('/uploads/')) {
    return `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${storedRef}`;
  }
  return toAbsoluteLocalUrl(storedRef);
}
