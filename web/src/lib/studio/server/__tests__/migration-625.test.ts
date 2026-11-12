/**
 * Migration 625: fair turns at the Studio worker, cancels that stay cancelled, and the bytes a workspace holds. It
 * can't be run here, so the file is pinned as text: the house style, studio_claim_job restated with 620's signature,
 * grants and stale rules plus only the changes 625 is for, and studio_workspace_bytes summing what the app's quota
 * check (blobs.ts) and the in-memory fake (fake.ts) sum. The fake's claim is exercised against the same rules in
 * claim-fairness.test.ts.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { PENDING } from '../blobs'

const read = (f: string) => readFileSync(path.join(process.cwd(), 'supabase/migrations', f), 'utf8')
const sql = read('625_studio_job_fairness.sql')
const sql620 = read('620_studio.sql')

/** A function's statement, from its create line to the end of its body. */
function fnBlock(text: string, name: string): string {
  const i = text.indexOf(`create or replace function public.${name}(`)
  expect(i, name).toBeGreaterThan(-1)
  return text.slice(i, text.indexOf('\n$$;', i) + 4)
}
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

describe('migration 625', () => {
  it('is one transaction in the house style: lock timeout, schema reload, no backslash', () => {
    expect(sql.includes(String.fromCharCode(92))).toBe(false)
    expect(sql).toMatch(/\nbegin;\n\nSET LOCAL lock_timeout = '5s';\n/)
    expect(sql.trimEnd().endsWith("notify pgrst, 'reload schema';\n\ncommit;")).toBe(true)
    expect(sql).not.toMatch(/drop (table|function|index)/i)
    expect(sql).not.toMatch(/create table/i)
    expect(sql).toMatch(/^-- 625: /m)
  })

  it('restates studio_claim_job with 620’s signature and grants (631 restates it again: migration-631.test.ts holds the newest)', () => {
    const defining = migrationsInOrder().filter((m) => /create or replace function public\.studio_claim_job\(/i.test(m.sql))
    expect(defining.map((m) => m.file)).toContain('625_studio_job_fairness.sql')
    const head = (text: string) => squash(fnBlock(text, 'studio_claim_job')).split(' as $$')[0]!
    expect(head(sql)).toBe(head(sql620))
    for (const grant of [
      'revoke execute on function public.studio_claim_job(text, text[], integer) from public, anon, authenticated;',
      'grant execute on function public.studio_claim_job(text, text[], integer) to service_role;',
    ]) {
      expect(sql620).toContain(grant)
      expect(sql).toContain(grant)
    }
  })

  it('fails a stale paid job (a shot, a narration; 631 adds the later kinds) first, saying the provider may have charged, never queuing it again', () => {
    const fn = squash(fnBlock(sql, 'studio_claim_job'))
    const kinds = "'shot', 'narration'"
    const paid = fn.indexOf(
      `set status = 'failed', error = 'The worker stopped while making this, after it may have asked the provider: it may have charged. Check the costs before trying again.', updated_at = now() where status = 'running' and kind in (${kinds}) and coalesce(heartbeat_at, claimed_at, created_at) < now() - make_interval(secs => p_stale_seconds);`,
    )
    expect(paid).toBeGreaterThan(-1)
    // Before every other stale rule: nothing else can queue it again or end it otherwise first.
    for (const other of ["where status = 'running' and cancel_requested", "where status = 'running' and attempts >= 3", "set status = 'queued', worker_id = null"]) {
      expect(fn.indexOf(other)).toBeGreaterThan(paid)
    }
  })

  it('cancels what was asked to stop before anything goes back in the queue, then picks fairly', () => {
    const fn = squash(fnBlock(sql, 'studio_claim_job'))
    const staleCancel = fn.indexOf("set status = 'cancelled', error = coalesce(error, 'Cancelled.'), updated_at = now() where status = 'running' and cancel_requested and coalesce(heartbeat_at, claimed_at, created_at) < now() - make_interval(secs => p_stale_seconds);")
    const queuedCancel = fn.indexOf("set status = 'cancelled', error = coalesce(error, 'Cancelled.'), updated_at = now() where status = 'queued' and cancel_requested;")
    const fail = fn.indexOf("where status = 'running' and attempts >= 3")
    const requeue = fn.indexOf("set status = 'queued', worker_id = null")
    const pick = fn.indexOf('select j.id into picked')
    for (const at of [staleCancel, queuedCancel, fail, requeue, pick]) expect(at).toBeGreaterThan(-1)
    expect(staleCancel).toBeLessThan(requeue)
    expect(queuedCancel).toBeLessThan(pick)
    expect(fail).toBeLessThan(requeue)
    expect(requeue).toBeLessThan(pick)
    // The pick: the workspace with the fewest running jobs, then the oldest job, locking only the row it takes.
    expect(fn).toContain(
      "order by ( select count(*) from public.studio_job r where r.workspace_id = j.workspace_id and r.status = 'running' ), j.created_at limit 1 for update of j skip locked;",
    )
    // 620's claim itself is unchanged.
    const claim = (text: string) => squash(fnBlock(text, 'studio_claim_job').slice(fnBlock(text, 'studio_claim_job').indexOf('if picked is null')))
    expect(claim(sql)).toBe(claim(sql620))
    expect(sql).toContain("create index if not exists studio_job_running_idx\n  on public.studio_job (workspace_id) where status = 'running';")
  })

  it('sums stored files and pending writes for the quota, service role only', () => {
    const fn = squash(fnBlock(sql, 'studio_workspace_bytes'))
    expect(fn).toContain('returns bigint language sql stable security definer set search_path = public, pg_temp')
    expect(fn).toContain('sum(b.bytes) from public.studio_blob b where b.workspace_id = p_workspace')
    expect(fn).toContain(`r.collection = '${PENDING}'`)
    expect(sql).toContain('revoke execute on function public.studio_workspace_bytes(uuid) from public, anon, authenticated;')
    expect(sql).toContain('grant execute on function public.studio_workspace_bytes(uuid) to service_role;')
    expect(sql).toContain('create index if not exists studio_blob_workspace_bytes_idx\n  on public.studio_blob (workspace_id) include (bytes);')
  })
})
