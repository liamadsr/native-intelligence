/**
 * Migration 686: 682's thread check, narrowed to canvases the caller can open.
 * Pinned as text (rehearsed on a real Postgres, applied twice after 682).
 * 682's file is not touched: it may already have been applied.
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
const sql = read('686_canvas_comment_thread_visibility.sql')
const code = strip(sql)
const before = strip(read('682_canvas_comments_presence.sql'))

const definition = (text: string) => {
  const i = text.indexOf('create or replace function public.canvas_comment_is_thread(')
  return text.slice(i, text.indexOf('$$;', i) + 3)
}

describe('migration 686: the thread check answers only for a canvas the caller can open', () => {
  it('is one re-runnable transaction in the house style, with no backslash', () => {
    expect(code).toMatch(/^\s*begin;/)
    expect(code).toContain("SET LOCAL lock_timeout = '5s';")
    expect(code).toMatch(/commit;\s*notify pgrst, 'reload schema';\s*$/)
    expect(sql).not.toContain('\\')
    expect(code).not.toMatch(/create (table|policy|trigger|index)|drop |alter /)
  })

  it('replaces exactly one function, whose body opens with `as $$` and closes with `$$;`', () => {
    expect([...code.matchAll(/create or replace function (public\.[a-z_]+)\(/g)].map((m) => m[1])).toEqual(['public.canvas_comment_is_thread'])
    expect(definition(code)).toMatch(/\nas \$\$\n[\s\S]+\n\$\$;$/)
    expect(code.match(/\$\$/g)?.length).toBe(2)
  })

  it('keeps 682\'s name, arguments, return type and settings, so the policy and grants stand', () => {
    const head = (d: string) => d.slice(0, d.indexOf('as $$'))
    expect(head(definition(code))).toBe(head(definition(before)))
    expect(head(definition(code))).toContain('security definer')
    expect(head(definition(code))).toContain('set search_path = public, pg_temp')
  })

  it('adds one condition to 682\'s body: the caller can open the canvas, or is no person', () => {
    const added = "\n       and ((select auth.uid()) is null or public.canvas_visible_to(p_canvas, (select auth.uid())))"
    expect(definition(code)).toBe(definition(before).replace('\n       and p.parent_id is null', '\n       and p.parent_id is null' + added))
    expect(definition(before)).not.toContain('canvas_visible_to')
  })

  it('leaves the function to signed-in people and the service role', () => {
    expect(code).toContain('revoke all on function public.canvas_comment_is_thread(uuid, uuid) from public, anon;')
    expect(code).toContain('grant execute on function public.canvas_comment_is_thread(uuid, uuid) to authenticated, service_role;')
  })
})
