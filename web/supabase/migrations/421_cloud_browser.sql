-- ============================================================
-- 421: Cloud browser, one row per (user, workspace) browser
-- (docs/plans/cloud-browser.md, C0). Numbered 421 because two open branches
-- already hold a 420 (environments, chatgpt plan); renumber at merge if needed.
--
-- Each person gets one agent browser per workspace: Chrome in a persistent,
-- named Vercel Sandbox (`browser-<profile id>`). This row is the server's
-- record of it: which sandbox, whether it runs, and when it was last used, so
-- the idle cron (/api/cron/cloud-browser-idle) can stop it gracefully.
-- Later phases fill the driver and exit columns (C3 takeover lock, C4 Mac
-- exit); they are here now so the shape is settled once.
--
-- No backfill: no rows exist before C0's code creates them. The person reads
-- their own rows; only the service role writes.
--
-- Also: a workspace merge must NOT re-stamp this table. Its key is
-- (user_id, workspace_id) and its sandbox is named from the source workspace,
-- so a re-stamp would either collide (and roll the merge back) or point a row
-- at the wrong browser. _wsmerge_generic_restamp (402) is redefined below,
-- unchanged except for 'cloud_browser' in its NOT IN list. The source
-- workspace's row then goes with that workspace (on delete cascade), and the
-- daily reconcile (/api/cron/cloud-browser-reconcile) deletes its orphaned
-- sandbox and snapshots.
--
-- Not applied by the builder: Liam applies it (DEV, then PROD) BEFORE the
-- deploy that ships the crons, which read this table. Verified on DEV inside a
-- rolled-back transaction (2026-10-22).
-- ============================================================

create table if not exists public.cloud_browser (
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  sandbox_name text not null check (char_length(sandbox_name) between 1 and 128),
  -- The sandbox's current session (VM). Null while stopped.
  session_id text check (session_id is null or char_length(session_id) <= 128),
  status text not null default 'stopped'
    check (status in ('starting', 'running', 'stopping', 'stopped')),
  started_at timestamptz,
  last_active_at timestamptz not null default now(),
  stop_reason text check (stop_reason is null or char_length(stop_reason) <= 64),
  -- C3: who drives the browser right now.
  driver text not null default 'agent' check (driver in ('agent', 'person')),
  -- C4: where its traffic leaves (null = not decided yet).
  exit_mode text check (exit_mode is null or exit_mode in ('mac', 'cloud')),
  exit_device_id uuid,
  exit_connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, workspace_id),
  constraint cloud_browser_sandbox_name_uq unique (sandbox_name)
);

comment on table public.cloud_browser is
  'Cloud browser (421): one row per (user, workspace) agent browser in a persistent Vercel Sandbox. last_active_at feeds the idle stop. The person reads their own rows; only the service role writes.';

drop trigger if exists cloud_browser_updated_at on public.cloud_browser;
create trigger cloud_browser_updated_at
  before update on public.cloud_browser
  for each row execute function public.update_updated_at();

-- The idle cron's scans: live browsers by activity, and stops that never finished.
create index if not exists cloud_browser_running_idx
  on public.cloud_browser (last_active_at)
  where status in ('starting', 'running');
create index if not exists cloud_browser_stopping_idx
  on public.cloud_browser (updated_at)
  where status = 'stopping';

alter table public.cloud_browser enable row level security;

drop policy if exists cloud_browser_own_select on public.cloud_browser;
create policy cloud_browser_own_select on public.cloud_browser
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- A merge leaves cloud_browser alone (see the header). Identical to 402's
-- definition but for 'cloud_browser' in the NOT IN list.
CREATE OR REPLACE FUNCTION public._wsmerge_generic_restamp(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE r record; n int; v_out jsonb := '{}'::jsonb;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id'
      AND c.table_name NOT IN ('workspace', 'workspace_move_log', 'workspace_merge', 'cloud_browser')
    ORDER BY c.table_name
  LOOP
    BEGIN
      EXECUTE format('UPDATE public.%I SET workspace_id = $1 WHERE workspace_id = $2', r.table_name) USING p_dest, p_source;
      GET DIAGNOSTICS n = ROW_COUNT;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'merge cannot re-stamp %: a uniqueness this merge does not resolve (%)', r.table_name, SQLERRM
        USING ERRCODE = 'P0008';
    END;
    IF n > 0 THEN
      v_out := v_out || jsonb_build_object(r.table_name, n);
    END IF;
  END LOOP;
  RETURN v_out;
END;
$$;
