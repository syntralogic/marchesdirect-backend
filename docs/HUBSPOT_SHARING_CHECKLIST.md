# HubSpot: sharing rights check (brief part F)

This part can only be done inside HubSpot (account 149642063); the code cannot see or change sharing settings.
Done by someone with Super Admin rights. Tick each line and note the date.

## Dashboard "Marchés Direct — Pilotage commercial"
- [ ] Dashboard access: set to the authorised collaborators (not "Private" and not "Everyone" unless intended).
- [ ] Each of the 6 reports: the data source (deals, pipeline "Marchés Direct — Accompagnement", id 4280487115) is visible to those users.
- [ ] Open the dashboard as a test user from the sales team (View as / second account): all 6 reports show numbers, none says "no access".

## Views
- [ ] "Marchés Direct — Parcours des contacts": shared with the same collaborators (view sharing is separate from dashboard sharing).
- [ ] "Marchés Direct — Parcours des entreprises": same.
- [ ] Custom properties `md_*` are visible in those views for the same users (property group visibility / field-level permissions).
- [ ] `md_journey_url` (contacts and deals) is visible in the record sidebar for the same users, once created and enabled (see DEPLOY.md).

## Tasks
- [ ] The two automations assign tasks to owner 102050175 (Hedi Fathallah); confirm that is intended, or change the owner.

## Abandonment reports
The funnel and drop-off figures come from the event journal and are on the site at /admin/abandon (admin login).
HubSpot only holds summaries (`md_last_journey_step`, counts), so HubSpot-side reports can show the contacts' last step
(report on contacts, group by `md_last_journey_step`) but not session-level drop-off.
