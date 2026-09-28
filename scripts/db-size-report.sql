-- Read-only. Paste into Supabase -> SQL Editor to see what is using the 500 MB.

-- 1) Total database size (this is the number Supabase compares to 500 MB)
select pg_size_pretty(pg_database_size(current_database())) as database_size;

-- 2) Biggest tables (data + indexes + TOAST, where large JSON like raw_data lives)
select relname as table_name,
       pg_size_pretty(pg_total_relation_size(c.oid)) as total,
       pg_size_pretty(pg_relation_size(c.oid))       as table_only,
       pg_size_pretty(pg_total_relation_size(c.oid) - pg_relation_size(c.oid)) as indexes_and_toast
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by pg_total_relation_size(c.oid) desc
limit 15;

-- 3) Rows and average raw_data size per source
select ds.code as source, count(*) as rows,
       pg_size_pretty(sum(pg_column_size(o.raw_data))::bigint) as raw_data_total,
       pg_size_pretty(avg(pg_column_size(o.raw_data))::bigint) as raw_data_avg
from opportunities o join data_sources ds on ds.id = o.source_id
group by ds.code order by sum(pg_column_size(o.raw_data)) desc;

-- 4) Is the database currently read-only?
show transaction_read_only;
