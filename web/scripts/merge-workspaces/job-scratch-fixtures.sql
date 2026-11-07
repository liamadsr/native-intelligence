-- DEV only, COMMITTED (migration 417's job path): two scratch workspaces owned by the end-to-end's first user, a few
-- actions, a contact in both, and a capture quiet for three days (not busy under 417). Prints the ids for
-- job-path-test.mjs; job-scratch-cleanup.sql removes everything afterwards.
-- DEV only: refuses anywhere else (the deal table exists only on DEV).
DO $$ BEGIN IF to_regclass('public.deal') IS NULL THEN RAISE EXCEPTION 'this script writes; run it on DEV only'; END IF; END $$;
DO $$
DECLARE u1 uuid := '51ea9b3e-4a5b-4327-bba9-4564aa43e6ee'; s uuid; d uuid; s_gen uuid; st uuid; i int;
BEGIN
  INSERT INTO public.workspace (name, slug) VALUES ('Scratch Src 417', 'scratch-src-417-' || left(gen_random_uuid()::text, 6)) RETURNING id INTO s;
  INSERT INTO public.workspace (name, slug) VALUES ('Scratch Dst 417', 'scratch-dst-417-' || left(gen_random_uuid()::text, 6)) RETURNING id INTO d;
  INSERT INTO public.member (user_id, workspace_id, role, display_name) VALUES (u1, s, 'owner', 'U1'), (u1, d, 'owner', 'U1');
  SELECT id INTO s_gen FROM public.team WHERE workspace_id = s ORDER BY created_at LIMIT 1;
  SELECT id INTO st FROM public.workflow_state WHERE team_id = s_gen AND is_default;
  FOR i IN 1..5 LOOP
    INSERT INTO public.actions (user_id, title, workspace_id, team_id, status_id) VALUES (u1, 'scratch action ' || i, s, s_gen, st);
  END LOOP;
  INSERT INTO public.contact (workspace_id, full_name, email) VALUES (s, 'Scratch Person', 'scratch-417@example.com'), (d, 'Scratch Person', 'scratch-417@example.com');
  INSERT INTO public.captures (user_id, title, workspace_id, status, started_at, updated_at)
  VALUES (u1, 'scratch stale', s, 'active', now() - interval '3 days', now() - interval '3 days');
END $$;
SELECT name, id FROM public.workspace WHERE name IN ('Scratch Src 417', 'Scratch Dst 417') ORDER BY name;
