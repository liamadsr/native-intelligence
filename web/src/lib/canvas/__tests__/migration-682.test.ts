/**
 * Migration 682: comments on a canvas, and the private presence room. It can't
 * be run here, so the file is pinned as text (it was rehearsed on a real
 * Postgres, applied twice, with three people: docs/plans/canvas.md). The key
 * properties:
 *   - additive: no existing function or policy is redefined;
 *   - a presence topic gives up its canvas only when it is exactly
 *     `canvas-presence:<uuid>`, compared as text before any cast;
 *   - hearing and saying in the room are both "may open the canvas", for
 *     broadcast only, for signed-in people only;
 *   - a comment is written as oneself, on a canvas one can open, and a guard
 *     keeps its words to its author.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { presenceTopic } from '@/components/canvas/live'

const file = 'supabase/migrations/682_canvas_comments_presence.sql'
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

describe('migration 682: additive, in the house style', () => {
  it('is one transaction with a lock timeout and a schema reload, and has no backslash', () => {
    expect(code).toMatch(/^\s*begin;/)
    expect(code).toContain("SET LOCAL lock_timeout = '5s';")
    expect(code).toMatch(/commit;\s*notify pgrst, 'reload schema';\s*$/)
    expect(sql).not.toContain('\\')
  })

  it('opens every function body with `as $$` and closes it with `$$;`', () => {
    const fns = [...code.matchAll(/create or replace function (public\.[a-z_]+)\(/g)].map((m) => m[1])
    expect(fns.sort()).toEqual(['public.canvas_comment_guard', 'public.canvas_comment_is_thread', 'public.canvas_presence_canvas'])
    for (const fn of fns) expect(body(fn)).toMatch(/\nas \$\$\n[\s\S]+\n\$\$;$/)
    // Two dollar-quote marks per function, and one anonymous block: nothing left open.
    expect(code.match(/\$\$/g)?.length).toBe(fns.length * 2 + 2)
  })

  it('defines only its own functions and policies, each dropped before it is made', () => {
    const made = [...code.matchAll(/create policy "?([a-z_]+)"? on ([a-z_.]+)/g)].map((m) => `${m[1]} on ${m[2]}`)
    expect(made.sort()).toEqual([
      'canvas_comment_delete on public.canvas_comment',
      'canvas_comment_insert on public.canvas_comment',
      'canvas_comment_select on public.canvas_comment',
      'canvas_comment_update on public.canvas_comment',
      'canvas_presence_hear on realtime.messages',
      'canvas_presence_say on realtime.messages',
    ])
    const dropped = [...code.matchAll(/drop policy if exists "?([a-z_]+)"? on ([a-z_.]+)/g)].map((m) => `${m[1]} on ${m[2]}`)
    expect(dropped.sort()).toEqual(made.sort())
    // 676's functions are called, never redefined.
    for (const fn of ['canvas_visible_to', 'canvas_editable_by', 'my_canvas_ids', 'current_member_id', 'update_updated_at']) {
      expect(code).not.toContain(`create or replace function public.${fn}(`)
      expect(code).not.toContain(`create function public.${fn}(`)
    }
    expect(code).not.toMatch(/alter policy|drop function|drop table/)
  })
})

describe('migration 682: the presence room is private', () => {
  const parser = body('public.canvas_presence_canvas')
  const pattern = parser.match(/topic ~ '([^']+)'/)?.[1]

  it('reads a canvas out of a topic only when the whole topic is canvas-presence:<uuid>', () => {
    expect(pattern).toBe('^canvas-presence:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    const re = new RegExp(pattern as string)
    const id = '3f2b8c1e-5a4d-4e6f-9a7b-0c1d2e3f4a5b'
    expect(re.test(`canvas-presence:${id}`)).toBe(true)
    for (const bad of [
      'canvas-presence:',
      'canvas-presence:not-a-uuid',
      `canvas-presence:${id}x`,
      `canvas-presence:${id}' or true --`,
      `canvas-presence:${id}:extra`,
      `xcanvas-presence:${id}`,
      `canvas-presence:${id.toUpperCase()}`,
      `canvas-presence:${id}\n`,
      `team-chat-typing:${id}`,
      id,
    ]) {
      // Postgres's `$` does not match before a trailing newline; JavaScript's does not either.
      expect(re.test(bad), bad).toBe(false)
    }
    // The cast happens only inside the branch the text test has passed.
    expect(parser).toMatch(/select case\s+when topic ~ '[^']+'\s+then split_part\(topic, ':', 2\)::uuid\s+end;/)
    expect(parser).toContain('immutable')
  })

  it('is the topic the editor joins, upper-case ids included', () => {
    const re = new RegExp(pattern as string)
    expect(presenceTopic('3f2b8c1e-5a4d-4e6f-9a7b-0c1d2e3f4a5b')).toBe('canvas-presence:3f2b8c1e-5a4d-4e6f-9a7b-0c1d2e3f4a5b')
    expect(re.test(presenceTopic('3F2B8C1E-5A4D-4E6F-9A7B-0C1D2E3F4A5B'))).toBe(true)
  })

  const RULE =
    "realtime.topic() like 'canvas-presence:%'\n" +
    "    and realtime.messages.extension = 'broadcast'\n" +
    '    and public.canvas_visible_to(public.canvas_presence_canvas(realtime.topic()), (select auth.uid()))'

  it('lets only whoever may open the canvas hear, and only by broadcast', () => {
    const hear = statement('create policy "canvas_presence_hear" on realtime.messages')
    expect(hear).toContain('for select to authenticated')
    expect(hear).toContain(`using (\n    ${RULE}\n  );`)
  })

  it('lets only whoever may open the canvas say, by the same rule', () => {
    const say = statement('create policy "canvas_presence_say" on realtime.messages')
    expect(say).toContain('for insert to authenticated')
    expect(say).toContain(`with check (\n    ${RULE}\n  );`)
  })

  it('gives nobody but signed-in people the topic parser, and no policy to anon', () => {
    expect(code).toContain('revoke all on function public.canvas_presence_canvas(text) from public, anon;')
    expect(code).toContain('grant execute on function public.canvas_presence_canvas(text) to authenticated;')
    expect(code).not.toMatch(/to anon\b(?!,)/)
    expect(code).not.toMatch(/for (select|insert|update|delete|all) to (public|anon)/)
  })
})

describe('migration 682: comments', () => {
  it('reads comments with the canvas', () => {
    expect(statement('create policy canvas_comment_select')).toContain('using (canvas_id = any ((select public.my_canvas_ids())::uuid[]));')
  })

  it('writes a comment as oneself, on a canvas one can open, in its workspace, a reply on its own thread', () => {
    const insert = statement('create policy canvas_comment_insert')
    expect(insert).toContain('author_id is not null')
    expect(insert).toContain('author_id = public.current_member_id(workspace_id)')
    expect(insert).toContain('public.canvas_visible_to(canvas_id, (select auth.uid()))')
    expect(insert).toContain('c.workspace_id = canvas_comment.workspace_id')
    expect(insert).toContain('or public.canvas_comment_is_thread(parent_id, canvas_id)')
    // No policy on the table reads the table itself (that recurses: 42P17).
    for (const p of ['select', 'insert', 'update', 'delete']) {
      expect(statement(`create policy canvas_comment_${p}`)).not.toContain('from public.canvas_comment')
    }
    const thread = body('public.canvas_comment_is_thread')
    expect(thread).toContain('security definer')
    expect(thread).toContain('set search_path = public, pg_temp')
    expect(thread).toContain('p.parent_id is null')
    // It runs as its owner, so it checks the caller's own access to the canvas.
    expect(thread).toContain('and ((select auth.uid()) is null or public.canvas_visible_to(p_canvas, (select auth.uid())))')
    expect(code).toContain('revoke all on function public.canvas_comment_is_thread(uuid, uuid) from public, anon;')
  })

  it('lets a reader update (to resolve) and only the author delete', () => {
    const update = statement('create policy canvas_comment_update')
    expect(update).toContain('using (canvas_id = any ((select public.my_canvas_ids())::uuid[]))')
    expect(update).toContain('with check (public.canvas_visible_to(canvas_id, (select auth.uid())))')
    expect(statement('create policy canvas_comment_delete')).toContain('author_id = public.current_member_id(workspace_id)')
  })

  it('guards what an update may change: place never, words by the author, a resolver as oneself', () => {
    const guard = body('public.canvas_comment_guard')
    expect(guard).toContain("if current_user not in ('authenticated', 'anon') then\n    return new;")
    for (const col of ['id', 'canvas_id', 'workspace_id', 'author_id', 'parent_id', 'item_id', 'created_at']) {
      expect(guard, col).toContain(`new.${col} is distinct from old.${col}`)
    }
    expect(guard).toContain('(new.body is distinct from old.body or new.mentions is distinct from old.mentions)\n     and (v_me is null or old.author_id is distinct from v_me)')
    expect(guard).toContain('new.resolved_by is not null\n     and (v_me is null or new.resolved_by is distinct from v_me)')
    expect(guard.match(/errcode = '42501'/g)?.length).toBe(3)
    expect(code).toContain('create trigger canvas_comment_guard\n  before update on public.canvas_comment')
  })

  it('keeps the table to signed-in people and publishes it for live updates', () => {
    expect(code).toContain('alter table public.canvas_comment enable row level security;')
    expect(code).toContain('revoke all on table public.canvas_comment from anon, authenticated;')
    expect(code).toContain('grant select, insert, update, delete on table public.canvas_comment to authenticated;')
    expect(code).toContain('alter publication supabase_realtime add table public.canvas_comment;')
    expect(code).toContain('references public.canvas(id) on delete cascade')
  })
})
