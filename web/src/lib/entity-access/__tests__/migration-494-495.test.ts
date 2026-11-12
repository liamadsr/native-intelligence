/**
 * Migrations 494 (a view grant stays view-only for every write path) and 495
 * (the guard's quiet errors, the twins' grant arm for the caller only, the
 * contact write twin, a flat my_entity_grant_ids). Their behaviour was proven
 * on DEV inside rolled-back transactions, as real users: with a view grant a
 * member could comment on the private doc and capture, rewrite its owner's
 * comments, add and remove the capture's labels, delete its attachment rows,
 * rename and delete the company, edit the doc's proposed change, and (as an
 * admin) delete the doc, the capture and their comments; after 494 every one
 * of those is refused, every read stays, and the owner's own writes still go
 * through. These pin the shape that made it so.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GRANTABLE_TYPES } from '../model'
import { migrationsInOrder } from '@/test/migration-sql'

const read = (f: string) => readFileSync(join(process.cwd(), 'supabase/migrations', f), 'utf8')
const sql494 = read('494_entity_access_view_only_writes.sql')
const sql495 = read('495_entity_access_hardening.sql')
/** The newest migration that says `needle` (520 added tables to the kinds). */
const newestWith = (needle: string) => [...migrationsInOrder()].reverse().find((m) => m.sql.includes(needle))?.sql ?? ''

const fn = (text: string, name: string) =>
  new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n(\\$\\$|\\$function\\$);`).exec(text)?.[0] ?? ''
const policy = (text: string, name: string) => new RegExp(`create policy ${name} on [\\s\\S]*?;`).exec(text)?.[0] ?? ''

describe('migration 494: grants never open a write', () => {
  it('entity_grant_only knows every grantable kind, runs as its owner, and is null-safe', () => {
    const body = fn(newestWith('function public.entity_grant_only('), 'entity_grant_only')
    expect(body).toMatch(/security definer\s+set search_path = public, pg_temp/)
    for (const t of GRANTABLE_TYPES) expect(body, t).toContain(`when '${t}' then exists`)
    // A NULL own rule hid the row: it counts as not visible.
    expect(body.match(/and not coalesce\(/g)?.length).toBe(GRANTABLE_TYPES.length)
    expect(sql494).toContain('revoke all on function public.entity_grant_only(text, uuid) from public, anon;')
  })

  it('adds a RESTRICTIVE policy for each write a grant opened, and none for SELECT', () => {
    const expected: Array<[string, string, string, string]> = [
      ['document_delete_not_by_grant', 'public.document', 'delete', "not public.entity_grant_only('document', id)"],
      ['captures_delete_not_by_grant', 'public.captures', 'delete', "not public.entity_grant_only('capture', id)"],
      ['company_update_not_by_grant', 'public.company', 'update', "not public.entity_grant_only('company', id)"],
      ['company_delete_not_by_grant', 'public.company', 'delete', "not public.entity_grant_only('company', id)"],
      ['comment_insert_not_by_grant', 'public.comment', 'insert', 'not public.entity_grant_only(commentable_type::text, commentable_id)'],
      ['comment_update_not_by_grant', 'public.comment', 'update', 'not public.entity_grant_only(commentable_type::text, commentable_id)'],
      ['comment_delete_not_by_grant', 'public.comment', 'delete', 'not public.entity_grant_only(commentable_type::text, commentable_id)'],
      ['capture_label_insert_not_by_grant', 'public.capture_label', 'insert', "not public.entity_grant_only('capture', capture_id)"],
      ['capture_label_update_not_by_grant', 'public.capture_label', 'update', "not public.entity_grant_only('capture', capture_id)"],
      ['capture_label_delete_not_by_grant', 'public.capture_label', 'delete', "not public.entity_grant_only('capture', capture_id)"],
      ['attachments_delete_not_by_grant', 'public.attachments', 'delete', "not public.entity_grant_only('capture', note_id)"],
      ['proposed_change_update_not_by_grant', 'public.proposed_change', 'update', "not public.entity_grant_only('document', document_id)"],
    ]
    for (const [name, table, cmd, rule] of expected) {
      const p = policy(sql494, name)
      expect(p, name).toContain(`on ${table}`)
      expect(p, name).toContain(`as restrictive for ${cmd} to public`)
      expect(p, name).toContain(rule)
      expect(sql494, name).toContain(`drop policy if exists ${name} on ${table};`)
    }
    expect(sql494.match(/create policy /g)?.length).toBe(expected.length)
    expect(sql494).not.toMatch(/restrictive for (select|all)/)
    // The uploader keeps their own attachment.
    expect(policy(sql494, 'attachments_delete_not_by_grant')).toContain('user_id = auth.uid() or note_id is null')
  })
})

describe('migration 495: quiet guard, the twins, the flat pre-check', () => {
  it('the guard asks a signed-in caller the insert policy’s question first, with one answer', () => {
    const body = fn(sql495, 'entity_access_guard')
    const generic = body.indexOf("raise exception 'entity_access: not allowed' using errcode = '42501'")
    expect(generic).toBeGreaterThan(0)
    for (const msg of ['the member is not in this workspace', 'the team is not in this workspace', 'the channel is not in this workspace', 'the record is not in this workspace']) {
      expect(body.indexOf(msg), msg).toBeGreaterThan(generic)
    }
    expect(body).toMatch(/if auth\.uid\(\) is not null and not coalesce\(\s+public\.is_workspace_member\(new\.workspace_id\)\s+and public\.entity_access_can_share\(new\.entity_type, new\.entity_id, new\.workspace_id\)/)
    expect(body).toContain('public.team_chat_can_read(new.grantee_channel_id)')
    // The merge exemption only without a signed-in user.
    expect(body).toContain("if auth.uid() is null and coalesce(current_setting('dial8.workspace_merge', true), '') <> '' then")
  })

  it('the twins answer the grant arm only for the caller themself or the service role', () => {
    for (const name of ['contact_visible_to', 'company_visible_to']) {
      const body = fn(sql495, name)
      expect(body, name).toMatch(/IF \(auth\.uid\(\) IS NULL OR auth\.uid\(\) = p_user_id\)\s+AND public\.entity_grant_reaches\(/)
      expect(body.match(/entity_grant_reaches/g)?.length, name).toBe(1)
    }
  })

  it('the contact write twin is the pre-grant body: no grant arm at all', () => {
    const body = fn(sql495, 'contact_visible_to_ungranted')
    expect(body).toMatch(/security definer\s+set search_path = public, pg_temp/)
    expect(body).toContain('public.contact_share')
    expect(body).not.toMatch(/entity_grant|entity_access/)
    expect(sql495).toContain('revoke all on function public.contact_visible_to_ungranted(uuid, uuid) from public, anon;')
  })

  it('my_entity_grant_ids reads the caller’s channels once, never team_chat_can_read per grant', () => {
    const body = fn(sql495, 'my_entity_grant_ids')
    expect(body).toMatch(/security definer\s+set search_path = public, pg_temp/)
    expect(body).not.toContain('team_chat_can_read')
    expect(body).toContain('my_channels as (')
    expect(body).toContain("g.grantee_kind = 'channel' and g.grantee_channel_id in (select id from my_channels)")
    expect(body).toContain('where m.user_id = auth.uid()')
  })
})
