# Part 6 - French company / artisan prospecting database

Admin UI: `/admin/entreprises`. API: `/api/admin/prospects/*` (admin / super_admin only).
Tables (created automatically at boot, idempotent): `prospect_companies`, `prospect_api_usage`, `prospect_import_runs`.

## Data model
One row per establishment (SIRET, UNIQUE = deduplication key); SIREN is indexed to group establishments of one company.
Every enrichable field has a status in `field_meta`: `confirmed` (+source, date) / `confirmed_missing` (source queried, nothing there) /
`not_checked` / `unavailable` (no authorised source) / `error` (retry). Exports and the UI show the status for each empty field.

## Sources
| Field | Source | Cost / key |
|---|---|---|
| Name, address, SIREN/SIRET, NAF, creation/closure date, legal form, employee range, directors, revenue + net result (when published), RGE / Qualiopi / bio / ESS flags, coordinates | SIRENE via recherche-entreprises.api.gouv.fr | free, no key |
| Google profile link (Maps URI), rating, total review count, website, phone | Google Places API (New) Text Search | **paid**, see below |
| Facebook / Instagram / LinkedIn, phone, e-mail | the company's own homepage links (only if the website is already known) | free |
| Positive-review count / % | **not obtainable from the official Google API** (it returns the average, the total count and at most 5 sample reviews, never the star distribution). Stored as `unavailable`, never estimated. Needs a licensed review-data provider. | - |
| Licensed phone / e-mail (Pages Jaunes, Solocal), Pappers financials, BODACC / INPI history | not integrated (paid contracts / keys needed) | - |

## Google cost guard (no cost without approval)
Calls happen only if **all three** are set on the backend: `GOOGLE_PLACES_API_KEY`, `GOOGLE_PLACES_ENABLED=true`, `GOOGLE_PLACES_DAILY_CAP=<n>` (default 0).
The daily cap is enforced atomically in the database, for every Google call in the backend (including the SIRET lookup) and for each retry. 401/403/429 (invalid key, API not enabled, billing, quota) stop the run immediately. See `PART7_GOOGLE_API_INTEGRATION.md`.
Rating/phone/website fields bill the Enterprise Text Search SKU: check the price and free allowance in the Google Cloud console and set a budget alert and API quota there too.
Match rule: 0.6 x name similarity + 0.4 x location (distance <= 100 m = 1, >= 500 m = 0, or postal code in address); stored only if confidence >= 0.8.
Google's terms limit long-term storage of Places content other than place_id: confirm the client's licence; values carry `google_fetched_at` and are meant to be refreshed.

## Operating it
1. Import: in the UI choose métier / région / département then "Importer depuis SIRENE" (or `POST /api/admin/prospects/import`). The API is capped at 10,000 results per query, so the job splits profession x NAF x département. For all of France in one pass, load the INSEE bulk stock instead (see the france-business-hubspot-db project).
2. "Réseaux via sites web" fills Facebook/Instagram/LinkedIn/phone/e-mail from known websites.
3. "Enrichir Google" (when status is ready) processes up to 100 filtered rows per click.
4. Export CSV (UTF-8 with BOM, `;`, decimal comma) or Excel (real numbers/dates/hyperlinks, 200,000-row limit) of the current filters.
