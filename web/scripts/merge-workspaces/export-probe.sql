-- read-only: the new export on DEV — a byte-cut page, its cursor, the next page, a composite key, the one-row table
WITH w AS (
  SELECT ws.id FROM public.workspace ws
  ORDER BY (SELECT count(*) FROM public.actions a WHERE a.workspace_id = ws.id) DESC LIMIT 1
),
a1 AS (SELECT public.export_workspace_rows(w.id, 'actions', NULL, 4096) AS r FROM w),
a2 AS (SELECT public.export_workspace_rows(w.id, 'actions', (SELECT r->'cursor' FROM a1), 4096) AS r FROM w),
tm1 AS (SELECT public.export_workspace_rows(w.id, 'team_member', NULL, 1024) AS r FROM w),
tm2 AS (SELECT public.export_workspace_rows(w.id, 'team_member', (SELECT r->'cursor' FROM tm1), 1024) AS r FROM w),
ws1 AS (SELECT public.export_workspace_rows(w.id, 'workspace', NULL, 20971520) AS r FROM w),
big AS (SELECT public.export_workspace_rows(w.id, 'actions', NULL, 20971520) AS r FROM w)
SELECT
  (SELECT count(*) FROM public.actions a, w WHERE a.workspace_id = w.id) AS actions_total,
  (SELECT r->'count' FROM a1) AS a1_count, (SELECT r->'bytes' FROM a1) AS a1_bytes, (SELECT r->'done' FROM a1) AS a1_done,
  (SELECT jsonb_typeof(r->'cursor') FROM a1) AS a1_cursor_type, (SELECT (r->'cursor') ? 'id' FROM a1) AS a1_cursor_has_id,
  (SELECT jsonb_array_length(r->'rows') FROM a1) AS a1_rows,
  (SELECT (r->'rows'->0) ? '__bytes' FROM a1) AS a1_leaks_helper_cols,
  (SELECT r->'count' FROM a2) AS a2_count, (SELECT r->'done' FROM a2) AS a2_done,
  (SELECT (a2.r->'rows'->0->>'id') <> (a1.r->'rows'->0->>'id') FROM a1, a2) AS a2_advances,
  (SELECT (a2.r->'rows'->0->>'id') > (a1.r->'cursor'->>'id') FROM a1, a2) AS a2_after_cursor,
  (SELECT count(*) FROM public.team_member tm, w WHERE tm.team_id IN (SELECT id FROM public.team t WHERE t.workspace_id = w.id)) AS team_member_total,
  (SELECT r->'count' FROM tm1) AS tm1_count, (SELECT r->'done' FROM tm1) AS tm1_done, (SELECT r->'cursor' FROM tm1) AS tm1_cursor,
  (SELECT r->'count' FROM tm2) AS tm2_count, (SELECT r->'done' FROM tm2) AS tm2_done,
  (SELECT r->'count' FROM ws1) AS ws_count, (SELECT r->'done' FROM ws1) AS ws_done,
  (SELECT r->'count' FROM big) AS big_count, (SELECT r->'done' FROM big) AS big_done, (SELECT r->'bytes' FROM big) AS big_bytes;
