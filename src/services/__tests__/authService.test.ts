import bcrypt from 'bcryptjs';
import { db } from '../../config/database';
import { changePassword, requestPasswordReset } from '../authService';
import { sendEmail } from '../emailService';

jest.mock('../../config/database', () => ({
  db: { query: jest.fn() },
}));

jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
  hash: jest.fn(async () => 'new-hashed-password'),
  genSalt: jest.fn(async () => 'salt'),
}));

jest.mock('../emailService', () => ({
  sendEmail: jest.fn(async () => true),
}));

const mockedSendEmail = sendEmail as unknown as jest.Mock;
const mockedDb = db as unknown as { query: jest.Mock };
const mockedBcrypt = bcrypt as unknown as { compare: jest.Mock; hash: jest.Mock; genSalt: jest.Mock };

describe('changePassword', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects when the current password does not match the stored hash', async () => {
    mockedDb.query.mockResolvedValueOnce({ rows: [{ password_hash: 'stored-hash' }] });
    mockedBcrypt.compare.mockResolvedValueOnce(false);

    await expect(changePassword('user-1', 'wrong-password', 'newpassword123')).rejects.toThrow(
      'Mot de passe actuel incorrect.'
    );

    expect(mockedBcrypt.compare).toHaveBeenCalledWith('wrong-password', 'stored-hash');
    // Only the SELECT ran - must not fall through to updating the password.
    expect(mockedDb.query).toHaveBeenCalledTimes(1);
  });

  it('rejects a passwordless (magic-link only) account rather than accepting any current password', async () => {
    // registerCompanyAndUser leaves password_hash NULL for passwordless accounts.
    mockedDb.query.mockResolvedValueOnce({ rows: [{ password_hash: null }] });

    await expect(changePassword('user-2', 'anything', 'newpassword123')).rejects.toThrow(
      'Mot de passe actuel incorrect.'
    );
    // Never calls bcrypt.compare against a null hash.
    expect(mockedBcrypt.compare).not.toHaveBeenCalled();
  });

  it('rejects when the user cannot be found', async () => {
    mockedDb.query.mockResolvedValueOnce({ rows: [] });

    await expect(changePassword('missing-user', 'whatever', 'newpassword123')).rejects.toThrow(
      'Utilisateur introuvable.'
    );
  });

  it('updates the password and invalidates sessions once the current password is verified', async () => {
    mockedDb.query
      .mockResolvedValueOnce({ rows: [{ password_hash: 'stored-hash' }] }) // SELECT password_hash
      .mockResolvedValueOnce({ rows: [] }) // UPDATE users
      .mockResolvedValueOnce({ rows: [] }); // DELETE user_sessions
    mockedBcrypt.compare.mockResolvedValueOnce(true);

    const result = await changePassword('user-3', 'correct-password', 'newpassword123');

    expect(result).toEqual({ success: true });
    expect(mockedBcrypt.compare).toHaveBeenCalledWith('correct-password', 'stored-hash');
    expect(mockedDb.query).toHaveBeenCalledTimes(3);
    expect(mockedDb.query.mock.calls[1][0]).toMatch(/UPDATE users SET password_hash/);
    expect(mockedDb.query.mock.calls[2][0]).toMatch(/DELETE FROM user_sessions/);
  });
});

