# HubSpot integration

Goal: follow the visitor journey (SIRET typed, phone given, searches, announcements viewed, contact
requests) and attach it to the HubSpot **contact** and its **company**.

## 1. Environment (backend host, e.g. Render) — never in the frontend

| Variable | Value |
|---|---|
| `HUBSPOT_ACCESS_TOKEN` | Service key / private-app token from HubSpot |
| `CRM_SYSTEM` | optional; `hubspot` is picked automatically when the token is set |

Scopes: `crm.objects.contacts.read/write`, `crm.objects.companies.read/write`,
`crm.schemas.contacts.write`, `crm.schemas.companies.write` (custom properties, one time),
plus the notes scope if HubSpot reports one is missing (a 403 names it in the logs).

Without the token everything is a no-op; leads keep saving normally.

## 2. One-time setup
`HUBSPOT_ACCESS_TOKEN=... npm run hubspot:setup` (also runs automatically at server boot) creates the
custom properties (group "Marchés Direct"): contact `md_siret`, `md_session_id`, `md_lead_source`,
`md_last_search`, `md_last_opportunity_viewed`, `md_searches_count`, `md_opportunities_viewed`,
`md_last_request`; company `siret`. If they are missing the sync still works with standard properties.

## 3. Verify
* `GET /api/admin/hubspot/status` (admin) -> `{ configured, ok }`
* `POST /api/admin/hubspot/test {"email":"you@example.com"}` -> creates a test contact + company + note;
  find it in HubSpot > Contacts.

## 4. What is sent
| Event on the site | In HubSpot |
|---|---|
| Contact / callback / appointment / dossier request / chatbot lead | contact (upsert by e-mail, else phone), company (SIRET if known, else name), association, a note describing the request |
| SIRET + phone + e-mail gate (`POST /api/siret/lead`) | same, plus a "coordonnées saisies" note, immediately |
| Searches, announcements viewed, SEO pages, forms started | one "Parcours" note per batch (job every 10 min) + summary properties; only visitors who accepted analytics cookies have events |

Failures never affect the visitor: leads are retried by `jobs/crmRetry.ts`, journeys by
`jobs/hubspotJourney.ts`. Page views and campaign (UTM) attribution come from HubSpot's tracking
script in the frontend (`VITE_HUBSPOT_PORTAL_ID`).

## 5. Not covered
* HubSpot has no native SMS sending; SMS campaigns need a separate provider/app.
* Custom behavioral events require HubSpot Enterprise; notes + properties are used instead.
