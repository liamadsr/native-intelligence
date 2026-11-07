/**
 * Migration 417 (merge workspaces: the busy check counts only running work,
 * and the merge runs as a database job). Verified on DEV: the end-to-end with
 * the file prepended (a running agent run still refuses; a capture quiet for
 * days, runs parked in needs_input and pr_open and a job waiting for review do
 * not, and come over), a pg_cron probe (the default session timeout is 2 min;
 * with the runner's SET the job ran 130 s), and scratch merges through the job
 * via PostgREST as service_role (done; a duplicate P0010; a source busy at run
 * time recorded as failed with nothing changed). This pins the rules and the
 * job's shape so a later edit cannot loosen either silently.
 */
import { describe, it, expect } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

const MIGRATIONS = migrationsInOrder()
const FILE = MIGRATIONS.find((m) => m.file === '417_merge_workspaces_job_and_busy.sql')!

/** A migration's SQL without comment lines, whitespace collapsed. */
function flat(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
}
const BODY = flat(FILE.sql)

/** The newest migration defining `public.<fn>`. */
function newestFile(fn: string): string {
  const needle = new RegExp(`create or replace function public\\.${fn}\\(`, 'i')
  for (let i = MIGRATIONS.length - 1; i >= 0; i--) if (needle.test(MIGRATIONS[i].sql)) return MIGRATIONS[i].file
  throw new Error(`no migration defines ${fn}`)
}

