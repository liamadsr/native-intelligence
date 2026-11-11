/**
 * Migrations 512 (a grant can be view or edit) and 513 (a share is an
 * activity row, for the Inbox).
 *
 * 512's behaviour was proven on DEV inside a rolled-back transaction, as real
 * users, before and after the file, on a private document, a private capture,
 * a private contact and a company with no contacts, each shared by its owner
 * (Ana) to Ben (view), Cai (edit), Dee (an admin, edit) and Gus (a guest,
 * edit); Nia has no grant. Every write path, rows changed (or the error):
 *
 *                                      Ben view   Cai edit   Dee admin+edit   Gus guest   Nia    Ana owner
 *   document title                     0          1          1                0           0      1
 *   document visibility / creator /    0          42501      42501            0           0      1
 *     archive (status)
 *   document delete                    0          0          0                0           0      1
 *   comment add (doc)                  42501      1          1                42501       42501  1
 *   comment resolve the owner's        0          1          1                0           0      1
 *   comment delete the owner's         0          0          0                0           0      1
 *   capture title                      0          1          1                0           0      1
 *   capture visibility / archive       0          42501      42501            0           0      1
 *   capture delete                     0          0          0                0           0      1
 *   capture label add                  42501      1          1                42501       42501  1
 *   capture decision add               42501      1          1                42501       42501  1
 *   contact name                       0          1          1 (admin rule)   0           0      1
 *   contact visibility                 0          42501      1 (admin rule)   0           0      1
 *   contact delete                     0          0          1 (admin rule)   0           0      1
 *   company name                       0          1          1 (admin rule)   0           0      1
 *   company is_workspace_company       0          42501      1 (admin rule)   0           0      1
 *   company delete                     0          0          1 (admin rule)   0           0      1
 *   rewrite the owner's comment body   0          42501      42501            0           0      1
 *   doc / capture team or pin          0          42501      42501            0           0      1
 *   contact company / company domain   0          42501      1 (admin rule)   0           0      1
 *   re-share the doc (a new grant)     42501      42501      42501            42501       42501  1
 *   raise their own grant to edit      0          0          0                0           0      -
 *   own edit rule + entity_edit_       false      true       true             false       false  true
 *     granted (service role)
 * Before 512 every Cai/Dee cell on a private record was 0 or 42501 (view-only,
 * 494); Ana's, Ben's, Gus's and Nia's cells were the same before and after.
 * These pin the shape that made it so.
 */
import { describe, expect, it } from 'vitest'
import { GRANTABLE_TYPES } from '../model'
import { migrationsInOrder } from '@/test/migration-sql'

const all = migrationsInOrder()
const sql512 = all.find((m) => m.file.startsWith('512_'))!.sql
const sql513 = all.find((m) => m.file.startsWith('513_'))!.sql

