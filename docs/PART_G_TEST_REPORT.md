# Part G - pre-delivery checks (client brief section 7)

Run: 31 Oct 2026, `src/services/__tests__/partG.acceptance.pg.test.ts`, on a real PostgreSQL with the real routes and
services. HubSpot is replaced by an in-process fake (`__tests__/support/fakeHubspot.ts`) that rejects unknown properties,
searches/creates/patches objects, associates records, can be switched "down", and SIMULATES the two pipeline automations.

Re-run: `TEST_DATABASE_URL=postgres://user:pw@localhost:5432/throwaway npx jest partG.acceptance --forceExit`
(use an empty throw-away database: the test truncates leads, events and opportunities).

| # | Check | Result | Notes |
|---|---|---|---|
| 1 | Search, then SIRET: company found | PASS (fake HubSpot) | One company per SIRET (`md_siret`, 14 digits as text), reused by a second visitor. |
| 2 | Several offers viewed | PASS (fake HubSpot) | Journal keeps every view; a resent `eventId` is stored once; contact and company counters agree. |
| 3 | An analysis | PASS (fake HubSpot) | Market type/reference/URL, lot, the 4 answers and the index (equal to `computeMatchScore`, with version and date). |
| 4 | A request: contact, deal, callback task | PASS for contact + deal + associations; task SIMULATED | The "À rappeler" task is created by HubSpot's own automation: to confirm on the real account. |
| 5 | Double click / network retry | PASS | Found and fixed a race (below). Same event resent 3x = 1 row; sync run 3x = 1 deal. |
| 6 | A booking, then the real outcome | PASS (fake HubSpot) | Booking -> "RDV confirmé" / `scheduled`; only a recorded `attended` outcome -> "RDV réalisé"; "réalisé" task once. |
| 6b | Dossier request later becomes an appointment | PASS | Same deal, type `appointment`, stage "RDV confirmé". |
| 7 | Two visitors, same SIRET | PASS | 2 contacts, 1 company (`md_visitors_count` 2), separate counters and deals. |
| 8 | HubSpot down | PASS | Request saved (201), failure journaled in `crm_last_error` (no token), retry sweep syncs it, no duplicate. |
| 8b | Callback with a phone number only | PASS after fix | Was failing (below). |
| 9 | E-mails / SMS really received | NOT TESTED | Needs a real mailbox/phone and the real provider. |
| 10 | Dashboard consistency | PARTIAL | Our side: deals = commercial requests (a plain contact message never makes a deal), held meetings = "RDV réalisé" deals. The HubSpot dashboard reports themselves can only be checked in HubSpot. |

## Defects found by these checks and fixed

1. **Callback requests never reached HubSpot.** The callback form only collects a phone number; the sync required an
   e-mail and failed every time ("Lead has no e-mail"). The contact is now identified by e-mail, or by phone when there is
   no e-mail (never by SIRET). Files: `hubspotSyncService.ts` (+ its unit test).
2. **Two identical clicks at the same instant could create two requests** when no client key was sent (both passed the
   "last 20 seconds" check before either row existed). The forms do send a key, but the server path is now atomic too:
   a derived key (same visitor, same content, same 20 s window) goes through the existing unique index. File: `crmPublic.ts`.

## Observations

- Fixed (31 Oct 2026): the callback and appointment forms now send the market (`opportunityId`) and, when known, the lot
  (`lotLabel`) to `/api/crm/leads`; the lead stores `opportunity_id` / `lot_label`, so those deals get `md_market_*` and
  `md_lot_reference`. Only an existing market is linked; an unknown id never fails the request. Forms opened outside a
  market page (home, tarifs, header) still send none, as there is no market to attach. No page offers a lot choice yet.
- Fixed (31 Oct 2026): `request-access` on a public market no longer returns early; the callback or appointment is recorded
  like any other (`identityUnlocked` stays true there, as there is nothing to unlock).
- The dossier gate in `siret.ts` sits behind a phone OTP; the test inserts the lead with the same SQL instead.
- Not re-run after these two changes: the PostgreSQL acceptance test (no database in the build environment); typecheck and
  the HubSpot unit tests pass.

## What only the real account can confirm

Real HubSpot behaviour (scopes, property types, rate limits), the two automations and their task assignment, dashboard
numbers, views/dashboard sharing, and real e-mail/SMS delivery (check 9).
