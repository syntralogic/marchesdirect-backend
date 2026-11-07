import { refreshAccessToken } from '../authService';
import { generateTokens, authenticate, optionalAuth } from '../../middleware/auth';
import { refreshTokenDigest } from '../../utils/tokenSecurity';
import { db } from '../../config/database';

jest.mock('../../config/database', () => ({ db: { query: jest.fn(), transaction: jest.fn() } }));
jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));

describe('session credential security', () => {
  beforeEach(() => (db.query as jest.Mock).mockReset());
  it('issues different full refresh credentials even within one second', () => {
    const a = generateTokens('user-a', 'a@example.invalid').refreshToken;
    const b = generateTokens('user-a', 'a@example.invalid').refreshToken;
    expect(a.slice(0, 72)).toBe(b.slice(0, 72));
    expect(refreshTokenDigest(a)).not.toBe(refreshTokenDigest(b));
  });
  it('checks the exact credential in storage and rejects a missing/revoked session', async () => {
    const token = generateTokens('user-a', 'a@example.invalid').refreshToken;
    (db.query as jest.Mock).mockResolvedValue({ rows: [] });
    await expect(refreshAccessToken(token)).rejects.toThrow('Session expired');
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('s.refresh_token_hash = $2'), ['user-a', refreshTokenDigest(token)]);
  });
  it('renews a registered credential without breaking concurrent browser tabs', async () => {
    const token = generateTokens('user-a', 'a@example.invalid').refreshToken;
    (db.query as jest.Mock).mockResolvedValue({ rows: [{ email: 'a@example.invalid', auth_tokens_valid_after: null }] });
    const r = await refreshAccessToken(token);
    expect(r.refreshToken).toBe(token);
    expect(r.accessToken).toBeTruthy();
  });
  it('rejects access credentials issued before logout-everywhere on protected and optional routes', async () => {
    const token = generateTokens('user-a', 'a@example.invalid').accessToken;
    (db.query as jest.Mock).mockResolvedValue({ rows: [{ id: 'user-a', auth_tokens_valid_after: new Date(Date.now() + 1000) }] });
    const req: any = { headers: { authorization: `Bearer ${token}` } };
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    await optionalAuth(req, res, next);
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