describe('registerCompanyAndUser', () => {
  it('never grants a platform admin role to a self-service signup', async () => {
    const { registerCompanyAndUser } = await import('../authService');
    const calls: Array<{ sql: string; params: any[] }> = [];
    const client = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        calls.push({ sql, params });
        if (/SELECT id FROM users WHERE email/.test(sql)) return { rows: [] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    (mockedDb as any).getClient = jest.fn(async () => client);

    await registerCompanyAndUser(
      { companyName: 'Acme', firstName: 'A', lastName: 'B', email: 'new@acme.fr', password: 'Testpass123!' } as any,
      'brand-1'
    );

    // The refresh token it hands back must be refreshable: a session row holding
    // its SHA-256 (never the raw token, never bcrypt - bcrypt truncates JWTs).
    const sessionInsert = mockedDb.query.mock.calls.find((c: any[]) => /INSERT INTO user_sessions/.test(String(c[0])));
    expect(sessionInsert).toBeDefined();
    expect(sessionInsert![1][1]).toMatch(/^[0-9a-f]{64}$/);

    const userInsert = calls.find((c) => /INSERT INTO users/.test(c.sql));
    expect(userInsert).toBeDefined();
    // params order: id, company_id, email, password_hash, first_name, last_name, phone, role, status
    expect(userInsert!.params[7]).toBe('user');
    expect(['admin', 'super_admin']).not.toContain(userInsert!.params[7]);
  });
});

describe('MFA (2FA)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const speakeasy = require('speakeasy');
  const { enableMFA, verifyMFASetup, verifyMFALogin, disableMFA, loginUser } = require('../authService');
  const { signMfaChallenge } = require('../../middleware/auth');
  const { encryptSecret } = require('../../utils/encryption');

  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0'.repeat(63) + '1';
  const secret = speakeasy.generateSecret({ length: 20 }).base32 as string;
  const validCode = () => speakeasy.totp({ secret, encoding: 'base32' });
  const storedSecret = () => encryptSecret(secret);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('enableMFA returns a QR data URL and refuses when 2FA is already on', async () => {
    mockedDb.query
      .mockResolvedValueOnce({ rows: [{ email: 'a@b.fr', mfa_enabled: false }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await enableMFA('u1');
    expect(res.qrCode.startsWith('data:image/png;base64,')).toBe(true);
    expect(res.manualEntryKey).toBe(res.secret);

    mockedDb.query.mockReset();
    mockedDb.query.mockResolvedValueOnce({ rows: [{ email: 'a@b.fr', mfa_enabled: true }] });
    await expect(enableMFA('u1')).rejects.toThrow('déjà activée');
    // Must not have rewritten the secret / switched 2FA off.
    expect(mockedDb.query).toHaveBeenCalledTimes(1);
  });

  it('verifyMFASetup only switches 2FA on for a valid code', async () => {
    mockedDb.query.mockResolvedValueOnce({ rows: [{ mfa_secret_encrypted: storedSecret() }] });
    await expect(verifyMFASetup('u1', '000000')).rejects.toThrow('Code invalide.');
    expect(mockedDb.query).toHaveBeenCalledTimes(1);

    mockedDb.query.mockResolvedValueOnce({ rows: [{ mfa_secret_encrypted: storedSecret() }] });
    mockedDb.query.mockResolvedValueOnce({ rows: [] });
    await expect(verifyMFASetup('u1', validCode())).resolves.toEqual({ success: true });
    expect(mockedDb.query.mock.calls[2][0]).toContain('mfa_enabled = true');
  });

  it('verifyMFALogin rejects a missing/forged challenge token even with a valid code', async () => {
    await expect(verifyMFALogin('not-a-jwt', validCode())).rejects.toThrow('expirée');
    // A userId is not a credential any more.
    await expect(verifyMFALogin('11111111-1111-1111-1111-111111111111', validCode())).rejects.toThrow('expirée');
    expect(mockedDb.query).not.toHaveBeenCalled();
  });

  it('verifyMFALogin issues a session for challenge + valid code, and rejects a wrong code', async () => {
    const challenge = signMfaChallenge('u1');
    const row = { id: 'u1', email: 'a@b.fr', first_name: 'A', role: 'admin', mfa_enabled: true, mfa_secret_encrypted: storedSecret(), company_id: 'c1' };

    mockedDb.query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] });
    await expect(verifyMFALogin(challenge, '000000')).rejects.toThrow('Code invalide.');

    mockedDb.query.mockReset();
    mockedDb.query.mockResolvedValue({ rows: [row] });
    const res = await verifyMFALogin(challenge, validCode());
    expect(res.accessToken).toBeTruthy();
    expect(res.refreshToken).toBeTruthy();
    expect(res.email).toBe('a@b.fr');
  });

  it('loginUser returns a challenge (no tokens) for an MFA-enabled account', async () => {
    mockedDb.query
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // recent failed attempts
      .mockResolvedValueOnce({ rows: [{ id: 'u1', email: 'a@b.fr', password_hash: 'h', mfa_enabled: true }] });
    mockedBcrypt.compare.mockResolvedValueOnce(true);
    const res = await loginUser('a@b.fr', 'pw');
    expect(res.mfaRequired).toBe(true);
    expect(res.mfaToken).toBeTruthy();
    expect((res as any).accessToken).toBeUndefined();
  });

  it('disableMFA needs the right password AND a valid code', async () => {
    const row = { password_hash: 'h', mfa_enabled: true, mfa_secret_encrypted: storedSecret() };

    mockedDb.query.mockResolvedValueOnce({ rows: [row] });
    mockedBcrypt.compare.mockResolvedValueOnce(false);
    await expect(disableMFA('u1', 'bad', validCode())).rejects.toThrow('Mot de passe incorrect.');

    mockedDb.query.mockResolvedValueOnce({ rows: [row] });
    mockedBcrypt.compare.mockResolvedValueOnce(true);
    await expect(disableMFA('u1', 'pw', '000000')).rejects.toThrow('Code invalide.');
    expect(mockedDb.query).toHaveBeenCalledTimes(2); // two SELECTs, no UPDATE

    mockedDb.query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] });
    mockedBcrypt.compare.mockResolvedValueOnce(true);
    await expect(disableMFA('u1', 'pw', validCode())).resolves.toEqual({ success: true });
    expect(mockedDb.query.mock.calls[3][0]).toContain('mfa_enabled = false');
  });
});

