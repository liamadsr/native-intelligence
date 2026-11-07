-- 417: merge workspaces — the busy check counts only work that is running, and the merge runs as a
-- database job (docs/plans/merge-workspaces.md, "Status": the rolled-back PROD rehearsal of 2026-10-21).
--
-- The rehearsal folded each of Liam's PROD workspaces into Dial8, rolled back, and found two things
-- that stop the first real merge:
--
--   * Every source was refused as busy (P0007) while nothing in it was running: captures still
--     'active' that never ended (some since April), a coding run parked in 'pr_open' since July, jobs
--     waiting for a person's review. 402 counted those states as work in progress. They are not:
--     nothing executes in them, and what wakes them later reads the run's row, which the merge has
--     re-stamped. _wsmerge_busy now counts only what can write under the source while the merge runs.
--
--   * Corvanne's merge needs about two minutes (contacts 21 s, one member fold 10 s, re-stamping
--     11,158 claim embeddings whose vector index is rebuilt row by row 41 s, ...). The route called
--     merge_workspace through PostgREST as service_role, whose statement_timeout is 120 s (407), and
--     the HTTP edge in front of PostgREST cuts a request at about 100 s. A large merge could not
--     finish. Now the route calls merge_workspace_enqueue, which checks the gate, writes a
--     workspace_merge_job row and wakes a pg_cron runner; the runner claims the job (committing the
--     attempt), then runs merge_workspace as postgres with no statement timeout and records the
--     outcome on the row IN THE SAME TRANSACTION as the merge: the merge and its 'done', or nothing and
--     its 'failed' with the errcode. A run that died without an outcome is failed on the next tick,
--     never re-run. The route waits on the row. The runner is scheduled only while a job waits (every
--     2 s) and unschedules itself when none does.
--
-- Nothing about the merge's rules moves: merge_workspace is unchanged and still callable directly by
-- service_role (the end-to-end calls it). Verified on DEV: the end-to-end with this file prepended,
-- a pg_cron probe for the runner's timeout, and a committed scratch merge through the job.


-- ── The busy check: only what is running ────────────────────────────────────
-- What can write under the source while the merge runs, or be cut off by the window's reload:
--   * a capture recording now: active, not ended, not an eval, and written to in the last hour. A
--     recording saves its transcript every 30 s while anyone speaks (recording-context), and the
--     abandoned-capture sweep (lib/captures/abandoned.ts) treats an hour of silence as a dead recorder.
--     That sweep never closes a capture quiet for more than 72 h, which is how months-old 'active' rows
--     piled up and refused every merge;
--   * an agent run executing: queued or running (its run token carries the workspace), or canceling for
--     up to 90 minutes. needs_input and pr_open run nothing; their resume (an answer, a PR event) reads
--     the run's row, which the merge has re-stamped (types.ts lists pr_open as terminal);
--   * a local agent turn on someone's Mac: starting or running under a live lease (410). Counted with
--     the agent runs, so the preflight's shape and the sheet's words stay as they are;
--   * a loop run parked on an approval card (flow_run_state parked or resuming, at most ~25 h): its
--     stored resume context carries the source's ids, which the merge does not rewrite;
--   * a tracked job queued or running inside its deadline. needs_input, needs_review and
--     waiting_on_child run nothing (a waiting parent's child counts in its own right).
CREATE OR REPLACE FUNCTION public._wsmerge_busy(p_workspace uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'live_captures', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title) ORDER BY c.started_at)
       FROM public.captures c
       WHERE c.workspace_id = p_workspace AND c.status = 'active' AND c.started_at IS NOT NULL AND c.ended_at IS NULL
         AND c.is_eval IS NOT TRUE AND c.updated_at > now() - interval '1 hour'), '[]'::jsonb),
    'agent_runs',
      (SELECT count(*) FROM public.agent_run r
       WHERE r.workspace_id = p_workspace
         AND (r.status IN ('queued', 'running')
              OR (r.status = 'canceling' AND COALESCE(r.started_at, r.created_at) > now() - interval '90 minutes')))
      + (SELECT count(*) FROM public.local_agent_session s
         WHERE s.workspace_id = p_workspace AND s.status IN ('starting', 'running')
           AND COALESCE(s.lease_expires_at, s.claimed_at + interval '15 minutes') > now()),
    'flow_runs', (SELECT count(*) FROM public.flow_run_state s WHERE s.workspace_id = p_workspace AND s.status IN ('parked', 'resuming')),
    'tracked_jobs', (SELECT count(*) FROM public.tracked_job j
       WHERE j.workspace_id = p_workspace AND j.status IN ('queued', 'running')
         AND COALESCE(j.deadline_at, j.last_beat_at + interval '6 hours', j.created_at + interval '6 hours') > now())
  );
