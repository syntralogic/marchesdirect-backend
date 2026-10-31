# One company row per SIRET

The approved company properties are `md_progress_stage`, `md_followup_priority` and `md_next_action`.

Company selections and lead synchronization refresh these properties from the real event journal, coordinates captured and latest commercial request. Historical progression keeps the furthest observed step. Urgency is separate: a new explicit callback is urgent, a dossier request requires processing, a confirmed future booking is planned, and an unqualified past/cancelled booking requires review. A manually closed or already handled HubSpot deal is not reopened by this summary. Delivery and phone verification are never inferred from progression.

One bounded batch initializes up to 50 existing SIRETs on backend startup, without adding fake browsing events. New activity updates its own company independently. The summary is refreshed on site activity and lead sync, not a continuous live clock or a HubSpot workflow triggered by every manual edit. The latest commercial request drives the next action; older requests remain visible in the company record.

These properties do not change saved view columns, record layouts or dashboards. Add them to the company view with `md_siret` known; keep associated contacts and deals in the company record. No visitor, request or deal is deleted or merged.
