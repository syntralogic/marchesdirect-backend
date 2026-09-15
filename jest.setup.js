// Loaded before any test file via jest.config.js's setupFiles - middleware/auth.ts
// throws at import time if JWT_SECRET/REFRESH_TOKEN_SECRET aren't set (a real,
// deliberate safety check for actually running the app - see that file), which
// otherwise makes it impossible to import authService (or anything that imports
// it) from a test file, since there's no real .env in the test environment.
// These are dummy values, never used to sign anything a real user sees.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'test-refresh-token-secret';
