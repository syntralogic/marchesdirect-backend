import { classifyGoogleError, redactSecrets, googleReadiness } from '../googlePlacesService';
import { PROVIDERS, providerReport } from '../prospectProviders';

// Shapes follow Google's documented error envelope: { error: { code, message, status, details: [{ reason }] } }
const gerr = (status: number, message: string, gStatus = '', reason = '') => ({
  response: { status, data: { error: { code: status, message, status: gStatus, details: reason ? [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] : [] } } },
});

describe('classifyGoogleError (Part 7)', () => {
  it('invalid key -> fatal API_KEY_INVALID with a French hint', () => {
    const i = classifyGoogleError(gerr(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT', 'API_KEY_INVALID'));
    expect(i).toMatchObject({ code: 'API_KEY_INVALID', fatal: true, retryable: false });
    expect(i.hint).toMatch(/GOOGLE_PLACES_API_KEY/);
  });
  it('API not enabled on the project -> fatal API_NOT_ENABLED', () => {
    expect(classifyGoogleError(gerr(403, 'Places API (New) has not been used in project 123 before or it is disabled.', 'PERMISSION_DENIED', 'SERVICE_DISABLED')))
      .toMatchObject({ code: 'API_NOT_ENABLED', fatal: true });
    // message-only fallback (no details block)
    expect(classifyGoogleError(gerr(403, 'Places API has not been used in project')).code).toBe('API_NOT_ENABLED');
  });
  it('billing off -> fatal BILLING_DISABLED', () => {
    expect(classifyGoogleError(gerr(403, 'This API method requires billing to be enabled.', 'PERMISSION_DENIED', 'BILLING_DISABLED')))
      .toMatchObject({ code: 'BILLING_DISABLED', fatal: true });
  });
  it('key restricted by IP / API / referrer -> fatal KEY_RESTRICTED', () => {
    expect(classifyGoogleError(gerr(403, 'Requests from this IP address are blocked.', 'PERMISSION_DENIED', 'API_KEY_IP_ADDRESS_BLOCKED')).code).toBe('KEY_RESTRICTED');
    expect(classifyGoogleError(gerr(403, 'Requests to this API are blocked.', 'PERMISSION_DENIED', 'API_KEY_SERVICE_BLOCKED')).code).toBe('KEY_RESTRICTED');
  });
  it('any other 403 -> PERMISSION_DENIED (fatal)', () => { expect(classifyGoogleError(gerr(403, 'The caller does not have permission'))).toMatchObject({ code: 'PERMISSION_DENIED', fatal: true }); });
  it('429 / RESOURCE_EXHAUSTED -> fatal QUOTA_EXCEEDED', () => {
    expect(classifyGoogleError(gerr(429, 'Quota exceeded', 'RESOURCE_EXHAUSTED'))).toMatchObject({ code: 'QUOTA_EXCEEDED', fatal: true });
  });
  it('5xx and network failures are retryable, not fatal', () => {
    expect(classifyGoogleError(gerr(503, 'The service is currently unavailable.'))).toMatchObject({ code: 'SERVER_ERROR', retryable: true, fatal: false });
    expect(classifyGoogleError({ code: 'ECONNABORTED', message: 'timeout of 15000ms exceeded' })).toMatchObject({ code: 'NETWORK', retryable: true, fatal: false });
  });
  it('a plain 400 is a row-level error; a field-mask 400 is systemic and stops the run', () => {
    expect(classifyGoogleError(gerr(400, 'Invalid text query', 'INVALID_ARGUMENT'))).toMatchObject({ code: 'BAD_REQUEST', fatal: false, retryable: false });
    expect(classifyGoogleError(gerr(400, 'Invalid field mask: unknown name "places.foo"', 'INVALID_ARGUMENT'))).toMatchObject({ code: 'BAD_REQUEST', fatal: true });
  });
});

describe('secrets never leak', () => {
  const OLD = { ...process.env };
  afterEach(() => { process.env = { ...OLD }; });
  it('masks Google-style keys, the configured key and key= query params', () => {
    process.env.GOOGLE_PLACES_API_KEY = 'my-very-secret-configured-key';
    const t = redactSecrets('bad AIzaSyA1234567890abcdefghijklmnopqrstuv and my-very-secret-configured-key at https://x/y?key=abc123&z=1');
    expect(t).not.toMatch(/AIza|my-very-secret|abc123/);
    expect(t).toContain('[clé masquée]');
  });
  it('error classification never carries the key in its message', () => {
    process.env.GOOGLE_PLACES_API_KEY = 'my-very-secret-configured-key';
    expect(classifyGoogleError(gerr(403, 'blocked key my-very-secret-configured-key')).message).not.toContain('my-very-secret');
  });
});

describe('cost guard configuration', () => {
  const OLD = { ...process.env };
  afterEach(() => { process.env = { ...OLD }; });
  it('needs key AND approval AND a non-zero cap', () => {
    delete process.env.GOOGLE_PLACES_API_KEY; delete process.env.GOOGLE_PLACES_ENABLED; delete process.env.GOOGLE_PLACES_DAILY_CAP;
    expect(googleReadiness()).toMatchObject({ ready: false });
    process.env.GOOGLE_PLACES_API_KEY = 'k'; expect(googleReadiness()).toMatchObject({ ready: false });
    process.env.GOOGLE_PLACES_ENABLED = 'true'; expect(googleReadiness()).toMatchObject({ ready: false });
    process.env.GOOGLE_PLACES_DAILY_CAP = '0'; expect(googleReadiness()).toMatchObject({ ready: false });
    process.env.GOOGLE_PLACES_DAILY_CAP = '50'; expect(googleReadiness()).toEqual({ ready: true, dailyCap: 50 });
    process.env.GOOGLE_PLACES_ENABLED = 'yes'; expect(googleReadiness()).toMatchObject({ ready: false });   // only the literal "true" approves
  });
});

describe('provider matrix', () => {
  const field = (f: string) => PROVIDERS.filter(p => p.fields.some(x => x.includes(f)));
  it('positive reviews are explicitly NOT supplied by any integrated source', () => {
    const owners = field('positifs');
    expect(owners.length).toBeGreaterThan(0);
    expect(owners.every(p => p.state === 'not_integrated')).toBe(true);
  });
  it('Google profile link / rating / review count come from the gated, paid Places integration', () => {
    for (const f of ['Lien Google', 'Note Google', 'Nombre total d’avis']) expect(field(f)[0]).toMatchObject({ key: 'google_places', state: 'integrated_gated', cost: 'paid' });
  });
  it('the Business Profile API is documented as unusable for third-party businesses', () => {
    expect(PROVIDERS.find(p => p.key === 'google_business_profile_api')?.state).toBe('not_possible');
  });
  it('report reflects live readiness of Google only', () => {
    const r = providerReport();
    expect(r.find(p => p.key === 'google_places')).toHaveProperty('ready');
    expect(r.find(p => p.key === 'pappers')?.ready).toBe(false);
  });
});
