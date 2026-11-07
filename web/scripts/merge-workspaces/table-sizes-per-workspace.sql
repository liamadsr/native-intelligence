-- read-only: per exported table, the heaviest workspace's row count and JSON bytes (counts only, no content)
CREATE TEMP TABLE sizes (table_name text, workspace_id uuid, n bigint, bytes bigint);
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM public._wsmerge_export_tables() LOOP
    IF to_regclass('public.' || quote_ident(r.table_name)) IS NULL THEN CONTINUE; END IF;
    EXECUTE format(
      'INSERT INTO sizes SELECT %L, w.id, (SELECT count(*) FROM public.%I x WHERE %s), (SELECT COALESCE(sum(octet_length(to_jsonb(x)::text)), 0) FROM public.%I x WHERE %s) FROM public.workspace w',
      r.table_name, r.table_name, replace(r.predicate, '$1', 'w.id'), r.table_name, replace(r.predicate, '$1', 'w.id'));
  END LOOP;
END $$;
SELECT s.table_name, s.n AS rows, pg_size_pretty(s.bytes) AS json_bytes, round(s.bytes::numeric / GREATEST(s.n, 1)) AS avg_row_bytes,
       pg_size_pretty(LEAST(s.n, 5000) * round(s.bytes::numeric / GREATEST(s.n, 1))) AS est_5000_row_page,
       left(s.workspace_id::text, 8) AS ws
FROM sizes s
JOIN (SELECT table_name, max(bytes) AS mb FROM sizes GROUP BY table_name) m ON m.table_name = s.table_name AND m.mb = s.bytes
WHERE s.bytes > 0
ORDER BY s.bytes DESC
LIMIT 20;
