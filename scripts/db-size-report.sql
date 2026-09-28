-- Read-only and deliberately LIGHT (catalog lookups only - no full-table scans),
-- so it can run even on a struggling database. Run each block ONE AT A TIME in
-- Supabase -> SQL Editor.

-- 1) Is the database currently read-only?  ('on' = yes, every write fails)
show transaction_read_only;

-- 2) Total database size (Supabase Free plan locks the DB above 500 MB)
select pg_size_pretty(pg_database_size(current_database())) as database_size;

-- 3) Biggest relations: tables, indexes AND materialized views (the search
--    index view is refreshed every 15 min and needs extra room while it does)
select c.relname,
       case c.relkind when 'r' then 'table' when 'm' then 'matview' when 'i' then 'index' end as kind,
       pg_size_pretty(pg_total_relation_size(c.oid)) as total_size,
       c.reltuples::bigint as approx_rows
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','m')
order by pg_total_relation_size(c.oid) desc
limit 12;

-- 4) Approx. average raw_data size, from a 1% sample (cheap) - replaces the
--    old full-scan query that could itself time out
select count(*) as sampled_rows,
       pg_size_pretty(avg(pg_column_size(raw_data))::bigint) as raw_data_avg
from opportunities tablesample system (1);

-- 5) Anything stuck holding connections / running for a long time?
select pid, state, now() - query_start as running_for, left(query, 80) as query
from pg_stat_activity
where datname = current_database() and state <> 'idle'
order by query_start
limit 15;
