/**
 * Migration 359: who may change a document. Pins: no backslash; idempotent;
 * the four helpers are SECURITY DEFINER with a pinned search_path and no
 * anon/public execute; the three policies replace 025's; the guard trigger is
 * SECURITY INVOKER keyed on current_user (never auth.role()); and
 * delete_document_with_knowledge is 237's body plus the ownership check, same
 * signature and grants. Plus parity with src/lib/documents/access.ts.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8')
const flat = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
const SQL = read('359_document_write_rls.sql')
const BODY = flat(SQL)
const fn = (body: string, name: string) => {
  const start = body.indexOf(`create or replace function public.${name}(`)
  return body.slice(start, body.indexOf('$$;', start) + 3)
}

describe('migration 359', () => {
  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('is idempotent', () => {
    expect(BODY).not.toMatch(/create function /)
    expect(BODY).not.toMatch(/create policy (?!document_update|document_delete|document_insert)/)
    for (const p of ['document_update', 'document_delete', 'document_insert']) {
      expect(BODY).toContain(`drop policy if exists ${p} on public.document;`)
    }
    expect(BODY).toContain('drop trigger if exists document_guard_update on public.document;')
  })

  it('drops the three 025 write policies and leaves the SELECT one', () => {
    expect(BODY).toContain('drop policy if exists "workspace members can update documents" on public.document;')
    expect(BODY).toContain('drop policy if exists "creator and admins can delete documents" on public.document;')
    expect(BODY).toContain('drop policy if exists "workspace members can create documents" on public.document;')
    expect(BODY).not.toContain('"workspace members can view documents"')
  })

  it('the helpers are definer, pinned, and not callable by anon', () => {
    const sigs: Record<string, string> = {
      current_member_id: 'public.current_member_id(uuid)',
      is_product_doc: 'public.is_product_doc(uuid, uuid)',
      can_edit_document: 'public.can_edit_document(uuid, uuid, uuid, text, text, text, jsonb, uuid)',
    }
    for (const [name, sig] of Object.entries(sigs)) {
      expect(fn(BODY, name)).toContain('security definer set search_path = public, pg_temp')
      expect(BODY).toContain(`revoke execute on function ${sig} from public, anon;`)
      expect(BODY).toContain(`grant execute on function ${sig} to authenticated, service_role;`)
    }
    expect(fn(BODY, 'is_product_doc')).toContain("(w.settings -> 'product_doc' ->> 'document_id') = doc::text")
  })

  it('the four policies', () => {
    const cols = 'id, workspace_id, created_by, type, slug, published_status, frontmatter, project_id'
    expect(BODY).toContain(
      `create policy document_update on public.document for update to authenticated using (public.can_edit_document(${cols})) with check (public.can_edit_document(${cols}));`,
    )
    expect(BODY).toContain(
      "create policy document_delete on public.document for delete to authenticated using ( public.get_member_role(workspace_id) in ('owner', 'admin') or ( created_by is not null and created_by = public.current_member_id(workspace_id) and not public.is_product_doc(workspace_id, id) ) );",
    )
    expect(BODY).toContain(
      "create policy document_insert on public.document for insert to authenticated with check ( public.is_workspace_member(workspace_id) and created_by is not distinct from public.current_member_id(workspace_id) and not (coalesce(frontmatter, '{}'::jsonb) ? 'meeting_prep') );",
    )
  })

  it('can_edit_document encodes the EDIT rule in order', () => {
    const f = fn(BODY, 'can_edit_document')
    const order = [
      "if v_role is null or v_role not in ('owner', 'admin', 'member') then return false;",
      "if v_role in ('owner', 'admin') then return true;",
      'if public.is_product_doc(p_workspace_id, p_id) then return false;',
      "if coalesce(p_type, 'note') = 'spec' then return false;",
      'if p_created_by is not null and p_created_by = v_member then return true;',
      "return coalesce(p_published_status, '') = 'published' and not (coalesce(p_frontmatter, '{}'::jsonb) ? 'meeting_prep') and p_project_id is null and (p_slug is not null or coalesce(p_type, 'note') <> 'note');",
    ]
    let at = -1
    for (const line of order) {
      const i = f.indexOf(line)
      expect(i, line).toBeGreaterThan(at)
      at = i
    }
  })

  it('the guard trigger is invoker, skips server roles by current_user, and blocks the guarded columns', () => {
    const f = fn(BODY, 'document_guard_update')
    expect(f).not.toContain('security definer')
    expect(BODY).not.toContain('auth.role()')
    expect(f).toContain("if current_user not in ('authenticated', 'anon') then return new;")
    expect(f).toContain('if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id then raise exception')
    expect(f).toContain("if (new.frontmatter -> 'meeting_prep') is distinct from (old.frontmatter -> 'meeting_prep') then raise exception")
    expect(f).toContain('if new.created_by is distinct from old.created_by then raise exception')
    expect(f).toContain(
      'if new.status is distinct from old.status or new.published_status is distinct from old.published_status or new.slug is distinct from old.slug or new.type is distinct from old.type then raise exception',
    )
    expect(BODY).toContain('revoke execute on function public.document_guard_update() from public, anon, authenticated;')
    expect(BODY).toContain(
      'create trigger document_guard_update before update on public.document for each row execute function public.document_guard_update();',
    )
  })

  it("delete_document_with_knowledge is 237's body plus the ownership check", () => {
    const f = fn(BODY, 'delete_document_with_knowledge')
    const f237 = fn(flat(read('237_explicit_requester_rpcs.sql')), 'delete_document_with_knowledge')
    // Same signature, return shape and requester pattern as 237.
    for (const piece of [
      'public.delete_document_with_knowledge( p_document_id uuid, p_workspace_id uuid, p_user_id uuid default null ) returns jsonb language plpgsql security definer set search_path = public, pg_temp',
      'v_uid uuid := public._resolve_requester(p_user_id);',
      "if not public._is_member_of(v_uid, p_workspace_id) then raise exception 'not a member of workspace' using errcode = '42501';",
      "raise exception 'document not found' using errcode = 'p0002';",
      "v_cleanup := public._cleanup_claim_provenance( p_workspace_id, jsonb_build_array(jsonb_build_object('t', 'document', 'id', p_document_id)) );",
      'delete from public.document where id = p_document_id and workspace_id = p_workspace_id;',
      "return jsonb_build_object( 'document_id', p_document_id, 'cleanup', v_cleanup );",
    ]) {
      expect(f, piece).toContain(piece)
      expect(f237, piece).toContain(piece)
    }
    expect(f).toContain(
      "if not ( v_role in ('owner', 'admin') or ( v_created_by is not null and v_created_by = v_member and not public.is_product_doc(p_workspace_id, p_document_id) ) ) then raise exception",
    )
    // The check comes before anything is torn down.
    expect(f.indexOf('is_product_doc')).toBeLessThan(f.indexOf('_cleanup_claim_provenance'))
    expect(BODY).toContain('revoke execute on function public.delete_document_with_knowledge(uuid, uuid, uuid) from public, anon;')
    expect(BODY).toContain('grant execute on function public.delete_document_with_knowledge(uuid, uuid, uuid) to authenticated, service_role;')
  })

  it('the header says why, what changes, and how it is applied', () => {
    expect(SQL).toMatch(/applied to DEV and then PROD BEFORE the app PR merges/)
    expect(SQL).toMatch(/src\/lib\/documents\/access\.ts/)
  })
})
