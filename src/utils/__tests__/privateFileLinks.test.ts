import { signPrivateFilePath, verifyPrivateFilePath } from '../privateFileLinks';

describe('private document links', () => {
  const path = '/uploads/companies/company-a/document.pdf';
  const now = 1_794_000_000_000;
  const valid = (url: URL, at = now) => verifyPrivateFilePath(url.pathname, url.searchParams.get('expires'), url.searchParams.get('signature'), at);
  it('allows the intended document for five minutes and rejects expiry', () => {
    const url = new URL(signPrivateFilePath(path, now), 'https://backend.test');
    expect(valid(url)).toBe(true);
    expect(valid(url, now + 301000)).toBe(false);
  });
  it('rejects absent credentials, a changed file, and a changed expiry', () => {
    expect(verifyPrivateFilePath(path, undefined, undefined, now)).toBe(false);
    const url = new URL(signPrivateFilePath(path, now), 'https://backend.test');
    url.pathname = '/uploads/companies/company-b/document.pdf';
    expect(valid(url)).toBe(false);
    url.pathname = path;
    url.searchParams.set('expires', String(Number(url.searchParams.get('expires')) + 1));
    expect(valid(url)).toBe(false);
  });
  it('refuses traversal and malformed signatures without throwing', () => {
    expect(() => signPrivateFilePath('/uploads/companies/a/../secret', now)).toThrow();
    expect(verifyPrivateFilePath(path, '1794000300', ['x'], now)).toBe(false);
  });
});
