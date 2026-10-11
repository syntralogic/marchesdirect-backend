import { normalizeFacebookUrl } from '../companyPresenceService';

describe('normalizeFacebookUrl', () => {
  it('keeps a real page URL', () => {
    expect(normalizeFacebookUrl('https://fr-fr.facebook.com/kb.electricite/?ref=x')).toBe('https://www.facebook.com/kb.electricite');
    expect(normalizeFacebookUrl('facebook.com/kbelec')).toBe('https://www.facebook.com/kbelec');
  });
  it('keeps profile.php ids only', () => {
    expect(normalizeFacebookUrl('https://www.facebook.com/profile.php?id=1234&sk=about')).toBe('https://www.facebook.com/profile.php?id=1234');
  });
  it('rejects share buttons, plugins, root and other hosts', () => {
    expect(normalizeFacebookUrl('https://www.facebook.com/sharer/sharer.php?u=x')).toBeNull();
    expect(normalizeFacebookUrl('https://www.facebook.com/plugins/like.php')).toBeNull();
    expect(normalizeFacebookUrl('https://www.facebook.com/')).toBeNull();
    expect(normalizeFacebookUrl('https://notfacebook.com/abc')).toBeNull();
    expect(normalizeFacebookUrl(null)).toBeNull();
  });
});
