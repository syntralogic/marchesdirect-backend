import bcrypt from 'bcryptjs';
import { db } from '../../config/database';
import { changePassword } from '../authService';

jest.mock('../../config/database', () => ({
  db: { query: jest.fn() },
}));

jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
  hash: jest.fn(async () => 'new-hashed-password'),
  genSalt: jest.fn(async () => 'salt'),
}));

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