const fn = (text: string, name: string) =>
  new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n(\\$\\$|\\$function\\$);`).exec(text)?.[0] ?? ''
const policy = (text: string, name: string) =>
  new RegExp(`create policy ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} on [\\s\\S]*?;\\n`).exec(text)?.[0] ?? ''

describe('migration 512: the helpers', () => {
  it('each runs as its owner with a pinned search path, and none is open to anon', () => {
    for (const name of ['has_entity_edit_grant', 'my_entity_edit_grant_ids', 'entity_edit_grant_on', 'entity_view_grant_only', 'entity_edit_grant_only', 'entity_edit_grant_reaches']) {
      expect(fn(sql512, name), name).toMatch(/security definer\s+set search_path = public, pg_temp/)
      expect(sql512, name).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon`))
    }
    // The explicit-user form is the service role's (and a signed-in caller about themself).
    expect(sql512).toContain('grant execute on function public.entity_edit_grant_reaches(text, uuid, uuid, uuid) to service_role;')
    expect(fn(sql512, 'entity_edit_grant_reaches')).toContain('and (auth.uid() is null or auth.uid() = p_user)')
  })

  it('an edit grant is level edit, and never a guest’s', () => {
    const has = fn(sql512, 'has_entity_edit_grant')
    expect(has).toContain("and g.level = 'edit'")
    expect(has).toContain("public.get_member_role(p_workspace) in ('owner', 'admin', 'member')")
    const reaches = fn(sql512, 'entity_edit_grant_reaches')
    expect(reaches).toContain("and g.level = 'edit'")
    expect(reaches).toContain("and me.role in ('owner', 'admin', 'member')")
    expect(fn(sql512, 'my_entity_edit_grant_ids')).toContain("and g.level = 'edit'")
    // The pre-check reads the caller's channels once, as 495's does.
    expect(fn(sql512, 'my_entity_edit_grant_ids')).not.toContain('team_chat_can_read')
  })

  it('every grantable kind is known to the record-side helpers; a company only by its own grant', () => {
    for (const name of ['entity_edit_grant_on', 'entity_edit_grant_only']) {
      for (const t of GRANTABLE_TYPES) expect(fn(sql512, name), `${name} ${t}`).toContain(`when '${t}' then`)
    }
    // A grant on one of a company's contacts opens it to reading (494), never to editing.
    expect(fn(sql512, 'entity_edit_grant_on')).toContain("when 'company' then (select public.has_entity_edit_grant('company', co.id, co.workspace_id) from public.company co where co.id = p_id)")
    expect(fn(sql512, 'entity_view_grant_only')).toContain('public.entity_grant_only(p_type, p_id) and not public.entity_edit_grant_on(p_type, p_id)')
  })
})

