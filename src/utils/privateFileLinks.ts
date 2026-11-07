import crypto from 'crypto';

const TTL_SECONDS = 300;
const privatePath = /^\/uploads\/(companies|tenders)\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/;
const secret = () => {
  const value = process.env.FILE_LINK_SECRET || process.env.JWT_SECRET;
  if (!value) throw new Error('File signing secret is not configured');
  return value;
};
const signature = (path: string, expiry: string) =>
  crypto.createHmac('sha256', secret()).update(`private-file:v1:${path}:${expiry}`).digest('hex');

export function signPrivateFilePath(path: string, now = Date.now()): string {
  if (!privatePath.test(path)) throw new Error('Invalid private file path');
  const expiry = String(Math.floor(now / 1000) + TTL_SECONDS);
  return `${path}?expires=${expiry}&signature=${signature(path, expiry)}`;
}

export function verifyPrivateFilePath(path: string, expiry: unknown, supplied: unknown, now = Date.now()): boolean {
  if (!privatePath.test(path) || typeof expiry !== 'string' || !/^\d{10}$/.test(expiry) ||
      typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  const left = Number(expiry) - Math.floor(now / 1000);
  if (left < 0 || left > TTL_SECONDS) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(signature(path, expiry), 'hex'));
}