$$;


-- ── pg_cron (Supabase Cron) ─────────────────────────────────────────────────
-- Supabase's documented install, the extension in pg_catalog. Supabase's own after-create script grants
-- postgres what the runner uses (the cron schema, the run-details table, cron.job for reading) and
-- narrows cron.job to SELECT, so nothing is granted here: an extra GRANT made that script fail
-- ("dependent privileges exist") when the extension was created again. Created only when missing, so
-- the file can run twice.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    CREATE EXTENSION pg_cron WITH SCHEMA pg_catalog;
  END IF;
END;
$$;


-- ── The job ─────────────────────────────────────────────────────────────────
-- One row per requested merge. No foreign keys to either workspace: the source is deleted by the merge
-- and the destination may go later (like workspace_merge, 402). Server-only: row security on, no
-- policies; the route reads it as service_role. attempts counts claims (committed before the merge
-- runs), so a run that died without recording an outcome is seen as one on the next tick.
CREATE TABLE IF NOT EXISTS public.workspace_merge_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_workspace_id uuid NOT NULL,
  destination_workspace_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  plan jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'done', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  result jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz
);

-- one waiting merge per source: a second click, or a second tab, cannot queue the same fold twice
CREATE UNIQUE INDEX IF NOT EXISTS workspace_merge_job_one_queued_per_source
  ON public.workspace_merge_job (source_workspace_id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS workspace_merge_job_queued_idx
  ON public.workspace_merge_job (created_at) WHERE status = 'queued';

ALTER TABLE public.workspace_merge_job ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace_merge_job FROM anon, authenticated;


-- How long a job may wait for the runner before it is failed instead of run late (a dead scheduler).
CREATE OR REPLACE FUNCTION public._wsmerge_job_expiry()
RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '30 minutes' $$;


-- The runner's command (merge_workspace_enqueue schedules it). It is two transactions in one libpq
-- query string (pg_cron connects as a client: cron.use_background_workers is off on Supabase):
--   1. the claim, which commits the attempt; then
--   2. the run, which records the outcome in the merge's own transaction.
-- statement_timeout = 0 first: a pg_cron session's default on Supabase is 2 min (measured), and a
-- function cannot lift the timeout of the statement that called it. lock_timeout bounds a merge stuck
-- behind another lock (55P03, which the route answers as "try again").
CREATE OR REPLACE FUNCTION public._wsmerge_runner_command()
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT 'SET statement_timeout = 0; SET lock_timeout = ''60s''; SELECT public._wsmerge_claim_next_job(); COMMIT; SELECT public._wsmerge_run_claimed_job()'
$$;


-- Step 1, the claim: fail what waited past its expiry (P0011 never claimed, P0012 claimed but never
-- finished), then take the oldest queued job (FOR UPDATE SKIP LOCKED), count the attempt and remember
-- it for step 2 in a session setting. With nothing queued, unschedule the runner — under the advisory
-- lock the enqueue takes, re-checking after the lock, so a job queued at that moment keeps its runner.
CREATE OR REPLACE FUNCTION public._wsmerge_claim_next_job()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE j public.workspace_merge_job%ROWTYPE;
BEGIN
  PERFORM set_config('dial8.merge_job', '', false);

  UPDATE public.workspace_merge_job
  SET status = 'failed', finished_at = now(),
      error_code = CASE WHEN attempts > 0 THEN 'P0012' ELSE 'P0011' END,
      error_message = CASE WHEN attempts > 0 THEN 'the merge was interrupted before it finished' ELSE 'the merge job expired before it ran' END
  WHERE id IN (SELECT id FROM public.workspace_merge_job
               WHERE status = 'queued' AND created_at < now() - public._wsmerge_job_expiry()
               FOR UPDATE SKIP LOCKED);

  SELECT * INTO j FROM public.workspace_merge_job
  WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED;

  IF j.id IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('workspace_merge_runner'));
    IF NOT EXISTS (SELECT 1 FROM public.workspace_merge_job WHERE status = 'queued')
       AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'workspace-merge-runner') THEN
      DELETE FROM cron.job_run_details WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname = 'workspace-merge-runner');
      PERFORM cron.unschedule('workspace-merge-runner');
    END IF;
    RETURN;
  END IF;

  UPDATE public.workspace_merge_job SET attempts = attempts + 1, claimed_at = now() WHERE id = j.id;
  PERFORM set_config('dial8.merge_job', j.id::text, false);