describe('migration 512: the write policies', () => {
  it('494’s content restrictives refuse a VIEW-only grantee now; the delete ones are untouched', () => {
    const contentRestrictives: Array<[string, string]> = [
      ['company_update_not_by_grant', "not public.entity_view_grant_only('company', id)"],
      ['comment_insert_not_by_grant', 'not public.entity_view_grant_only(commentable_type::text, commentable_id)'],
      ['comment_update_not_by_grant', 'not public.entity_view_grant_only(commentable_type::text, commentable_id)'],
      ['capture_label_insert_not_by_grant', "not public.entity_view_grant_only('capture', capture_id)"],
      ['capture_label_update_not_by_grant', "not public.entity_view_grant_only('capture', capture_id)"],
      ['capture_label_delete_not_by_grant', "not public.entity_view_grant_only('capture', capture_id)"],
      ['attachments_delete_not_by_grant', "not public.entity_view_grant_only('capture', note_id)"],
      ['proposed_change_update_not_by_grant', "not public.entity_view_grant_only('document', document_id)"],
    ]
    for (const [name, rule] of contentRestrictives) {
      const p = policy(sql512, name)
      expect(p, name).toContain('as restrictive for')
      expect(p, name).toContain(rule)
    }
    // No grant of any level deletes a record: 494's delete restrictives stay as they were.
    for (const name of ['document_delete_not_by_grant', 'captures_delete_not_by_grant', 'company_delete_not_by_grant']) {
      expect(sql512, name).not.toContain(`create policy ${name}`)
    }
  })

  it('an edit grantee deletes only their own comments', () => {
    const p = policy(sql512, 'comment_delete_not_by_grant')
    expect(p).toContain('not public.entity_grant_only(commentable_type::text, commentable_id)')
    expect(p).toContain('public.entity_edit_grant_on(commentable_type::text, commentable_id)')
    expect(p).toContain('author_id in (select m.id from public.member m where m.user_id = auth.uid())')
  })

  it('each opened permissive policy gains exactly the edit-grant arm for its kind', () => {
    const opened: Array<[string, string, 'document' | 'capture' | 'contact']> = [
      ['document_update', 'public.document', 'document'],
      ['document_chunks_write', 'public.document_chunks', 'document'],
      ['captures_update', 'public.captures', 'capture'],
      ['capture_chunks_insert', 'public.capture_chunks', 'capture'],
      ['capture_chunks_delete', 'public.capture_chunks', 'capture'],
      ['"Workspace members can manage capture participants"', 'public.capture_participant', 'capture'],
      ['capture_references_all', 'public.capture_references', 'capture'],
      ['"Workspace members can manage decisions"', 'public.decision', 'capture'],
      ['"Members can insert proposed changes"', 'public.proposed_change', 'capture'],
      ['"Members can delete proposed changes"', 'public.proposed_change', 'capture'],
      ['"Members can update proposed changes"', 'public.proposed_change', 'capture'],
      ['contact_update', 'public.contact', 'contact'],
      ['interaction_manage_via_contact', 'public.contact_interaction', 'contact'],
    ]
    for (const [name, table, kind] of opened) {
      const p = policy(sql512, name)
      expect(p, name).toContain(`on ${table}`)
      expect(p, name).toContain(`(select public.my_entity_edit_grant_ids('${kind}'))::uuid[]`)
      expect(p, name).toContain(`public.has_entity_edit_grant('${kind}', `)
      expect(p, name).not.toContain('restrictive')
      expect(sql512, name).toContain(`drop policy if exists ${name} on ${table};`)
    }
    // The document arm keeps can_edit_document's own exclusions.
    const doc = policy(sql512, 'document_update')
    expect(doc.match(/not public\.is_product_doc\(workspace_id, id\)/g)?.length).toBe(2)
    expect(doc.match(/coalesce\(type, 'note'\) <> 'spec'/g)?.length).toBe(2)
    // The own rule is still there, word for word.
    expect(doc).toContain('can_edit_document(id, workspace_id, created_by, type, slug, published_status, frontmatter, project_id)')
  })

  it('the column guard: an edit grant never changes ownership, visibility, workspace or archive state', () => {
    const guard = fn(sql512, 'entity_edit_grant_column_guard')
    expect(guard).toContain("if current_user not in ('authenticated', 'anon') or auth.uid() is null then")
    expect(guard).toContain('if public.entity_edit_grant_only(tg_argv[0], old.id) then')
    expect(guard).toContain("errcode = '42501'")
    const expected: Record<string, [string, string[]]> = {
      document: ['document', ['workspace_id', 'created_by', 'visibility', 'status', 'published_status', 'slug', 'type', 'canon_key', 'project_id', 'team_id', 'is_pinned']],
      captures: [
        'capture',
        ['workspace_id', 'user_id', 'visibility', 'is_eval', "(old.status = 'archived') is distinct from (new.status = 'archived')", 'project_id', 'team_id', 'package_ids', 'is_pinned'],
      ],
      // A contact's company moves who can see that company (a granted contact opens it); the email autolink sets it too.
      contact: ['contact', ['workspace_id', 'created_by_member_id', 'visibility', 'merged_into_contact_id', 'company_id']],
      // A company's domain fires its adoption trigger, which pulls other members' contacts in.
      company: ['company', ['workspace_id', 'is_workspace_company', 'domain']],
    }
    for (const [table, [kind, cols]] of Object.entries(expected)) {
      const trig = new RegExp(`create trigger entity_edit_grant_column_guard\\s+before update on public\\.${table}[\\s\\S]*?;`).exec(sql512)?.[0] ?? ''
      expect(trig, table).toContain(`execute function public.entity_edit_grant_column_guard('${kind}')`)
      for (const c of cols) expect(trig, `${table}.${c}`).toContain(c.startsWith('(') ? c : `old.${c} is distinct from new.${c}`)
    }
  })

  it('an edit grantee resolves someone else’s comment, never rewrites it', () => {
    const guard = fn(sql512, 'entity_edit_grant_comment_guard')
    expect(guard).toContain("if current_user not in ('authenticated', 'anon') or auth.uid() is null then")
    expect(guard).toContain('if old.author_user_id is not null and old.author_user_id = auth.uid() then')
    expect(guard).toContain('old.author_id in (select m.id from public.member m where m.user_id = auth.uid())')
    expect(guard).toContain('if public.entity_grant_only(old.commentable_type::text, old.commentable_id) then')
    expect(sql512).toMatch(/create trigger entity_edit_grant_comment_guard\s+before update on public\.comment\s+for each row\s+when \(\(to_jsonb\(old\) - 'is_resolved'\) is distinct from \(to_jsonb\(new\) - 'is_resolved'\)\)/)
  })

  it('a grant takes either level; only its level changes after, by whoever may share', () => {
    const insert = policy(sql512, 'entity_access_insert')
    expect(insert).toContain("and level in ('view', 'edit')")
    expect(insert).toContain('granted_by = public.current_member_id(workspace_id)')
    expect(insert).toContain('public.entity_access_can_share(entity_type, entity_id, workspace_id)')
    expect(sql512).toContain('grant update (level) on table public.entity_access to authenticated;')
    expect(sql512).not.toMatch(/grant update on table public\.entity_access/)
    const update = policy(sql512, 'entity_access_update')
    expect(update).toContain('for update to authenticated')
    expect(update.match(/public\.entity_access_can_share\(entity_type, entity_id, workspace_id\)/g)?.length).toBe(2)
  })

  it('the agent’s edit rules stay their own; the edit grant is a separate question', () => {
    // 498's contact_editable_by and 496's company_visible_to_ungranted keep no
    // grant arm: a guest's or linked agent's turn asks them and nothing else.
    const contact = fn(sql512, 'contact_editable_by')
    expect(contact).not.toMatch(/entity_edit_grant|entity_access/)
    expect(contact).toContain("cs.access_level = 'edit'")
    expect(sql512).not.toContain('create or replace function public.company_visible_to_ungranted')
    expect(sql512).toContain('drop function if exists public.company_editable_by(uuid, uuid);')
    const granted = fn(sql512, 'entity_edit_granted')
    expect(granted).toMatch(/security definer\s+set search_path = public, pg_temp/)
    expect(granted).toContain('IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RETURN FALSE; END IF;')
    expect(granted).toContain('RETURN public.entity_edit_grant_reaches(p_type, p_id, v_workspace_id, p_user_id);')
    expect(granted).toContain("IF p_type = 'contact' THEN")
    expect(granted).toContain("ELSIF p_type = 'company' THEN")
    expect(sql512).toContain('revoke all on function public.entity_edit_granted(text, uuid, uuid) from public, anon;')
  })

  it('is re-runnable, reloads the API schema, and carries no backslash', () => {
    expect(sql512).not.toContain('\\')
    expect(sql512.trim().endsWith("notify pgrst, 'reload schema';")).toBe(true)
    // Every policy it creates, it drops first.
    expect(sql512.match(/create policy /g)?.length).toBe(sql512.match(/drop policy if exists /g)?.length)
  })
})

