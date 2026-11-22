/**
 * Migrations 687 (a notification may point at a canvas or a spreadsheet) and
 * 692 (a comment the assistant wrote says so). Pinned as text; both were
 * applied twice on a real Postgres and rehearsed (docs/plans/canvas.md).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (f: string) => readFileSync(path.join(process.cwd(), 'supabase/migrations', f), 'utf8')
const strip = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
const list = (code: string) => {
  const m = /add constraint notification_target_type_check check \(target_type in \(([\s\S]*?)\)\)/.exec(code)
  return (m?.[1].match(/'([a-z_]+)'/g) ?? []).map((v) => v.slice(1, -1))
}
const house = (sql: string, code: string) => {
  expect(code).toMatch(/^\s*begin;/)
  expect(code).toContain("SET LOCAL lock_timeout = '5s';")
  expect(code).toMatch(/commit;\s*notify pgrst, 'reload schema';\s*$/)
  expect(sql).not.toContain('\\')
}

describe('migration 687: notification targets', () => {
  const sql = read('687_notification_canvas_spreadsheet.sql')
  const code = strip(sql)

  it('has its own begin/commit, a lock timeout and no backslash, and makes no function', () => {
    house(sql, code)
    expect(code).not.toMatch(/create (or replace )?function|create policy|create table|\$\$/)
  })

  it('is 679\'s list plus canvas and spreadsheet: nothing taken away', () => {
    const before = list(strip(read('679_crm_companies.sql')))
    const after = list(code)
    expect(before.length).toBeGreaterThan(10)
    expect(after).toEqual([...before, 'canvas', 'spreadsheet'])
  })

  it('swaps the constraint in a way that can run twice, and checks the rows that exist', () => {
    expect(code).toContain('alter table public.notification drop constraint if exists notification_target_type_check;')
    expect(code).toMatch(/\)\) not valid;\s*alter table public\.notification validate constraint notification_target_type_check;/)
    // No later migration redefined the constraint this one starts from.
    expect(read('680_company_team_email.sql') + read('681_comment_author_guard.sql') + read('682_canvas_comments_presence.sql') + read('686_canvas_comment_thread_visibility.sql')).not.toContain('notification_target_type_check')
  })
})

describe('migration 692: the assistant\'s mark on a comment', () => {
  const sql = read('692_comment_via_agent.sql')
  const code = strip(sql)

  it('has its own begin/commit, a lock timeout and no backslash', () => house(sql, code))

  it('adds one column to each comment table: not null, false unless said', () => {
    for (const t of ['canvas_comment', 'spreadsheet_comment']) {
      expect(code).toContain(`alter table public.${t} add column if not exists via_agent boolean not null default false;`)
    }
    expect(code.match(/add column/g)).toHaveLength(2)
  })

  it('defines one new function and redefines no guard of 675, 681 or 682', () => {
    expect([...code.matchAll(/create or replace function (public\.[a-z_]+)\(/g)].map((m) => m[1])).toEqual(['public.record_comment_agent_mark_guard'])
    for (const f of ['675_spreadsheets.sql', '681_comment_author_guard.sql', '682_canvas_comments_presence.sql']) expect(read(f)).not.toContain('record_comment_agent_mark_guard')
    expect(code).not.toMatch(/function public\.(canvas_comment_guard|spreadsheet_comment_guard)\(/)
    expect(code).not.toMatch(/create policy|alter policy|drop policy|drop function|drop table/)
  })

  it('opens the function body with `as $$` and closes it with `$$;`', () => {
    const i = code.indexOf('create or replace function public.record_comment_agent_mark_guard()')
    const body = code.slice(i, code.indexOf('$$;', i) + 3)
    expect(body).toMatch(/\nas \$\$\n[\s\S]+\n\$\$;$/)
    expect(code.match(/\$\$/g)).toHaveLength(2)
    expect(body).toContain('set search_path = public, pg_temp')
    expect(body).not.toContain('security definer')
  })

  it('refuses a client that changes the mark, and lets the service side through', () => {
    expect(code).toContain("if current_user not in ('authenticated', 'anon') then\n    return new;")
    expect(code).toContain("if new.via_agent is distinct from old.via_agent then\n    raise exception 'Who wrote a comment does not change.' using errcode = '42501';")
  })

  it('puts its own before-update trigger on each table, dropped first', () => {
    for (const t of ['canvas_comment', 'spreadsheet_comment']) {
      expect(code).toContain(`drop trigger if exists ${t}_agent_mark_guard on public.${t};`)
      expect(code).toContain(`create trigger ${t}_agent_mark_guard\n  before update on public.${t}\n  for each row execute function public.record_comment_agent_mark_guard();`)
    }
    expect(code.match(/create trigger/g)).toHaveLength(2)
  })
})
