/**
 * Migration 665: page watches. Pins the file to the app: the widened check
 * keeps every earlier trigger type (662's list) and adds page_changed, it is
 * the newest definition of the check and allows every trigger the app
 * builds, it is added without a scan and validated on its own; the two
 * tables have the columns the watch pass writes, go with their loop, and are
 * the service role's alone; it is bounded and re-runnable, and holds no
 * backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { FLOW_TOOL_TRIGGER_TYPES } from '@/lib/ai/tools/flows'
import { OWNER_EVENT_TRIGGER_TYPES } from '@/lib/flows/types'
import { ADDED_LINES_MAX } from '@/lib/flows/page-watch/diff'
import { PAGE_WATCH_URL_MAX } from '@/lib/flows/page-watch/url'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/665_page_watches.sql'), 'utf8')
const flatten = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
const BODY = flatten(SQL)

function checkedTypes(body: string): string[] {
  const m = /add constraint flow_trigger_type_check check \(trigger_type in \(([^)]*)\)\)/.exec(body)
  expect(m, 'the check is added').not.toBeNull()
  return m![1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''))
}

function tableBody(name: string): string {
  const m = new RegExp(`create table if not exists public\\.${name} \\((.*?)\\);`).exec(BODY)
  expect(m, name).not.toBeNull()
  return m![1]
}

describe('migration 665', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it("keeps every value of 662's check and adds page_changed", () => {
    const earlier = checkedTypes(flatten(readFileSync(join(process.cwd(), 'supabase/migrations/662_contact_created_trigger.sql'), 'utf8')))
    expect(checkedTypes(BODY)).toEqual([...earlier, 'page_changed'])
  })

  it('is the newest definition of the check, and allows every trigger the app builds', () => {
    const defining = migrationsInOrder().filter((m) => /add constraint flow_trigger_type_check/i.test(m.sql))
    expect(defining[defining.length - 1].file).toBe('665_page_watches.sql')
    const allowed = checkedTypes(BODY)
    for (const t of FLOW_TOOL_TRIGGER_TYPES) expect(allowed.includes(t), t).toBe(true)
    for (const t of OWNER_EVENT_TRIGGER_TYPES) expect(allowed.includes(t), t).toBe(true)
  })

  it('widens the check without a scan, then validates it', () => {
    const drop = BODY.indexOf('alter table public.flow drop constraint if exists flow_trigger_type_check;')
    const add = BODY.indexOf('add constraint flow_trigger_type_check')
    const validate = BODY.indexOf('alter table public.flow validate constraint flow_trigger_type_check;')
    expect(drop).toBeGreaterThan(-1)
    expect(drop).toBeLessThan(add)
    expect(BODY).toMatch(/'page_changed'\)\) not valid;/)
    expect(add).toBeLessThan(validate)
  })

  it('flow_page_watch: one row per loop, the columns the pass writes, gone with its loop', () => {
    const t = tableBody('flow_page_watch')
    expect(t).toContain('flow_id uuid primary key references public.flow(id) on delete cascade')
    expect(t).toContain('workspace_id uuid not null')
    expect(t).toContain('url text not null')
    expect(t).toContain("fingerprints jsonb not null default '[]'::jsonb")
    for (const col of ['line_count int null', 'checked_at timestamptz null', 'changed_at timestamptz null', 'failures int not null default 0', 'judge_failures int not null default 0', 'last_error text null', 'created_at timestamptz not null default now()']) {
      expect(t, col).toContain(col)
    }
    expect(BODY).toContain("check (jsonb_typeof(fingerprints) = 'array')")
    expect(BODY).toContain(`check (char_length(url) between 1 and ${PAGE_WATCH_URL_MAX})`)
  })

  it('flow_page_change: the lines that mattered, capped as the pass caps them, gone with its loop, read newest first', () => {
    const t = tableBody('flow_page_change')
    expect(t).toContain('id uuid primary key default gen_random_uuid()')
    expect(t).toContain('flow_id uuid not null references public.flow(id) on delete cascade')
    expect(t).toContain('workspace_id uuid not null')
    expect(t).toContain('url text not null')
    expect(t).toContain('added_lines jsonb not null')
    expect(t).toContain('created_at timestamptz not null default now()')
    expect(BODY).toContain(`jsonb_array_length(added_lines) between 1 and ${ADDED_LINES_MAX}`)
    expect(BODY).toContain('create index if not exists flow_page_change_flow_created_idx on public.flow_page_change (flow_id, created_at desc);')
    // The pass prunes changes past 30 days by age.
    expect(BODY).toContain('create index if not exists flow_page_change_created_idx on public.flow_page_change (created_at);')
  })

  it('both tables are the service role’s alone: RLS on, no policy, nothing for anon or authenticated', () => {
    for (const table of ['flow_page_watch', 'flow_page_change']) {
      expect(BODY).toContain(`alter table public.${table} enable row level security;`)
      expect(BODY).toContain(`revoke all on table public.${table} from anon, authenticated;`)
      expect(BODY).toContain(`grant all on table public.${table} to service_role;`)
    }
    expect(BODY).not.toMatch(/create policy/i)
    expect(BODY).not.toMatch(/grant [^;]* to [^;]*(anon|authenticated)/i)
    // The workspace merge re-stamps workspace_id: no unique index may include it.
    expect(BODY).not.toMatch(/create unique index/i)
  })

  it('is bounded and re-runnable, with no transaction of its own', () => {
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
    expect(BODY).not.toMatch(/\bbegin;|\bcommit;/i)
    for (const m of BODY.matchAll(/add constraint (\w+)/g)) {
      expect(BODY, m[1]).toContain(`drop constraint if exists ${m[1]};`)
    }
    expect(BODY.match(/create table (?!if not exists)/gi)).toBeNull()
    expect(BODY.match(/create index (?!if not exists)/gi)).toBeNull()
    expect(BODY.trim().endsWith("notify pgrst, 'reload schema';")).toBe(true)
  })
})
