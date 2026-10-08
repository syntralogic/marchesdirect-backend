-- scripts/enable_rls.sql
--
-- Supabase security advisory "rls_disabled_in_public" (CRITICAL): every table
-- in the `public` schema is exposed through Supabase's REST API (PostgREST).
-- With RLS off, anyone holding the project URL + the (public) anon key can
-- read, edit and delete ALL rows - bypassing every check in this backend.
--
-- This backend talks to Postgres directly (DATABASE_URL via `pg`) and the
-- frontend never uses the Supabase client, so the API roles need no access at
-- all: enable RLS on every table WITHOUT policies (= deny-all for anon /
-- authenticated) and revoke their grants. The backend's role (table owner /
-- `postgres`, which bypasses RLS) is unaffected - RLS is ENABLED, not FORCED.
--
-- Safe to run repeatedly. Run it once in the Supabase SQL Editor right away;
-- the same logic also runs on every boot from ensureSchema()
-- (src/config/database.ts) so future tables are protected automatically.

DO $$
DECLARE
  r record;
  api_role text;
BEGIN
  -- Don't let a busy table block the whole statement (or the app) for long.
  SET LOCAL lock_timeout = '3s';

  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')       -- ordinary + partitioned tables
      AND NOT c.relrowsecurity          -- only the ones still unprotected
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
      RAISE NOTICE 'RLS enabled on public.%', r.relname;
    EXCEPTION WHEN insufficient_privilege OR lock_not_available THEN
      RAISE WARNING 'RLS NOT enabled on public.% (%): fix manually', r.relname, SQLERRM;
    END;
  END LOOP;

  -- Belt and braces: also remove the API roles' grants. This covers VIEWS
  -- (which are not subject to table RLS in Supabase) and any table that
  -- could not be altered above. Only runs on Supabase-style databases.
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      BEGIN
        EXECUTE format('REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM %I', api_role);
        EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', api_role);
        EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', api_role);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM %I', api_role);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', api_role);
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE WARNING 'Could not revoke grants from % (%)', api_role, SQLERRM;
      END;
    END IF;
  END LOOP;
END
$$;

-- Verify (should return zero rows):
--   SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity;
