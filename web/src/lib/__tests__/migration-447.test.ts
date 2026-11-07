/**
 * Migration 447: a share row is written only for an item its writer can see.
 * 029's four share policies checked membership alone, so any member could
 * insert (or repoint) a link share at another member's private item, or one
 * in another workspace, and read every share's token. 447 rebuilds the four
 * on share_target_visible (223's rule for captures, 369's for documents),
 * pins a share's identity from clients and keeps a switched-off link off,
 * switches off a teammate's links when an item goes private, makes 088's
 * comment check count only links that open, and switches off existing links
 * that don't. No migration between 029 and 447 touched these policies, so
 * 029 is the base.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = join(process.cwd(), 'supabase/migrations')
const read = (name: string) => readFileSync(join(DIR, name), 'utf8')
const SQL = read('447_share_row_lockdown.sql')
const flat = (s: string) =>
  s
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
const BODY = flat(SQL)

/** One CREATE POLICY statement, up to its semicolon. */
const policy = (body: string, name: string) => {
  const start = body.indexOf(`create policy "${name}"`)
  expect(start).toBeGreaterThan(-1)
  return body.slice(start, body.indexOf(';', start) + 1)
}
/** One CREATE FUNCTION statement: through its closing dollar quote, to the semicolon after it. */
const fn = (body: string, qualified: string) => {
  const start = body.indexOf(`create or replace function ${qualified}(`)
  expect(start, qualified).toBeGreaterThan(-1)
  const close = body.indexOf('$$', body.indexOf('$$', start) + 2)
  return body.slice(start, body.indexOf(';', close) + 1)
}

const VISIBLE = 'public.share_target_visible(shareable_type, shareable_id, workspace_id)'
const MINE = 'created_by = public.current_member_id(workspace_id)'
const OPENS = 'private.share_link_opens(s.shareable_type, s.shareable_id, s.workspace_id, s.created_by)'

