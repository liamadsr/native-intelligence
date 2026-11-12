/**
 * Migration 539: records kept up to date (src/lib/kept-up-to-date/engine.ts)
 * and its log kind. Pins: no backslash; every statement safe to run twice;
 * the person reads their own rows ONLY while a member, with no client write
 * and no grant to anon; one row per source and record, ever; a row's change
 * names its table and column, a to-do's neither; the sources are the ones
 * data_change takes; the log kind check is 452's list plus this one, the
 * app's list, and the newest word on it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { AGENT_LOG_KINDS } from '@/lib/log/agent-log'
import { DATA_CHANGE_SOURCES } from '@/lib/tables/types'
import { KEPT_SOURCES } from '../part'

const read = (file: string) => readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8')
const flat = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
const SQL = read('539_kept_up_to_date.sql')
const BODY = flat(SQL)
const kindsIn = (body: string) =>
  /add constraint agent_log_kind_check check \(kind in \(([^)]*)\)\)/.exec(body)?.[1].split(',').map((k) => k.trim().replace(/'/g, ''))

describe('migration 539', () => {
  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('is idempotent', () => {
    expect(BODY).toContain('create table if not exists public.kept_change (')
    expect(BODY).toContain('drop policy if exists "kept_change_select_own" on public.kept_change;')
    expect(BODY).not.toMatch(/create index (?!if not exists)/)
    for (const [, table, name] of BODY.matchAll(/alter table public\.(\w+) add constraint (\w+)/g)) {
      expect(BODY).toContain(`alter table public.${table} drop constraint if exists ${name};`)
    }
  })

  it('RLS: the person reads while a member; nobody but the service role writes', () => {
    expect(BODY).toContain('alter table public.kept_change enable row level security;')
    expect(BODY.match(/create policy/g)).toHaveLength(1)
    expect(BODY).toContain(
      'create policy "kept_change_select_own" on public.kept_change for select to authenticated using ((select auth.uid()) = user_id and public.is_workspace_member(workspace_id));',
    )
    expect(BODY).toContain('revoke all on table public.kept_change from anon, authenticated;')
    expect(BODY).toContain('grant select on table public.kept_change to authenticated;')
    expect(BODY).toContain('grant all on table public.kept_change to service_role;')
    expect(BODY).not.toMatch(/to anon/)
    expect(BODY).not.toMatch(/supabase_realtime/)
  })

  it('one row per source and record, ever; the shape of a row’s change and a to-do’s; the sources data_change takes', () => {
    const table = /create table if not exists public\.kept_change \(([^;]*)\);/.exec(BODY)![1]
    const columns = table.split(/,(?![^(]*\))/).map((c) => c.trim().split(' ')[0])
    expect(columns).toEqual([
      'id', 'workspace_id', 'user_id', 'source', 'source_ref', 'source_label', 'record_type', 'record_id', 'table_id', 'field_key',
      'from_value', 'to_value', 'prior_status_id', 'done_status_id', 'data_change_id', 'evidence', 'undone_at', 'created_at',
    ])
    expect(BODY).toContain('add constraint kept_change_source_record_key unique (source, source_ref, record_id);')
    expect(BODY).toContain("(record_type = 'data_row' and table_id is not null and field_key is not null) or (record_type = 'action' and table_id is null and field_key is null)")
    const sources = /kept_change_source_check check \(source in \(([^)]*)\)\)/.exec(BODY)![1].split(',').map((s) => s.trim().replace(/'/g, ''))
    expect(sources).toEqual([...KEPT_SOURCES])
    for (const s of sources) expect(DATA_CHANGE_SOURCES).toContain(s)
    expect(BODY).toContain('data_change_id uuid references public.data_change (id) on delete set null')
  })

  it('the log kind check is 452’s list plus kept_up_to_date: the app’s list, and the newest word on it', () => {
    const kinds = kindsIn(BODY)
    expect(kinds).toEqual([...kindsIn(flat(read('452_look_ahead.sql')))!, 'kept_up_to_date'])
    expect(kinds).toEqual([...AGENT_LOG_KINDS])
    const newest = [...migrationsInOrder()].reverse().find((m) => /add constraint agent_log_kind_check/i.test(m.sql))!.file
    expect(newest).toBe('539_kept_up_to_date.sql')
  })
})
