/**
 * Migrations 650 (a call's audio files) and 651 (every bucket without a limit
 * of its own gets today's 50 MB): one transaction each, a lock timeout, no
 * backslash, nothing dropped but the policy 650 makes again; numbered once.
 * 650's table is the server's (RLS on, nothing for anon or authenticated, no
 * unique index with workspace_id: 402's merge re-stamps it); its functions
 * are security definer with search_path pinned and only the service role may
 * run them, except the read policy's helper; the files are kept 30 days from
 * the session's start, in the call's folder of the recordings bucket under
 * audio/; the read policy reads the capture as the person. 651 touches only
 * buckets without a limit. web/scripts/check-capture-audio-sql.mjs runs both
 * on PGlite (applied twice, the functions exercised with rows, the policy as
 * a signed-in person); this pins the text in the suite.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8')
const bodyOf = (sql: string) => sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const flat = (sql: string) => bodyOf(sql).replace(/\s+/g, ' ')

const A = read('650_capture_feed_audio.sql')
const B = read('651_storage_bucket_limits.sql')

const FUNCTIONS = ['capture_feed_audio_grant', 'capture_feed_audio_stored', 'capture_audio_settle', 'capture_audio_due', 'capture_audio_orphans', 'capture_audio_capture_of']

function definition(sql: string, name: string): string {
  const start = sql.search(new RegExp(`create or replace function public\\.${name}\\(`, 'i'))
  expect(start, name).toBeGreaterThanOrEqual(0)
  const close = sql.indexOf('$$;', sql.indexOf('$$', start) + 2)
  return sql.slice(start, close + 3)
}

describe('migrations 650 and 651', () => {
  it('each one transaction with a lock timeout, no backslash, nothing destructive', () => {
    for (const sql of [A, B]) {
      const body = bodyOf(sql)
      expect(sql).not.toContain('\\')
      expect(body).toMatch(/^\s*begin;\s*SET LOCAL lock_timeout = '5s';/)
      expect(body.trimEnd().endsWith('commit;')).toBe(true)
      expect(body).not.toMatch(/concurrently|vacuum|drop table|drop column|drop function|truncate|delete from/i)
    }
    expect(bodyOf(A).trimEnd().endsWith("notify pgrst, 'reload schema';\n\ncommit;")).toBe(true)
    expect(flat(A).match(/drop policy if exists/g)).toHaveLength(1)
  })

  it('numbered once each', () => {
    const numbers = migrationsInOrder().map((m) => m.num)
    expect(numbers.filter((n) => n === 650)).toHaveLength(1)
    expect(numbers.filter((n) => n === 651)).toHaveLength(1)
  })

  it('650’s table is the server’s alone, merge-safe', () => {
    const t = flat(A)
    expect(t).toContain('alter table public.capture_audio enable row level security;')
    expect(t).toContain('revoke all on table public.capture_audio from anon, authenticated;')
    expect(t).not.toMatch(/grant [a-z, ]+ on table public\.capture_audio to (anon|authenticated)/)
    for (const idx of t.match(/create unique index[^;]+;/g) ?? []) expect(idx).not.toContain('workspace_id')
    expect(t).toContain('workspace_id uuid not null references public.workspace(id) on delete cascade')
    expect(t).toContain('capture_id uuid not null references public.captures(id) on delete cascade')
  })

  it('every function: security definer, search_path pinned, run by the service role; only the policy’s helper by a signed-in person', () => {
    for (const fn of FUNCTIONS) {
      const def = flat(definition(A, fn))
      expect(def, fn).toContain('security definer set search_path = public, pg_temp')
      expect(flat(A), fn).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to [a-z_, ]*service_role;`))
      expect(flat(A), fn).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon`))
    }
    expect(flat(A)).toContain('grant execute on function public.capture_audio_capture_of(text) to authenticated, service_role;')
    expect(flat(A).match(/to authenticated/g)?.length).toBe(2) // the helper's grant, and the policy itself
  })

  it('kept 30 days from the session’s start, in the call’s folder under audio/, at most 2 GB, 10 takes a session, 200 links a take', () => {
    const g = flat(definition(A, 'capture_feed_audio_grant'))
    expect(g).toContain("keep_until := s.started_at + interval '30 days';")
    expect(g).toContain("channel::text || '/' || s.source_ref::text || '/audio/' || new_id::text")
    expect(g).toContain('p_bytes > 2147483648')
    expect(g).toContain('next_part >= 10')
    expect(g).toContain('if a.grants >= 200 then')
    expect(g).toContain('s.producer_id is distinct from p_producer_id')
    expect(g).toContain("if s.source_kind <> 'team_call' then")
  })

  it('stored only when Storage’s own row has the object', () => {
    const s = flat(definition(A, 'capture_feed_audio_stored'))
    expect(s).toContain("from storage.objects o where o.bucket_id = 'team-call-recordings' and o.name = a.path;")
    expect(s).toContain("return query select 'missing'::text")
    // Of the type its grant named: anything else is never kept.
    expect(s).toContain('if kind is distinct from a.content_type or size > 2147483648 then')
    // The sweep's settle keeps a file on the same checks.
    expect(flat(definition(A, 'capture_audio_settle'))).toContain("((o.metadata ->> 'mimetype') is not distinct from a.content_type and coalesce((o.metadata ->> 'size')::bigint, 0) between 1 and 2147483648) as fits")
  })

  it('the sweep’s reads touch only audio files: due by expires_at, orphans under audio/ an hour old', () => {
    expect(flat(definition(A, 'capture_audio_due'))).toContain("where a.state in ('pending', 'stored') and a.expires_at <= now()")
    const o = flat(definition(A, 'capture_audio_orphans'))
    expect(o).toContain("split_part(o.name, '/', 3) = 'audio'")
    expect(o).toContain("o.created_at < now() - interval '1 hour'")
  })

  it('the read policy: a stored audio file, read by whoever may read its capture (the captures table’s RLS, as them)', () => {
    const t = flat(A)
    expect(t).toContain(
      `create policy "team call audio read" on storage.objects for select to authenticated using ( bucket_id = 'team-call-recordings' and split_part(name, '/', 3) = 'audio' and exists (select 1 from public.captures c where c.id = public.capture_audio_capture_of(name)) );`,
    )
    expect(flat(definition(A, 'capture_audio_capture_of'))).toContain("where a.path = object_name and a.state = 'stored' and a.expires_at > now()")
  })

  it('651 gives today’s 50 MB to every bucket without a limit, and touches no other', () => {
    expect(flat(B)).toContain('update storage.buckets set file_size_limit = 52428800, updated_at = now() where file_size_limit is null;')
    expect(flat(B).match(/update /g)).toHaveLength(1)
  })
})
