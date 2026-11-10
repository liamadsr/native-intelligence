/**
 * Migration 498, contact_editable_by: the contact EDIT rule (058's
 * can_edit_contact) for an explicit user, which the service-role contact
 * write gates ask (isContactWritableTo). Run on DEV inside a rolled-back
 * transaction as a real member: their own UPDATE changed 0 rows on a contact
 * shared to them for viewing and on a teammate's team contact (and 1 on an
 * edit share), and contact_editable_by answered false, false, true; asked by
 * that member about the owner, it said false. These hold the shape.
 */
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

const sql = migrationsInOrder().find((m) => m.file.startsWith('498_'))!.sql
const body = /create or replace function public\.contact_editable_by\(p_contact_id uuid, p_user_id uuid\)([\s\S]*?)\$function\$;/.exec(sql)?.[1] ?? ''

describe('migration 498: contact_editable_by', () => {
  it('runs as its owner with a pinned search_path, and has no backslashes', () => {
    expect(body).toMatch(/security definer\s+set search_path = public, pg_temp/)
    expect(sql).not.toContain('\\')
  })

  it('is the edit rule: creator, owner/admin, workspace-visible, or an edit share (member or team)', () => {
    expect(body).toContain('IF v_member_id = v_c.created_by_member_id THEN RETURN TRUE; END IF;')
    expect(body).toContain("IF v_role IN ('owner','admin') THEN RETURN TRUE; END IF;")
    expect(body).toContain("IF v_c.visibility = 'workspace' THEN RETURN TRUE; END IF;")
    expect(body.match(/cs\.access_level = 'edit'/g)).toHaveLength(2)
  })

  it('never says yes for seeing alone: no team-visibility arm, no grant arm, no view share', () => {
    expect(body).not.toMatch(/visibility = 'team'/)
    expect(body).not.toMatch(/entity_grant|has_entity_grant|my_entity_grant_ids/)
    expect(body).not.toMatch(/contact_visible_to/)
  })

  it('a signed-in caller asks only about themself; a null contact or user is a no', () => {
    expect(body).toContain('IF p_contact_id IS NULL OR p_user_id IS NULL THEN RETURN FALSE; END IF;')
    expect(body).toContain('IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RETURN FALSE; END IF;')
  })

  it('is callable by the tools (session or service role), never anon', () => {
    expect(sql).toContain('revoke all on function public.contact_editable_by(uuid, uuid) from public, anon;')
    expect(sql).toContain('grant execute on function public.contact_editable_by(uuid, uuid) to authenticated, service_role;')
  })
})
