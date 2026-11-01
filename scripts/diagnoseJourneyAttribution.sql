-- READ ONLY, usable before deploying. Does not read contact coordinates or alter data.
-- AIS ELEC BORDEAUX. Compare current lookup with explicit historical event evidence.
BEGIN READ ONLY;
SELECT count(DISTINCT session_id) AS current_lookup_sessions
FROM siret_lookups WHERE siret='83438617900024';
WITH sessions AS (
 SELECT session_id FROM siret_lookups WHERE siret='83438617900024'
 UNION SELECT session_id FROM visitor_events WHERE siret='83438617900024'
)
SELECT e.session_id,e.siret,e.event_type,count(*) AS events,
 min(COALESCE(e.occurred_at,e.created_at)) AS first_at,max(COALESCE(e.occurred_at,e.created_at)) AS last_at
FROM visitor_events e JOIN sessions s USING(session_id)
GROUP BY e.session_id,e.siret,e.event_type ORDER BY e.session_id,first_at;
SELECT e.session_id,count(DISTINCT e.siret) AS explicit_sirets
FROM visitor_events e
WHERE e.session_id IN (SELECT session_id FROM siret_lookups WHERE siret='83438617900024')
GROUP BY e.session_id HAVING count(DISTINCT e.siret)>1;
COMMIT;