END;
$$;


-- Step 2, the run: the job step 1 claimed, if it is still queued. A second attempt means the first
-- died without an outcome (a terminated backend, a crash): it is failed (P0012), never re-run — the
-- dead attempt rolled back, so nothing changed. Otherwise merge_workspace and its outcome commit
-- together; query_canceled is caught by name (WHEN OTHERS does not include it).
CREATE OR REPLACE FUNCTION public._wsmerge_run_claimed_job()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE j public.workspace_merge_job%ROWTYPE; v_id uuid; v_res jsonb; v_code text; v_msg text; v_started timestamptz;
BEGIN
  v_id := NULLIF(current_setting('dial8.merge_job', true), '')::uuid;
  PERFORM set_config('dial8.merge_job', '', false);
  IF v_id IS NULL THEN RETURN; END IF;

  SELECT * INTO j FROM public.workspace_merge_job WHERE id = v_id AND status = 'queued' FOR UPDATE SKIP LOCKED;
  IF j.id IS NULL THEN RETURN; END IF;

  IF j.attempts > 1 THEN
    UPDATE public.workspace_merge_job
    SET status = 'failed', error_code = 'P0012', error_message = 'the merge was interrupted before it finished', finished_at = now()
    WHERE id = j.id;
    RETURN;
  END IF;

  v_started := clock_timestamp();
  BEGIN
    v_res := public.merge_workspace(j.source_workspace_id, j.destination_workspace_id, j.actor_user_id, j.plan);
    UPDATE public.workspace_merge_job
    SET status = 'done', result = v_res, started_at = v_started, finished_at = clock_timestamp()
    WHERE id = j.id;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    UPDATE public.workspace_merge_job
    SET status = 'failed', error_code = v_code, error_message = v_msg, started_at = v_started, finished_at = clock_timestamp()
    WHERE id = j.id;
  END;
END;
$$;


-- What the route calls. The gate first (owner of both, not the same workspace: the same refusals and
-- errcodes as merge_workspace, before anything is written), then, under the runner's advisory lock: a
-- job left queued past its expiry for this source is failed so it cannot block a new one; a source with
-- a job still waiting is P0010; the job; the runner. A runner that cannot be scheduled is P0013 (pg_cron's
-- own errcodes would read as the gate's), and the job goes with it.
CREATE OR REPLACE FUNCTION public.merge_workspace_enqueue(
  p_source uuid,
  p_destination uuid,
  p_actor uuid,
  p_plan jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM public._wsmerge_gate(p_source, p_destination, p_actor);
  PERFORM pg_advisory_xact_lock(hashtext('workspace_merge_runner'));

  UPDATE public.workspace_merge_job
  SET status = 'failed', finished_at = now(),
      error_code = CASE WHEN attempts > 0 THEN 'P0012' ELSE 'P0011' END,
      error_message = CASE WHEN attempts > 0 THEN 'the merge was interrupted before it finished' ELSE 'the merge job expired before it ran' END
  WHERE source_workspace_id = p_source AND status = 'queued' AND created_at < now() - public._wsmerge_job_expiry();

  IF EXISTS (SELECT 1 FROM public.workspace_merge_job WHERE source_workspace_id = p_source AND status = 'queued') THEN
    RAISE EXCEPTION 'a merge of this workspace is already waiting to run' USING ERRCODE = 'P0010';
  END IF;

  INSERT INTO public.workspace_merge_job (source_workspace_id, destination_workspace_id, actor_user_id, plan)
  VALUES (p_source, p_destination, p_actor, COALESCE(p_plan, '{}'::jsonb))
  RETURNING id INTO v_id;

  BEGIN
    PERFORM cron.schedule('workspace-merge-runner', '2 seconds', public._wsmerge_runner_command());
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'the merge runner could not be started: %', SQLERRM USING ERRCODE = 'P0013';
  END;
  RETURN v_id;
END;
$$;


-- ── Grants ──────────────────────────────────────────────────────────────────
-- Like 402's: the entry point belongs to the server, the helpers to no client role.
REVOKE EXECUTE ON FUNCTION public.merge_workspace_enqueue(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_workspace_enqueue(uuid, uuid, uuid, jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public._wsmerge_claim_next_job() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public._wsmerge_run_claimed_job() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public._wsmerge_job_expiry() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._wsmerge_runner_command() FROM PUBLIC, anon, authenticated;
-- (_wsmerge_busy keeps 402's grants: CREATE OR REPLACE does not touch them)

NOTIFY pgrst, 'reload schema';
