-- read-only: an exported table with a multi-column primary key, paged with a tiny budget
WITH t AS (
  SELECT e.table_name
  FROM public._wsmerge_export_tables() e
  JOIN pg_index i ON i.indrelid = ('public.' || quote_ident(e.table_name))::regclass AND i.indisprimary
  WHERE to_regclass('public.' || quote_ident(e.table_name)) IS NOT NULL AND i.indnatts > 1
  ORDER BY e.table_name
),
w AS (SELECT ws.id FROM public.workspace ws ORDER BY (SELECT count(*) FROM public.actions a WHERE a.workspace_id = ws.id) DESC LIMIT 1),
pick AS (
  SELECT t.table_name FROM t
  WHERE (public.export_workspace_rows((SELECT id FROM w), t.table_name, NULL, 20971520)->>'count')::int >= 3
  ORDER BY t.table_name LIMIT 1
),
p1 AS (SELECT public.export_workspace_rows((SELECT id FROM w), (SELECT table_name FROM pick), NULL, 1024) AS r),
p2 AS (SELECT public.export_workspace_rows((SELECT id FROM w), (SELECT table_name FROM pick), (SELECT r->'cursor' FROM p1), 1024) AS r),
all_rows AS (SELECT public.export_workspace_rows((SELECT id FROM w), (SELECT table_name FROM pick), NULL, 20971520) AS r)
SELECT
  (SELECT array_agg(table_name) FROM t) AS composite_key_tables,
  (SELECT table_name FROM pick) AS probed,
  (SELECT r->'count' FROM all_rows) AS total,
  (SELECT r->'count' FROM p1) AS p1_count, (SELECT r->'done' FROM p1) AS p1_done,
  (SELECT jsonb_object_keys_count FROM (SELECT count(*) AS jsonb_object_keys_count FROM jsonb_object_keys((SELECT r->'cursor' FROM p1))) k) AS p1_cursor_keys,
  (SELECT r->'count' FROM p2) AS p2_count, (SELECT r->'done' FROM p2) AS p2_done,
  (SELECT (p2.r->'rows'->0) <> (p1.r->'rows'->0) FROM p1, p2) AS p2_advances,
  (SELECT (p2.r->'rows'->0) <> (p1.r->'rows'->-1) FROM p1, p2) AS p2_not_repeating_last;
