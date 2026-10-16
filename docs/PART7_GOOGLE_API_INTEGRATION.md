# Part 7 - Google Cloud and business-enrichment API integration

Scope: how Google Places data reaches the company database (`prospect_companies`) and the CSV / Excel exports, what it costs,
how it fails, and which requested fields need another provider. Companion to `PART6_COMPANY_DATABASE.md`.

## What was audited / changed

| Finding | Change |
|---|---|
| Two separate code paths called Google with the same key. The SIRET "company presence" lookup (`companyPresenceService`) needed **only** the key: no approval switch, no daily cap. | Both now go through one guarded client (`googlePlacesSearch`). Same three settings, same atomic daily cap. |
| Errors were reduced to a message; "API not enabled", "billing off", "key restricted" and "quota" looked alike. | `classifyGoogleError` -> stable codes + a French "what to do" hint, stored in `prospect_api_health` and shown in `/admin/entreprises`. |
| No retry for transient failures; failed records stayed at the head of the queue and were re-billed on every run. | 3 attempts with back-off (each attempt counts against the cap); a record that failed is not re-queued for `GOOGLE_ERROR_RETRY_HOURS` (24); a run stops after 5 consecutive failures. |
| After a config/quota error every later call was still sent (and counted). | Circuit breaker: calls pause 10 min (60 s for quota) after a fatal error; cleared by a successful connection test. |
| Key could surface in error text. | `redactSecrets` applied to every stored/logged/returned message (tested). The key is read only from the backend environment and sent only as the `X-Goog-Api-Key` header; no endpoint returns it. |
| A SIRET lookup that Google could not answer was still stamped "checked" for 30 days. | Only stamped when Google actually answered (match or no match); otherwise retried on a later lookup. |
| No way to verify the setup without running a batch. | `POST /api/admin/prospects/google/test` / button "Tester la connexion Google": **one** real request using the production field mask. |
| "Which field needs which provider" lived only in prose. | `GET /api/admin/prospects/providers` + the "Sources des données" panel (same list as below). |

**Behaviour change to be aware of:** the SIRET presence lookup (Google rating / review count in the company info) previously worked
as soon as `GOOGLE_PLACES_API_KEY` was set. It now also needs `GOOGLE_PLACES_ENABLED=true` and `GOOGLE_PLACES_DAILY_CAP>0`.
Until they are set, those two fields stay empty (nothing is invented, nothing is billed) and the Facebook-from-website part is unchanged.

## Backend settings (never in the frontend, never in git)

| Variable | Meaning |
|---|---|
| `GOOGLE_PLACES_API_KEY` | Server key for **Places API (New)**. |
| `GOOGLE_PLACES_ENABLED` | Must be exactly `true`: the explicit "costs approved" switch. |
| `GOOGLE_PLACES_DAILY_CAP` | Max Google requests per UTC day, all features combined, retries included. `0` (default) = no call. |
| `GOOGLE_ERROR_RETRY_HOURS` | Optional, default 24: wait before retrying a record whose Google lookup failed. |
| `GOOGLE_PLACES_RETRY_DELAY_MS` | Optional, default 500: base back-off between attempts. |

## Google Cloud checklist (to be done in the client's project - not verifiable from the code)

1. Project has a **billing account** linked; create a **budget + alerts** (the daily cap is the application-side limit, the budget is the second line of defence).
2. Enable **Places API (New)** (not only the legacy "Places API").
3. Create a key restricted to **API: Places API (New)** and to the **outgoing IP(s) of the backend host**. Do not use an HTTP-referrer restriction for a server key.
4. Set a per-day / per-minute **quota** for the API in Cloud console > Quotas.
5. Set the three variables above on the backend host, redeploy, open `/admin/entreprises` and click **Tester la connexion Google**.

Note: the *Business Profile* APIs (My Business) only return locations owned/managed by the authenticated Google account, so they cannot read other
companies' profiles. Third-party profile links, ratings and review counts come from Places.

## Error codes and fixes (shown in the admin page)

| Code | Cause | Fix |
|---|---|---|
| `API_KEY_INVALID` | wrong / expired key | check `GOOGLE_PLACES_API_KEY` |
| `API_NOT_ENABLED` | Places API (New) off on the project | enable it in API Library |
| `BILLING_DISABLED` | no billing account | link one |
| `KEY_RESTRICTED` | key restricted to other API / IP / referrer | allow Places API (New) + server IP |
| `PERMISSION_DENIED` | other 403 | check project permissions / key restrictions |
| `QUOTA_EXCEEDED` | 429 | wait or raise quota |
| `BAD_REQUEST`, `SERVER_ERROR`, `NETWORK` | one record / transient | record marked "erreur", retried after 24 h |

All of the first six stop the run, open the circuit breaker and are recorded; nothing is written to the company row.

## Field -> source (what Google can and cannot give)

| Requested field | Source | Status |
|---|---|---|
| Google Business Profile / Maps link, rating, total review count, website, phone | Google Places API (New) | integrated, **paid**, approval + cap required |
| Positive-review count / % | none authorised: Places returns the average, the total and only a small review sample, not the star distribution | **not integrated**: needs a licensed review-data provider; stored `unavailable`, never estimated |
| Facebook / Instagram / LinkedIn, phone, e-mail | company's own site | integrated, free |
| Identity, address, SIREN/SIRET, NAF, legal form, dates, employees, directors, revenue (if published), certifications | SIRENE (recherche-entreprises) | integrated, free |
| Detailed financials / legal history | Pappers (already used one company at a time by the SIRET lookup) | **not wired to the prospect DB** - bulk use is billed, needs approval |
| Professional phone/e-mail not on the company's site | licensed directories (Pages Jaunes / Solocal) | **not integrated** - needs a contract |

No paid provider other than Google Places is called by the prospect database. Nothing was added without approval.

## How the data reaches the database and the exports

`runGoogleEnrichment` -> `searchPlaces` -> `googlePlacesSearch` (guard, cap, retry, classify) -> `UPDATE prospect_companies`
(`google_place_id`, `google_maps_url`, `google_rating`, `google_review_count`, `google_match_confidence`, `google_fetched_at`, plus
`website` / `phone` only when empty) + `field_meta` status per field -> same rows feed the admin table, `/export.csv` and `/export.xlsx`
(`prospectExport.ts`). A match is stored only at confidence >= 0.8; otherwise the fields are recorded `confirmed_missing` (Google was asked, nothing reliable found).

## Verification performed

- `googleClient.test.ts` (15 unit tests): error classification for every code, secret redaction, cost-guard conditions, provider matrix.
- `googlePart7.pg.test.ts` (13 tests, real PostgreSQL, Google HTTP mocked): retry + cap accounting, consecutive-failure stop, failed-record back-off, circuit breaker,
  health persistence, key never stored, connection test, SIRET presence guard, and an end-to-end run proving Google values appear in the DB, the admin list filters,
  the CSV (French decimal comma, quoting) and the Excel file (real numbers, hyperlinks, empty stays empty, positive reviews `indisponible`).
- Mutation checks: breaking redaction, the failed-record back-off, retry counting or the presence guard each makes tests fail.
- **Not verified:** a call against the real Google API (no key/billing access from the development environment) and the visual rendering of the admin panel in a browser.
  After deployment, run "Tester la connexion Google" once and spot-check 3-5 enriched rows against Google Maps.

## Terms note

Google Maps Platform terms restrict long-term storage of Places content other than `place_id`. Values are stored with `google_fetched_at`
and refreshed on a schedule; confirm that the client's licence permits this before enriching at scale.
