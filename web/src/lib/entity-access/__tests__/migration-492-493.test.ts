/**
 * Migrations 492 (the grant store) and 493 (grants wired into the read
 * policies): what they must keep true, read off their text. Their behaviour
 * was proven on DEV inside rolled-back transactions, as real users (a member
 * can't see another's private doc, capture, contact or company; a member,
 * team or channel grant opens it and revoking closes it; the member can't
 * grant themselves; a grant from another workspace, even one forged with
 * triggers off, opens nothing; every member's row counts on 14 tables are
 * unchanged with no grants). These hold the shape that made it so, and pin
 * the TypeScript mirror (../model.ts, ../grants.ts) to the SQL.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GRANTABLE_TYPES, GRANTEE_KINDS, GRANT_SOURCES } from '../model'

const read = (f: string) => readFileSync(join(process.cwd(), 'supabase/migrations', f), 'utf8')
const sql492 = read('492_entity_access.sql')
const sql493 = read('493_entity_access_read_policies.sql')

const fn = (text: string, name: string) =>
  new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`).exec(text)?.[0] ?? ''
const listIn = (text: string, constraint: string) => {
  const body = new RegExp(`constraint ${constraint} check \\(\\w+ in \\(([^)]*)\\)\\)`).exec(text)?.[1] ?? ''
  return body.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
}

describe('migration 492: one grant store', () => {
  it('takes exactly the kinds, sources and grantees the app knows', () => {
    expect(listIn(sql492, 'entity_access_entity_type')).toEqual([...GRANTABLE_TYPES])
    expect(listIn(sql492, 'entity_access_source')).toEqual([...GRANT_SOURCES])
    expect(listIn(sql492, 'entity_access_level')).toEqual(['view', 'edit'])
    for (const kind of GRANTEE_KINDS) expect(sql492).toContain(`(grantee_kind = '${kind}' and grantee_${kind}_id is not null`)
    expect(sql492).toMatch(/constraint entity_access_unique unique \(workspace_id, entity_type, entity_id, grantee_kind, grantee_id\)/)
    // The trigger and can-share know the same kinds.
    for (const t of GRANTABLE_TYPES) {
      expect(fn(sql492, 'entity_access_guard'), t).toContain(`when '${t}' then exists`)
      expect(fn(sql492, 'entity_access_can_share'), t).toContain(`when '${t}' then exists`)
    }
  })

  it('runs every helper as its owner with a pinned search_path, and keeps the explicit-user twin from signed-in callers', () => {
    for (const name of ['entity_access_guard', 'has_entity_grant', 'my_entity_grant_ids', 'entity_grant_reaches', 'entity_access_can_share']) {
      expect(fn(sql492, name), name).toMatch(/security definer\s+set search_path = public, pg_temp/)
    }
    expect(sql492).toContain('revoke all on function public.entity_grant_reaches(text, uuid, uuid, uuid) from public, anon, authenticated;')
    expect(sql492).toContain('grant execute on function public.entity_grant_reaches(text, uuid, uuid, uuid) to service_role;')
    expect(sql492).not.toMatch(/grant execute on function public\.entity_grant_reaches[^;]*authenticated/)
    expect(sql492).toContain('revoke all on table public.entity_access from anon, authenticated;')
    expect(sql492).toContain('grant select, insert, delete on table public.entity_access to authenticated;')
  })

  it('has_entity_grant resolves the three grantees inside the record’s own workspace', () => {
    const body = fn(sql492, 'has_entity_grant')
    expect(body).toMatch(/where g\.workspace_id = p_workspace\s+and g\.entity_type = p_type\s+and g\.entity_id = p_id/)
    expect(body).toMatch(/g\.grantee_kind = 'member'\s+and g\.grantee_member_id = public\.current_member_id\(p_workspace\)/)
    expect(body).toMatch(/t\.id = g\.grantee_team_id and t\.workspace_id = p_workspace\)\s+and public\.is_team_member\(g\.grantee_team_id\)/)
    expect(body).toMatch(/c\.id = g\.grantee_channel_id and c\.workspace_id = p_workspace\)\s+and public\.team_chat_can_read\(g\.grantee_channel_id\)/)
    // The explicit-user twin: the same three, for p_user, in p_workspace.
    const twin = fn(sql492, 'entity_grant_reaches')
    expect(twin).toMatch(/me\.user_id = p_user\s+and me\.workspace_id = p_workspace/)
    expect(twin).toContain("(g.grantee_kind = 'member' and g.grantee_member_id = me.id)")
    expect(twin).toMatch(/t\.workspace_id = p_workspace and tm\.member_id = me\.id/)
    expect(twin).toMatch(/c\.kind = 'channel' and \(c\.team_id is null or exists/)
    expect(twin).toMatch(/c\.kind = 'dm' and exists/)
  })

  it('lets only someone who may share the record add a grant: as themselves, view only', () => {
    const insert = /create policy entity_access_insert[\s\S]*?\);\n/.exec(sql492)?.[0] ?? ''
    expect(insert).toContain('granted_by = public.current_member_id(workspace_id)')
    expect(insert).toContain("level = 'view'")
    expect(insert).toContain('public.entity_access_can_share(entity_type, entity_id, workspace_id)')
    expect(insert).toContain("grantee_kind <> 'channel' or public.team_chat_can_read(grantee_channel_id)")
    expect(insert).toMatch(/not t\.is_private or public\.is_team_member\(t\.id\)/)
    const del = /create policy entity_access_delete[\s\S]*?\);\n/.exec(sql492)?.[0] ?? ''
    expect(del).toContain('public.entity_access_can_share(entity_type, entity_id, workspace_id)')
    expect(del).toContain('granted_by = public.current_member_id(workspace_id)')
    expect(sql492).not.toMatch(/create policy \w+ on public\.entity_access\s+for update/)
  })

  it('can-share follows each kind’s existing rule', () => {
    const body = fn(sql492, 'entity_access_can_share')
    expect(body).toMatch(/d\.created_by = public\.current_member_id\(p_workspace\)/)
    expect(body).toMatch(/c\.user_id = auth\.uid\(\)\s+and not c\.is_eval/)
    expect(body).toMatch(/ct\.created_by_member_id = public\.current_member_id\(p_workspace\)\)\s+or public\.get_member_role\(p_workspace\) in \('owner', 'admin'\)/)
    expect(body).toMatch(/when 'company' then exists[\s\S]*?get_member_role\(p_workspace\) in \('owner', 'admin'\)/)
  })

  it('stands aside for a workspace merge and never re-checks on granted_by', () => {
    const guard = fn(sql492, 'entity_access_guard')
    expect(guard).toContain("coalesce(current_setting('dial8.workspace_merge', true), '') <> ''")
    // A signed-in outsider is refused before any lookup that could say what exists.
    const outsider = guard.indexOf('auth.uid() is not null and not public.is_workspace_member(new.workspace_id)')
    expect(outsider).toBeGreaterThan(0)
    expect(outsider).toBeLessThan(guard.indexOf("new.grantee_kind = 'member' and not exists"))
    const trigger = /create trigger entity_access_guard[\s\S]*?execute function public\.entity_access_guard\(\);/.exec(sql492)?.[0] ?? ''
    expect(trigger).toMatch(/before insert or update of workspace_id, entity_type, entity_id, grantee_kind, grantee_member_id, grantee_team_id, grantee_channel_id/)
    expect(trigger).not.toContain('granted_by')
  })
})

/** Every policy 493 re-creates, with the kind its grant arm is about and how many arms it has. */
const POLICIES: Array<{ table: string; name: string; arms: Record<string, number> }> = [
  { table: 'document', name: 'document_select', arms: { document: 1 } },
  { table: 'captures', name: 'captures_select', arms: { capture: 1 } },
  { table: 'contact', name: 'contact_select_visibility', arms: { contact: 1 } },
  { table: 'company', name: 'company_select_with_visible_contacts', arms: { contact: 1, company: 1 } },
  { table: 'document_revision', name: 'document_revision_select', arms: { document: 1 } },
  { table: 'document_chunks', name: 'document_chunks_select', arms: { document: 1 } },
  { table: 'capture_chunks', name: 'capture_chunks_select', arms: { capture: 1 } },
  { table: 'capture_participant', name: '"Workspace members can view capture participants"', arms: { capture: 1 } },
  { table: 'decision', name: '"Workspace members can view decisions"', arms: { capture: 1 } },
  { table: 'attachments', name: 'attachments_workspace_select', arms: { capture: 1 } },
  { table: 'comment', name: '"View comments: members + own external"', arms: { capture: 1, document: 1 } },
  { table: 'contact_interaction', name: 'interaction_select_via_contact', arms: { contact: 1 } },
]

