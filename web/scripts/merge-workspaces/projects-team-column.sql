-- read-only: does projects.team_id exist, and what references team at all?
SELECT
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'team_id') AS projects_team_id,
  (SELECT string_agg(cl.relname || '.' || a.attname, ', ' ORDER BY cl.relname)
   FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE c.contype = 'f' AND c.confrelid = 'public.team'::regclass) AS fks_onto_team;