describe('migration 513: a share is an activity row', () => {
  it('adds shared to the action vocabulary', () => {
    expect(sql513).toContain('alter table public.entity_activity drop constraint if exists entity_activity_action_check;')
    expect(sql513).toMatch(/'updated', 'shared'\n\)\);/)
  })

  it('logs once per statement, the grantee as the subject only for a grant to one member, never to oneself', () => {
    const body = fn(sql513, 'entity_activity_entity_access_insert')
    expect(body).toMatch(/security definer\s+set search_path = public, pg_temp/)
    expect(body).toContain("case when n.grantee_kind = 'member' then n.grantee_member_id end")
    expect(body).toContain("jsonb_build_object('level', n.level, 'grantee_kind', n.grantee_kind, 'source', n.source)")
    expect(body).toContain("and not (n.grantee_kind = 'member' and n.grantee_member_id is not distinct from n.granted_by)")
    expect(body).toContain('public.entity_activity_writable(n.workspace_id)')
    expect(body).toContain('exception when others then')
    expect(sql513).toMatch(/after insert on public\.entity_access\s+referencing new table as new_rows\s+for each statement/)
    // Raising a grant to edit says so in the Inbox; lowering one writes nothing.
    expect(sql513).toMatch(/after update of level on public\.entity_access\s+for each row\s+when \(old\.level = 'view' and new\.level = 'edit'\)/)
    expect(fn(sql513, 'entity_activity_entity_access_level')).toContain("case when new.grantee_kind = 'member' then new.grantee_member_id end")
    expect(sql513).not.toContain('\\')
    expect(sql513.trim().endsWith("notify pgrst, 'reload schema';")).toBe(true)
  })
})