describe('migration 447', () => {
  it('has no backslash and is idempotent', () => {
    expect(SQL.includes('\\')).toBe(false)
    expect(BODY).not.toMatch(/create function /)
    expect(BODY).not.toMatch(/create trigger (?!share_identity_guard|share_follow_private_flip)/)
    for (const name of ['share_select', 'share_insert', 'share_update', 'share_delete']) {
      expect(BODY).toContain(`drop policy if exists "${name}" on public.share;`)
    }
    expect(BODY).toContain('drop trigger if exists share_identity_guard on public.share;')
    expect(BODY).toContain('drop trigger if exists share_follow_private_flip on public.document;')
    expect(BODY).toContain('drop trigger if exists share_follow_private_flip on public.captures;')
  })

  it('replaces exactly 029’s four policies, and nothing between 029 and 447 touched the table’s RLS', () => {
    const base = flat(read('029_sharing.sql'))
    expect(base).toContain('create policy "share_insert" on public.share for insert with check (public.is_workspace_member(workspace_id));')
    expect(base).toContain('create policy "share_update" on public.share for update using (public.is_workspace_member(workspace_id));')
    const between = readdirSync(DIR).filter((f) => f.endsWith('.sql') && f > '029_sharing.sql' && f < '447')
    expect(between.length).toBeGreaterThan(400)
    for (const f of between) {
      const body = flat(read(f))
      expect(body, f).not.toMatch(/policy [^;]* on (public\.)?"?share"?[\s;]/)
      expect(body, f).not.toMatch(/alter table (public\.)?"?share"? /)
    }
    // has_active_share_for_commentable: 088's body, only re-granted since (193).
    for (const f of between.filter((f) => f !== '088_external_commenters.sql')) {
      expect(flat(read(f)), f).not.toContain('create or replace function public.has_active_share_for_commentable(')
    }
  })

  it('states the write rule as 369 and 223 do, pinned to the share’s workspace', () => {
    const rule = fn(BODY, 'public.share_target_visible')
    expect(rule).toContain('select public.is_workspace_member(p_workspace_id) and case p_shareable_type')
    expect(rule).toContain(
      "where d.id = p_shareable_id and d.workspace_id = p_workspace_id and (d.visibility = 'workspace' or d.created_by = public.current_member_id(p_workspace_id))",
    )
    expect(rule).toContain(
      "where c.id = p_shareable_id and c.workspace_id = p_workspace_id and (c.visibility = 'workspace' or c.user_id = auth.uid())",
    )
    expect(rule).toContain('else false end;')
    expect(rule).toContain('security definer stable set search_path = public, pg_temp')
    expect(BODY).toContain('revoke execute on function public.share_target_visible(text, uuid, uuid) from public, anon;')

    // The rules it copies, as they stand in their own migrations.
    expect(flat(read('369_document_visibility.sql'))).toContain(
      "public.is_workspace_member(workspace_id) and (visibility = 'workspace' or created_by = public.current_member_id(workspace_id))",
    )
    expect(flat(read('223_capture_visibility.sql'))).toContain("(visibility = 'workspace' or user_id = auth.uid())")
  })

  it('opens a link as src/lib/share-target.ts does, and no member can call that rule', () => {
    const rule = fn(BODY, 'private.share_link_opens')
    expect(rule).toContain(
      "where d.id = p_shareable_id and d.workspace_id = p_workspace_id and (d.visibility = 'workspace' or d.created_by = p_created_by)",
    )
    expect(rule).toContain(
      "where c.id = p_shareable_id and c.workspace_id = p_workspace_id and ( c.visibility = 'workspace' or exists ( select 1 from public.member m where m.id = p_created_by and m.workspace_id = p_workspace_id and m.user_id = c.user_id ) )",
    )
    expect(rule).toContain('else false end;')
    expect(rule).toContain('security definer stable set search_path = public, pg_temp')
    expect(BODY).toContain('revoke execute on function private.share_link_opens(text, uuid, uuid, uuid) from public, anon, authenticated;')
  })

  it('lets a member see, change or delete only their own share or one on an item they can see', () => {
    for (const name of ['share_select', 'share_delete']) {
      expect(policy(BODY, name)).toContain(
        `to authenticated using ( public.is_workspace_member(workspace_id) and ( ${MINE} or ${VISIBLE} ) );`,
      )
    }
    expect(policy(BODY, 'share_update')).toContain(
      `to authenticated using ( public.is_workspace_member(workspace_id) and ( ${MINE} or ${VISIBLE} ) )`,
    )
  })

  it('creates a share only for a visible item, as the caller', () => {
    expect(policy(BODY, 'share_insert')).toBe(
      `create policy "share_insert" on public.share for insert to authenticated with check ( ${MINE} and ${VISIBLE} );`,
    )
  })

  it('keeps an updated share on a visible item unless it is being switched off', () => {
    expect(policy(BODY, 'share_update')).toContain(
      `with check ( public.is_workspace_member(workspace_id) and ( not is_active or ${VISIBLE} ) );`,
    )
  })

  it('pins a share’s item, owner, token and recipient, and keeps a switched-off link off, from clients only', () => {
    const guard = fn(BODY, 'public.share_identity_guard')
    expect(guard).toContain("if current_user in ('authenticated', 'anon') then")
    for (const col of ['workspace_id', 'shareable_type', 'shareable_id', 'share_type', 'share_token', 'created_by', 'shared_with_email', 'shared_with_user_id']) {
      expect(guard).toContain(`new.${col}`)
      expect(guard).toContain(`old.${col}`)
    }
    // The fields PATCH /api/account/shares/[id] may change stay free, except
    // that is_active only goes one way.
    for (const col of ['access_level', 'expires_at', 'show_transcript', 'show_ai_summary', 'show_decisions']) {
      expect(guard).not.toContain(`new.${col}`)
    }
    expect(guard).toContain('if new.is_active and not old.is_active then')
    expect(guard.match(/using errcode = '42501'/g)).toHaveLength(2)
    expect(BODY).toContain('revoke execute on function public.share_identity_guard() from public, anon, authenticated;')
    expect(BODY).toContain('before update on public.share for each row execute function public.share_identity_guard();')
  })

  it('switches off a teammate’s links when an item goes private, and on nothing else', () => {
    const flip = fn(BODY, 'private.share_follow_private_flip')
    expect(flip).toContain('security definer')
    expect(flip).toContain(
      `update public.share s set is_active = false where s.shareable_type = case tg_table_name when 'captures' then 'capture' else 'document' end and s.shareable_id = new.id and s.is_active and not ${OPENS};`,
    )
    for (const table of ['document', 'captures']) {
      expect(BODY).toContain(
        `create trigger share_follow_private_flip after update of visibility on public.${table} for each row when (new.visibility = 'private' and old.visibility is distinct from 'private') execute function private.share_follow_private_flip();`,
      )
    }
  })

  it('lets an outsider comment only through a link that opens (088’s body plus the rule)', () => {
    const fn088 = fn(flat(read('088_external_commenters.sql')), 'public.has_active_share_for_commentable')
    const fn447 = fn(BODY, 'public.has_active_share_for_commentable')
    expect(fn447).toBe(
      fn088
        .replace(' );', ` and ${OPENS} );`)
        .replace('language sql security definer stable;', 'language sql security definer stable set search_path = public, pg_temp;'),
    )
    // CREATE OR REPLACE keeps 193's grant to authenticated: no revoke here.
    expect(BODY).not.toContain('revoke execute on function public.has_active_share_for_commentable')
  })

  it('switches existing links that don’t open off in place, and deletes nothing', () => {
    expect(BODY).not.toMatch(/delete from/)
    expect(BODY).toMatch(new RegExp(`update public\\.share s set is_active = false where s\\.is_active and not ${OPENS.replace(/[().]/g, '\\$&')};$`))
    // The only other update is the flip trigger's, on share too.
    expect(BODY.match(/update public\.\w+/g)).toEqual(['update public.share', 'update public.share'])
  })
})
