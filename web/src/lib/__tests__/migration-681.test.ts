import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// 681: a comment is its author's to change; anyone who can see it resolves it.
// The "resolve" UPDATE policies (088, 674, 679) check only that the caller can
// see the record, and a policy cannot name columns, so before 681 any member
// could rewrite, re-sign or move anyone's comment. supabase/tests/681_comment_guard.sql
// runs the SQL; this pins the file's text.
const ROOT = process.cwd()
const MIGRATIONS = join(ROOT, 'supabase/migrations')
const FILE = '681_comment_author_guard.sql'
const raw = readFileSync(join(MIGRATIONS, FILE), 'utf8')
const sql = raw.replace(/--[^\n]*/g, '')

/** The body of one `create or replace function`, between its `as $$` and `$$;`. */
function fn(name: string): { head: string; body: string } {
  const start = sql.search(new RegExp(`create or replace function public\\.${name}\\(`, 'i'))
  expect(start, `${FILE} defines ${name}`).toBeGreaterThanOrEqual(0)
  const open = sql.indexOf('as $$', start)
  const close = sql.indexOf('$$;', open + 5)
  return { head: sql.slice(start, open), body: sql.slice(open + 5, close) }
}

function commentableTypes(): string[] {
  const source = readFileSync(join(ROOT, 'src/lib/comments.ts'), 'utf8')
  const line = source.match(/export type CommentableType = ([^\n]+)/)?.[1] ?? ''
  return [...line.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
}

describe('migration 681: comment author guard', () => {
  it('carries its own transaction, once', () => {
    expect(sql.match(/^\s*begin\s*;/gim)).toHaveLength(1)
    expect(sql.match(/^\s*commit\s*;/gim)).toHaveLength(1)
    expect(sql.trim().endsWith('commit;')).toBe(true)
  })

  it('has no backslash anywhere (one MCP transport decodes escapes)', () => {
    expect(raw).not.toContain('\\')
  })

  it('every function body opens with `as $$` and closes with `$$;`, and no other dollar sign is in the file', () => {
    const fns = [...sql.matchAll(/create or replace function/gi)].length
    expect(fns).toBe(2)
    const bodies = [...sql.matchAll(/\bas \$\$\n[\s\S]*?\n\$\$;/g)]
    expect(bodies).toHaveLength(fns)
    // Two `$$` per function and nothing else: a single `$` slipped in would show here.
    expect((raw.match(/\$/g) ?? []).length).toBe(4 * fns)
    expect(raw.match(/\$\$/g)).toHaveLength(2 * fns)
  })

  it('is re-runnable: the trigger is dropped before it is made, the functions are replaced', () => {
    expect(sql).toMatch(/drop trigger if exists comment_author_guard on public\.comment;\s*create trigger comment_author_guard/i)
    expect(sql).not.toMatch(/create function/i)
    expect(sql).toMatch(/before update on public\.comment\s+for each row execute function public\.comment_author_guard\(\)/i)
  })

  it('adds a trigger beside the others: no policy, and 512’s guard is not redefined', () => {
    expect(sql).not.toMatch(/\b(create|drop|alter)\s+policy\b/i)
    expect(sql).not.toMatch(/entity_edit_grant_comment_guard/i)
    expect(sql).not.toMatch(/validate_commentable_exists|set_comment_edited_at/i)
  })

  it('the guard runs as the caller and lets server code through', () => {
    const { head, body } = fn('comment_author_guard')
    expect(head).not.toMatch(/security definer/i)
    expect(head).toMatch(/set search_path = public, pg_temp/i)
    expect(body).toMatch(/if current_user not in \('authenticated', 'anon'\) then\s+return new;/i)
  })

  it('the record, thread, author and time never change for a client, the author included', () => {
    const { body } = fn('comment_author_guard')
    for (const col of ['commentable_type', 'commentable_id', 'parent_id', 'author_id', 'author_user_id', 'created_at']) {
      expect(body, col).toMatch(new RegExp(`new\\.${col} is distinct from old\\.${col}`, 'i'))
    }
    const fixed = body.slice(0, body.indexOf('comment_written_by_me'))
    expect(fixed).toMatch(/errcode = '42501'/)
  })

  it('everything but is_resolved is the author’s alone (words, mentions, names, anchors, columns added later)', () => {
    const { body } = fn('comment_author_guard')
    expect(body).toMatch(
      /\(to_jsonb\(new\) - 'is_resolved'\) is distinct from \(to_jsonb\(old\) - 'is_resolved'\)\s+and not public\.comment_written_by_me\(old\.author_id, old\.author_user_id, old\.commentable_type::text, old\.commentable_id\)/i,
    )
    // Nothing else is let through: no column but is_resolved is subtracted.
    expect([...body.matchAll(/to_jsonb\([a-z]+\) - '([a-z_]+)'/gi)].map((m) => m[1])).toEqual(['is_resolved', 'is_resolved'])
  })

  it('the author is the caller’s own member in the record’s workspace, or the outside commenter themself', () => {
    const { head, body } = fn('comment_written_by_me')
    expect(head).toMatch(/security definer/i)
    expect(head).toMatch(/set search_path = public, pg_temp/i)
    expect(body).toMatch(/return p_author_user_id = auth\.uid\(\);/i)
    expect(body).toMatch(/m\.id = p_author_id\s+and m\.user_id = auth\.uid\(\)\s+and m\.workspace_id = v_ws/i)
    // A kind it does not know has no author (fails closed).
    expect(body).toMatch(/else null\s+end;/i)
    expect(body).toMatch(/if v_ws is null then\s+return false;/i)
  })

  it('knows the workspace of every kind the app comments on', () => {
    const { body } = fn('comment_written_by_me')
    const kinds = [...body.matchAll(/when '([a-z_]+)' then/g)].map((m) => m[1]).sort()
    expect(kinds).toEqual(commentableTypes())
    expect(kinds).toEqual(['action', 'capture', 'company', 'contact', 'document', 'project'])
  })

  it('the trigger function is not callable by clients; the helper is', () => {
    expect(sql).toMatch(/revoke all on function public\.comment_author_guard\(\) from public, anon, authenticated;/i)
    expect(sql).toMatch(/grant execute on function public\.comment_written_by_me\(uuid, uuid, text, uuid\) to authenticated, anon/i)
  })

  it('stands over every UPDATE policy on public.comment the migrations make (none reviewed for 681 is missing)', () => {
    const names = new Set<string>()
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql'))) {
      const text = readFileSync(join(MIGRATIONS, f), 'utf8').replace(/--[^\n]*/g, '')
      for (const m of text.matchAll(/create\s+policy\s+"?([^"\s]+(?:\s[^"\s]+)*?)"?\s+on\s+public\.comment\b([^;]*)/gi)) {
        if (/for\s+update/i.test(m[2])) names.add(m[1])
      }
    }
    expect([...names].sort()).toEqual([
      'Authors can update own comments',
      'Members can resolve comments on their entities',
      'comment_company_resolve',
      'comment_project_contact_resolve',
      'comment_update_not_by_grant',
    ])
  })

  it('has a SQL test that rehearses it', () => {
    const test = join(ROOT, 'supabase/tests/681_comment_guard.sql')
    expect(existsSync(test)).toBe(true)
    const text = readFileSync(test, 'utf8')
    expect(text).toMatch(/^rollback;\s*$/m)
    expect(text).toContain("681 comment_guard: all checks passed")
    expect(text).toMatch(/example\.test/)
  })
})
