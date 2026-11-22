/**
 * Migration 689: the private presence room of a spreadsheet. It can't be run
 * here, so the file is pinned as text (it was rehearsed on a real Postgres,
 * applied twice, with three people: docs/plans/spreadsheets.md). The key
 * properties:
 *   - additive: no existing function or policy is redefined;
 *   - a presence topic gives up its spreadsheet only when it is exactly
 *     `spreadsheet-presence:<uuid>`, compared as text before any cast;
 *   - hearing and saying in the room are both "may read the spreadsheet"
 *     (675's own rule), for broadcast only, for signed-in people only.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { presenceTopic } from '@/components/spreadsheets/presence'

const file = 'supabase/migrations/689_spreadsheet_presence.sql'
const sql = readFileSync(path.join(process.cwd(), file), 'utf8')
const code = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')

function statement(start: string): string {
  const i = code.indexOf(start)
  expect(i, start).toBeGreaterThan(-1)
  return code.slice(i, code.indexOf(';', i) + 1)
}

function body(fn: string): string {
  const i = code.indexOf(`create or replace function ${fn}(`)
  expect(i, fn).toBeGreaterThan(-1)
  const open = code.indexOf('as $$', i)
  const close = code.indexOf('$$;', open)
  expect(open).toBeGreaterThan(i)
  expect(close).toBeGreaterThan(open)
  return code.slice(i, close + 3)
}

describe('migration 689: additive, in the house style', () => {
  it('is one transaction with a lock timeout and a schema reload, and has no backslash', () => {
    expect(code).toMatch(/^\s*begin;/)
    expect(code).toContain("SET LOCAL lock_timeout = '5s';")
    expect(code).toMatch(/commit;\s*notify pgrst, 'reload schema';\s*$/)
    expect(code.match(/^begin;$/gm)?.length).toBe(1)
    expect(code.match(/^commit;$/gm)?.length).toBe(1)
    expect(sql).not.toContain('\\')
  })

  it('opens its one function body with `as $$` and closes it with `$$;`', () => {
    const fns = [...code.matchAll(/create or replace function (public\.[a-z_]+)\(/g)].map((m) => m[1])
    expect(fns).toEqual(['public.spreadsheet_presence_sheet'])
    expect(body(fns[0])).toMatch(/\nas \$\$\n[\s\S]+\n\$\$;$/)
    // Two dollar-quote marks, and no lone `$`: nothing left open.
    expect(code.match(/\$\$/g)?.length).toBe(2)
    expect(code.replace(/\$\$/g, '').replace(/\{12\}\$'/g, '')).not.toContain('$')
  })

  it('defines only its own two policies, each dropped before it is made, and redefines nothing of 675', () => {
    const made = [...code.matchAll(/create policy "?([a-z_]+)"? on ([a-z_.]+)/g)].map((m) => `${m[1]} on ${m[2]}`)
    expect(made.sort()).toEqual(['spreadsheet_presence_hear on realtime.messages', 'spreadsheet_presence_say on realtime.messages'])
    const dropped = [...code.matchAll(/drop policy if exists "?([a-z_]+)"? on ([a-z_.]+)/g)].map((m) => `${m[1]} on ${m[2]}`)
    expect(dropped.sort()).toEqual(made.sort())
    for (const fn of ['spreadsheet_entity_visible_to', 'spreadsheet_before_write', 'spreadsheet_track_change', 'spreadsheet_comment_guard', 'current_member_id', 'is_workspace_member']) {
      expect(code).not.toContain(`function public.${fn}(uuid`)
      expect(code).not.toContain(`create or replace function public.${fn}(`)
    }
    expect(code).not.toMatch(/alter policy|drop function|drop table|create table|alter table|security definer/)
  })
})

describe('migration 689: the presence room is private', () => {
  const parser = body('public.spreadsheet_presence_sheet')
  const pattern = parser.match(/topic ~ '([^']+)'/)?.[1]

  it('reads a spreadsheet out of a topic only when the whole topic is spreadsheet-presence:<uuid>', () => {
    expect(pattern).toBe('^spreadsheet-presence:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    const re = new RegExp(pattern as string)
    const id = '3f2b8c1e-5a4d-4e6f-9a7b-0c1d2e3f4a5b'
    expect(re.test(`spreadsheet-presence:${id}`)).toBe(true)
    for (const bad of [
      'spreadsheet-presence:',
      'spreadsheet-presence:not-a-uuid',
      `spreadsheet-presence:${id}x`,
      `spreadsheet-presence:${id}' or true --`,
      `spreadsheet-presence:${id}:extra`,
      `xspreadsheet-presence:${id}`,
      `spreadsheet-presence:${id.toUpperCase()}`,
      `spreadsheet-presence:${id}\n`,
      `canvas-presence:${id}`,
      id,
    ]) {
      expect(re.test(bad), bad).toBe(false)
    }
    // The cast happens only inside the branch the text test has passed.
    expect(parser).toMatch(/select case\s+when topic ~ '[^']+'\s+then split_part\(topic, ':', 2\)::uuid\s+end;/)
    expect(parser).toContain('immutable')
    expect(parser).toContain('set search_path = public, pg_temp')
  })

  it('is the topic the editor joins, upper-case ids included', () => {
    const re = new RegExp(pattern as string)
    expect(presenceTopic('3f2b8c1e-5a4d-4e6f-9a7b-0c1d2e3f4a5b')).toBe('spreadsheet-presence:3f2b8c1e-5a4d-4e6f-9a7b-0c1d2e3f4a5b')
    expect(re.test(presenceTopic('3F2B8C1E-5A4D-4E6F-9A7B-0C1D2E3F4A5B'))).toBe(true)
  })

  // 675's read rule, asked about the caller themself and with no workspace
  // named: the spreadsheet's own workspace is the one that counts.
  const RULE =
    "realtime.topic() like 'spreadsheet-presence:%'\n" +
    "    and realtime.messages.extension = 'broadcast'\n" +
    '    and public.spreadsheet_entity_visible_to(public.spreadsheet_presence_sheet(realtime.topic()), null, (select auth.uid()))'

  it('lets only whoever may read the spreadsheet hear, and only by broadcast', () => {
    const hear = statement('create policy "spreadsheet_presence_hear" on realtime.messages')
    expect(hear).toContain('for select to authenticated')
    expect(hear).toContain(`using (\n    ${RULE}\n  );`)
  })

  it('lets only whoever may read the spreadsheet say, by the same rule', () => {
    const say = statement('create policy "spreadsheet_presence_say" on realtime.messages')
    expect(say).toContain('for insert to authenticated')
    expect(say).toContain(`with check (\n    ${RULE}\n  );`)
  })

  it('gives nobody but signed-in people the topic parser, and no policy to anon', () => {
    expect(code).toContain('revoke all on function public.spreadsheet_presence_sheet(text) from public, anon;')
    expect(code).toContain('grant execute on function public.spreadsheet_presence_sheet(text) to authenticated;')
    expect(code).not.toMatch(/for (select|insert|update|delete|all) to (public|anon)/)
  })

  it('rests on the read rule 675 made, which answers no for no id, another person, a stranger and a private one', () => {
    const base = readFileSync(path.join(process.cwd(), 'supabase/migrations/675_spreadsheets.sql'), 'utf8')
    const i = base.indexOf('create or replace function public.spreadsheet_entity_visible_to(p_id uuid, p_workspace uuid, p_user uuid)')
    expect(i).toBeGreaterThan(-1)
    const fn = base.slice(i, base.indexOf('$$;', i))
    expect(fn).toContain('security definer')
    expect(fn).toContain('set search_path = public, pg_temp')
    expect(fn).toContain('if p_id is null or p_user is null then return false; end if;')
    expect(fn).toContain('if auth.uid() is not null and p_user is distinct from auth.uid() then return false; end if;')
    expect(fn).toContain('if v_member is null then return false; end if;')
    expect(fn).toContain("return v_visibility = 'workspace' or v_creator = v_member;")
    // A null workspace means "the spreadsheet's own", which is what 689 passes.
    expect(fn).toContain('(p_workspace is not null and v_ws <> p_workspace)')
  })
})
