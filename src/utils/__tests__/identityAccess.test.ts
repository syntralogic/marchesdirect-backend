import { getIdentityLookupKeys, MAX_SESSION_ID_LENGTH } from '../identityAccess';

describe('getIdentityLookupKeys', () => {
  it('ignores a client-supplied ?email= for anonymous callers (the identity-unlock bypass)', () => {
    const keys = getIdentityLookupKeys({ query: { email: 'victim@example.com' }, user: undefined });
    expect(keys.email).toBe('');
  });

  it('ignores ?email= even alongside a sessionId', () => {
    const keys = getIdentityLookupKeys({ query: { email: 'victim@example.com', sessionId: 'abc-123' } });
    expect(keys).toEqual({ sessionId: 'abc-123', email: '' });
  });

  it('never lets ?email= override the authenticated user email', () => {
    const keys = getIdentityLookupKeys({
      query: { email: 'victim@example.com' },
      user: { email: 'me@example.com' },
    });
    expect(keys.email).toBe('me@example.com');
  });

  it('accepts the visitor\'s own sessionId', () => {
    const id = '3b241101-e2bb-4255-8caf-4136c566a962';
    expect(getIdentityLookupKeys({ query: { sessionId: id } }).sessionId).toBe(id);
  });

  it('rejects array / object / oversized / empty sessionId values', () => {
    expect(getIdentityLookupKeys({ query: { sessionId: ['a', 'b'] } }).sessionId).toBe('');
    expect(getIdentityLookupKeys({ query: { sessionId: { $ne: 'x' } } }).sessionId).toBe('');
    expect(getIdentityLookupKeys({ query: { sessionId: 'x'.repeat(MAX_SESSION_ID_LENGTH + 1) } }).sessionId).toBe('');
    expect(getIdentityLookupKeys({ query: { sessionId: '' } }).sessionId).toBe('');
    expect(getIdentityLookupKeys({ query: {} })).toEqual({ sessionId: '', email: '' });
  });

  it('copes with a request that has no query or user at all', () => {
    expect(getIdentityLookupKeys({})).toEqual({ sessionId: '', email: '' });
  });
});
