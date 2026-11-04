# Journey reliability — 31 October 2026

## Changes

- The server journals a confirmed company selection, saved analysis, successfully computed analysis, saved dossier request, callback and confirmed booking. Stable identifiers make analysis retries idempotent.
- Browser events refresh an existing CRM journey after capture. Refreshes are grouped over two seconds; identified requests are marked pending first so the existing retry job can recover after a restart.
- A selected company can be synchronized without inventing contact details or a commercial request.
- Analysis summaries count distinct session/market computations, avoiding double counting when both the browser and server report the same analysis.
- New/unowned deals receive Hedi's owner ID (`102050175`), overridable with `HUBSPOT_DEFAULT_OWNER_ID`. Existing owners and commercial stages are preserved.
- Repeat dossier capture refreshes the existing request instead of leaving it stale, while preserving its original session and existing lot when none is supplied.
- The admin HubSpot diagnostic also reports email/phone configuration booleans and delivery counts for seven days. No credentials are returned.

## Validation

TypeScript compilation passed. The complete unit test run passed 431 tests across 45 suites; 47 database-dependent tests across six suites were skipped because no disposable PostgreSQL database was configured. Four new tests cover journaling failure isolation, durable queuing, burst coalescing and anonymous company refresh. Existing deal tests verify default assignment and preservation of a manually selected owner.

## Production checks still required

Post-release logs also revealed concurrent index builders deadlocking with later schema migrations during startup. A follow-up moves these builders after all schema DDL and executes the three index families sequentially. `/ready` returns 503 until initialization has completed; `/health` remains the existing liveness endpoint. Render's HTTP health-check path should use `/ready` (the current service uses TCP checks).

These changes do not configure Resend, a verified sender domain, or an SMS provider. They must not turn an email failure into a success or mark a phone verified because its format is valid.

Browser searches, views and previews are conditional on the site's existing analytics consent. The frontend's `trackVisitorEvent` deliberately sends no beacon when consent is absent or refused. Zero counters are not proof that the visitor did not browse. This release does not remove that consent control or reconstruct unrecorded history.

Verify the Render deployment SHA, inspect `/api/admin/hubspot/status` as an administrator, resolve any email-provider error using server logs, and run separate consented browsing-only and complete test sessions. Check that a selected SIRET is visible before coordinates, subsequent browsing updates the journey, the dossier PDF is usable, delivery succeeds with a controlled real mailbox, and phone verification accurately reflects the configured provider. Mark all test bookings/requests clearly and cancel their reserved slots after validation.

The frontend repository must also be accessible before changing its layouts, consent/status wording, appointment market context, favourites, registration and publication telemetry. Those scenarios have not been certified by this backend release.