/** One function's definition out of a flattened migration. */
function definition(fn: string, sql = BODY): string {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(.*?\\$\\$;`).exec(sql)
  if (!m) throw new Error(`${fn} not defined`)
  return m[0]
}

describe('migration 417: the busy check and the merge job', () => {
  it('exists once and is the newest word on the busy check, the runner and the enqueue', () => {
    expect(FILE).toBeDefined()
    expect(MIGRATIONS.filter((m) => m.num === 417)).toHaveLength(1)
    for (const fn of ['_wsmerge_busy', '_wsmerge_claim_next_job', '_wsmerge_run_claimed_job', '_wsmerge_runner_command', 'merge_workspace_enqueue', '_wsmerge_job_expiry']) {
      expect(newestFile(fn), fn).toBe('417_merge_workspaces_job_and_busy.sql')
    }
  })

  it('the busy check counts only what is running, and keeps the shape the preflight and the sheet read', () => {
    const busy = definition('_wsmerge_busy')
    // a capture recording now: written to in the last hour, never an eval
    expect(busy).toContain(
      "c.workspace_id = p_workspace AND c.status = 'active' AND c.started_at IS NOT NULL AND c.ended_at IS NULL AND c.is_eval IS NOT TRUE AND c.updated_at > now() - interval '1 hour'",
    )
    // agent runs executing, canceling for at most 90 minutes, and local agent turns under a live lease
    expect(busy).toContain("r.status IN ('queued', 'running') OR (r.status = 'canceling' AND COALESCE(r.started_at, r.created_at) > now() - interval '90 minutes')")
    expect(busy).toContain("s.status IN ('starting', 'running') AND COALESCE(s.lease_expires_at, s.claimed_at + interval '15 minutes') > now()")
    // a loop parked on an approval card; a tracked job queued or running inside its deadline
    expect(busy).toContain("public.flow_run_state s WHERE s.workspace_id = p_workspace AND s.status IN ('parked', 'resuming')")
    expect(busy).toContain(
      "j.status IN ('queued', 'running') AND COALESCE(j.deadline_at, j.last_beat_at + interval '6 hours', j.created_at + interval '6 hours') > now()",
    )
    // the waiting states are no longer busy
    for (const waiting of ['needs_input', 'pr_open', 'needs_review', 'waiting_on_child', "'pending'"]) {
      expect(busy, waiting).not.toContain(waiting)
    }
    // the four keys merge_workspace (402) and describeBlockers read
    for (const key of ["'live_captures'", "'agent_runs'", "'flow_runs'", "'tracked_jobs'"]) expect(busy).toContain(key)
  })

  it('installs Supabase Cron in pg_catalog only when missing, and grants nothing of its own (Supabase’s script does)', () => {
    expect(BODY).toContain("IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN CREATE EXTENSION pg_cron WITH SCHEMA pg_catalog; END IF;")
    // an extra GRANT made Supabase's after-create script fail on a second run ("dependent privileges exist")
    expect(BODY).not.toMatch(/GRANT [^;]* SCHEMA cron/i)
  })

  it('the job is the server’s: no foreign keys (the source is deleted), row security on, one queued merge per source', () => {
    const table = /CREATE TABLE IF NOT EXISTS public\.workspace_merge_job \((.*?)\);/.exec(BODY)?.[1] ?? ''
    expect(table).toContain('source_workspace_id uuid NOT NULL')
    expect(table).toContain('attempts int NOT NULL DEFAULT 0')
    expect(table).toContain("status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'done', 'failed'))")
    expect(table).not.toMatch(/REFERENCES/i)
    expect(BODY).toContain("CREATE UNIQUE INDEX IF NOT EXISTS workspace_merge_job_one_queued_per_source ON public.workspace_merge_job (source_workspace_id) WHERE status = 'queued';")
    expect(BODY).toContain('ALTER TABLE public.workspace_merge_job ENABLE ROW LEVEL SECURITY;')
    expect(BODY).toContain('REVOKE ALL ON public.workspace_merge_job FROM anon, authenticated;')
  })

  it('the runner is two transactions: the claim commits the attempt, the run commits the merge with its outcome', () => {
    const command = definition('_wsmerge_runner_command')
    // a pg_cron session's default timeout on Supabase is 2 min: lifted before the statements that need it
    expect(command).toContain(
      "SELECT 'SET statement_timeout = 0; SET lock_timeout = ''60s''; SELECT public._wsmerge_claim_next_job(); COMMIT; SELECT public._wsmerge_run_claimed_job()'",
    )

    const claim = definition('_wsmerge_claim_next_job')
    expect(claim).toContain("WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED;")
    expect(claim).toContain('UPDATE public.workspace_merge_job SET attempts = attempts + 1, claimed_at = now() WHERE id = j.id;')
    expect(claim).toContain("PERFORM set_config('dial8.merge_job', j.id::text, false);")
    // past the expiry: never claimed is P0011, claimed but never finished is P0012
    expect(claim).toContain("error_code = CASE WHEN attempts > 0 THEN 'P0012' ELSE 'P0011' END")
    expect(definition('_wsmerge_job_expiry')).toContain("SELECT interval '30 minutes'")
    // with nothing queued it unschedules itself — the re-check comes AFTER the lock the enqueue takes
    const lockAt = claim.indexOf("PERFORM pg_advisory_xact_lock(hashtext('workspace_merge_runner'));")
    const recheckAt = claim.indexOf("IF NOT EXISTS (SELECT 1 FROM public.workspace_merge_job WHERE status = 'queued')")
    const unscheduleAt = claim.indexOf("PERFORM cron.unschedule('workspace-merge-runner');")
    expect(lockAt).toBeGreaterThan(-1)
    expect(recheckAt).toBeGreaterThan(lockAt)
    expect(unscheduleAt).toBeGreaterThan(recheckAt)

    const run = definition('_wsmerge_run_claimed_job')
    expect(run).toContain("v_id := NULLIF(current_setting('dial8.merge_job', true), '')::uuid;")
    // a second attempt means the first died without an outcome: failed, never re-run
    const retryAt = run.indexOf("IF j.attempts > 1 THEN UPDATE public.workspace_merge_job SET status = 'failed', error_code = 'P0012'")
    const mergeAt = run.indexOf('v_res := public.merge_workspace(j.source_workspace_id, j.destination_workspace_id, j.actor_user_id, j.plan);')
    const doneAt = run.indexOf("SET status = 'done', result = v_res")
    const handlerAt = run.indexOf('EXCEPTION WHEN query_canceled OR OTHERS THEN GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;')
    const failedAt = run.indexOf("SET status = 'failed', error_code = v_code, error_message = v_msg")
    expect(retryAt).toBeGreaterThan(-1)
    expect(mergeAt).toBeGreaterThan(retryAt)
    expect(doneAt).toBeGreaterThan(mergeAt)
    expect(handlerAt).toBeGreaterThan(doneAt)
    expect(failedAt).toBeGreaterThan(handlerAt)
  })

  it('the enqueue checks the gate before writing, then under the runner’s lock refuses a second queued merge, queues, and starts the runner', () => {
    const enqueue = definition('merge_workspace_enqueue')
    const gateAt = enqueue.indexOf('PERFORM public._wsmerge_gate(p_source, p_destination, p_actor);')
    const lockAt = enqueue.indexOf("PERFORM pg_advisory_xact_lock(hashtext('workspace_merge_runner'));")
    const duplicateAt = enqueue.indexOf("RAISE EXCEPTION 'a merge of this workspace is already waiting to run' USING ERRCODE = 'P0010';")
    const insertAt = enqueue.indexOf('INSERT INTO public.workspace_merge_job')
    const scheduleAt = enqueue.indexOf("PERFORM cron.schedule('workspace-merge-runner', '2 seconds', public._wsmerge_runner_command());")
    expect(gateAt).toBeGreaterThan(-1)
    expect(lockAt).toBeGreaterThan(gateAt)
    expect(duplicateAt).toBeGreaterThan(lockAt)
    expect(insertAt).toBeGreaterThan(duplicateAt)
    expect(scheduleAt).toBeGreaterThan(insertAt)
    // pg_cron's own errcodes (22023, 42501) would read as the gate's: a failed schedule is P0013
    expect(enqueue).toContain("RAISE EXCEPTION 'the merge runner could not be started: %', SQLERRM USING ERRCODE = 'P0013';")
  })

  it('belongs to the server: the enqueue for service_role only, the runner and its helper for no API role', () => {
    expect(BODY).toContain('REVOKE EXECUTE ON FUNCTION public.merge_workspace_enqueue(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;')
    expect(BODY).toContain('GRANT EXECUTE ON FUNCTION public.merge_workspace_enqueue(uuid, uuid, uuid, jsonb) TO service_role;')
    expect(BODY).toContain('REVOKE EXECUTE ON FUNCTION public._wsmerge_claim_next_job() FROM PUBLIC, anon, authenticated, service_role;')
    expect(BODY).toContain('REVOKE EXECUTE ON FUNCTION public._wsmerge_run_claimed_job() FROM PUBLIC, anon, authenticated, service_role;')
    expect(BODY).toContain('REVOKE EXECUTE ON FUNCTION public._wsmerge_job_expiry() FROM PUBLIC, anon, authenticated;')
    expect(BODY).toContain('REVOKE EXECUTE ON FUNCTION public._wsmerge_runner_command() FROM PUBLIC, anon, authenticated;')
    expect(BODY).not.toMatch(/GRANT EXECUTE ON FUNCTION public\._wsmerge_(claim_next|run_claimed)_job/)
  })
})