const policyBlock = (name: string, table: string) =>
  new RegExp(`create policy ${name.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&')} on public\\.${table}[\\s\\S]*?\\n  \\);`).exec(sql493)?.[0] ?? ''

describe('migration 493: grants open the existing read rules, and only those', () => {
  it('re-creates exactly the listed SELECT policies, each dropped first', () => {
    const created = [...sql493.matchAll(/create policy ("[^"]+"|\w+) on public\.(\w+)/g)].map((m) => `${m[2]}.${m[1]}`)
    expect(created.sort()).toEqual(POLICIES.map((p) => `${p.table}.${p.name}`).sort())
    for (const p of POLICIES) {
      expect(sql493, p.name).toContain(`drop policy if exists ${p.name} on public.${p.table};`)
      expect(policyBlock(p.name, p.table), p.name).toMatch(/\n  for select to public\n/)
    }
    // Nothing that writes: no insert/update/delete/all policy, no table or grant change.
    expect(sql493).not.toMatch(/for (insert|update|delete|all)\b/)
    expect(sql493).not.toMatch(/^\s*(alter table|grant|revoke)\b/im)
  })

  it('adds the grant arm as the last OR, with the array pre-check, for the right kind', () => {
    for (const p of POLICIES) {
      const block = policyBlock(p.name, p.table)
      for (const [kind, n] of Object.entries(p.arms)) {
        const arms = block.match(new RegExp(`or \\((\\w+\\.)?id = any \\(\\(select public\\.my_entity_grant_ids\\('${kind}'\\)\\)::uuid\\[\\]\\) and public\\.has_entity_grant\\('${kind}', (\\w+\\.)?id, (\\w+\\.)?workspace_id\\)\\)`, 'g')) ?? []
        expect(arms.length, `${p.name} ${kind}`).toBe(n)
      }
      // Every has_entity_grant in the block is one of those arms.
      const total = Object.values(p.arms).reduce((a, b) => a + b, 0)
      expect((block.match(/public\.has_entity_grant\(/g) ?? []).length, p.name).toBe(total)
    }
  })

  it('keeps every existing arm of the parents', () => {
    expect(policyBlock('document_select', 'document')).toMatch(/is_workspace_member\(workspace_id\)\s+and \(\s+\(visibility = 'workspace'::text\)\s+or \(created_by = current_member_id\(workspace_id\)\)/)
    expect(policyBlock('captures_select', 'captures')).toMatch(/is_workspace_member\(workspace_id\)\s+and \(\s+\(visibility = 'workspace'::text\)\s+or \(user_id = auth\.uid\(\)\)/)
    expect(policyBlock('contact_select_visibility', 'contact')).toMatch(/using \(\s+can_view_contact\(id, workspace_id, visibility, created_by_member_id\)\s+or \(id = any/)
    const company = policyBlock('company_select_with_visible_contacts', 'company')
    expect(company).toContain("(get_member_role(workspace_id) = any (array['owner'::text, 'admin'::text]))")
    expect(company).toContain('can_view_contact(ct.id, ct.workspace_id, ct.visibility, ct.created_by_member_id)')
    expect(policyBlock('"Workspace members can view decisions"', 'decision')).toContain("(decision.confirmation = 'confirmed'::text)")
    expect(policyBlock('"View comments: members + own external"', 'comment')).toContain("when 'action'::commentable_type then (exists (")
  })

  it('gives each service-role twin the grant check before its last answer', () => {
    const contact = /create or replace function public\.contact_visible_to[\s\S]*?\$function\$;/.exec(sql493)?.[0] ?? ''
    expect(contact).toMatch(/entity_grant_reaches\('contact', p_contact_id, v_c\.workspace_id, p_user_id\) THEN RETURN TRUE; END IF;\s+RETURN FALSE;/)
    expect(contact).toContain("IF p_user_id IS NULL THEN RETURN v_c.visibility = 'workspace'; END IF;")
    const company = /create or replace function public\.company_visible_to[\s\S]*?\$function\$;/.exec(sql493)?.[0] ?? ''
    expect(company).toContain("entity_grant_reaches('company', p_company_id, v_workspace_id, p_user_id)")
    expect(company).toContain('AND public.contact_visible_to(ct.id, p_user_id)')
    for (const body of [contact, company]) expect(body).toMatch(/security definer\s+set search_path = public, pg_temp/)
  })

  it('has no backslashes (one MCP transport decodes escapes)', () => {
    expect(sql492).not.toContain('\\')
    expect(sql493).not.toContain('\\')
  })
})