describe('requestPasswordReset', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    jest.clearAllMocks();
    mockedDb.query.mockReset();
  });

  it('never returns a token and answers identically for an unknown email', async () => {
    mockedDb.query.mockResolvedValue({ rows: [] });

    const result = await requestPasswordReset('nobody@example.com');
    await flush();

    expect(result).toEqual({ success: true });
    expect(mockedSendEmail).not.toHaveBeenCalled();
  });

  it('never returns a token for an existing account either, and emails a sign-in link instead', async () => {
    mockedDb.query
      .mockResolvedValueOnce({ rows: [{ id: 'user-1', first_name: 'Awa' }] }) // SELECT user
      .mockResolvedValueOnce({ rows: [] }); // INSERT magic_link_tokens

    const result = await requestPasswordReset('awa@example.com');
    await flush();

    // Same shape as the unknown-email case: no resetToken, no hint the account exists.
    expect(result).toEqual({ success: true });
    expect(Object.keys(result)).toEqual(['success']);
    expect(mockedSendEmail).toHaveBeenCalledTimes(1);
    expect(mockedSendEmail.mock.calls[0][0].to).toBe('awa@example.com');
    // The old flow stuffed the token into user_sessions (which refresh tokens trust).
    const sqls = mockedDb.query.mock.calls.map((c: any[]) => String(c[0]));
    expect(sqls.some((q) => q.includes('user_sessions'))).toBe(false);
  });

  it('still succeeds when the email provider fails (no existence oracle via errors)', async () => {
    mockedDb.query
      .mockResolvedValueOnce({ rows: [{ id: 'user-1', first_name: 'Awa' }] })
      .mockResolvedValueOnce({ rows: [] });
    mockedSendEmail.mockRejectedValueOnce(new Error('smtp down'));

    await expect(requestPasswordReset('awa@example.com')).resolves.toEqual({ success: true });
    await flush();
  });
});

describe('refreshAccessToken / logoutSession', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('crypto');
  const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

  beforeEach(() => {
    jest.clearAllMocks();
    mockedDb.query.mockReset();
  });

  it('rejects a perfectly valid refresh JWT that matches no stored session (no more "any row will do")', async () => {
    const { refreshAccessToken } = await import('../authService');
    const { generateTokens } = await import('../../middleware/auth');
    const { refreshToken } = generateTokens('user-1', 'a@b.c');
    mockedDb.query
      .mockResolvedValueOnce({ rows: [] }) // rotation UPDATE: no current/prev match
      .mockResolvedValueOnce({ rows: [] }); // legacy bcrypt rows: none

    await expect(refreshAccessToken(refreshToken)).rejects.toThrow('Session expired');
  });

  it('rotates: stores only the new token\'s SHA-256, matched against the presented token\'s SHA-256', async () => {
    const { refreshAccessToken } = await import('../authService');
    const { generateTokens } = await import('../../middleware/auth');
    const { refreshToken } = generateTokens('user-1', 'a@b.c');
    mockedDb.query.mockResolvedValueOnce({ rows: [{ id: 'sess-1' }] });

    const out = await refreshAccessToken(refreshToken);

    expect(out.refreshToken).not.toBe(refreshToken); // rotated, not reused
    const [sql, params] = mockedDb.query.mock.calls[0];
    expect(String(sql)).toMatch(/UPDATE user_sessions/);
    expect(params[0]).toBe('user-1');
    expect(params[1]).toBe(sha(refreshToken)); // presented token is looked up by hash
    expect(params[2]).toBe(sha(out.refreshToken)); // only the new token's hash is stored
    expect(JSON.stringify(params)).not.toContain(out.refreshToken); // never the raw token
  });

  it('upgrades a legacy bcrypt session once instead of logging everyone out on deploy', async () => {
    const { refreshAccessToken } = await import('../authService');
    const { generateTokens } = await import('../../middleware/auth');
    const { refreshToken } = generateTokens('user-1', 'a@b.c');
    mockedDb.query
      .mockResolvedValueOnce({ rows: [] }) // no sha match
      .mockResolvedValueOnce({ rows: [{ id: 'old-1', refresh_token_hash: '$2a$05$legacy' }] })
      .mockResolvedValueOnce({ rows: [] }); // upgrade UPDATE
    mockedBcrypt.compare.mockResolvedValueOnce(true);

    const out = await refreshAccessToken(refreshToken);

    expect(out.accessToken).toBeTruthy();
    const upgrade = mockedDb.query.mock.calls[2];
    expect(upgrade[1]).toEqual(['old-1', sha(out.refreshToken)]);
  });

  it('rejects a forged / garbage token before touching the database', async () => {
    const { refreshAccessToken } = await import('../authService');
    await expect(refreshAccessToken('not.a.jwt')).rejects.toThrow();
    await expect(refreshAccessToken(undefined as any)).rejects.toThrow();
    expect(mockedDb.query).not.toHaveBeenCalled();
  });

  it('logout deletes the session by token hash and never throws', async () => {
    const { logoutSession } = await import('../authService');
    mockedDb.query.mockResolvedValueOnce({ rows: [] });
    await logoutSession('some-refresh-token');
    expect(mockedDb.query.mock.calls[0][1]).toEqual([sha('some-refresh-token')]);

    mockedDb.query.mockRejectedValueOnce(new Error('db down'));
    await expect(logoutSession('x')).resolves.toBeUndefined();
    await expect(logoutSession(undefined as any)).resolves.toBeUndefined();
  });
});
