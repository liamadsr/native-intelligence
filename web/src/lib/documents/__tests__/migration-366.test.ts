/**
 * Migration 366: system documents can be edited, never deleted or archived.
 * Pins: no backslash; idempotent; canon_key is unique per workspace and
 * well-formed; is_system_document is SECURITY DEFINER (it reads the product-
 * doc pointer) and false once the workspace is gone (a workspace delete still
 * cascades); the guard refuses delete and archive for EVERY caller (no
 * current_user escape on those) with P0013, and lets only an owner or admin
 * set or clear a key from a client. Plus parity with the app's SQLSTATE.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SYSTEM_DOCUMENT_SQLSTATE } from '../system-document'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/366_system_documents.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase()
const fn = (name: string, schema = 'public') => {
  const start = BODY.indexOf(`create or replace function ${schema}.${name}(`)
  return BODY.slice(start, BODY.indexOf('$$;', start) + 3)
}

describe('migration 366', () => {
  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('is idempotent', () => {
    expect(BODY).not.toMatch(/create function /)
    expect(BODY).toContain('add column if not exists canon_key text')
    expect(BODY).toContain('create unique index if not exists document_workspace_canon_key_idx on public.document (workspace_id, canon_key) where canon_key is not null;')
    expect(BODY).toContain('drop trigger if exists document_system_guard on public.document;')
  })

  it('a system document: a canon key or the product doc, while the workspace exists', () => {
    const f = fn('is_system_document', 'private')
    expect(f).toContain('security definer set search_path = public, pg_temp')
    expect(f).toContain('select exists (select 1 from public.workspace w where w.id = ws) and (canon is not null or public.is_product_doc(ws, doc));')
    expect(BODY).toContain('revoke execute on function private.is_system_document(uuid, uuid, text) from public, anon;')
  })

  it("no member can call it over RPC: the guards use the private one, the public one is the service role's", () => {
    // The guard runs as the caller, so the function it calls must be executable
    // by authenticated: the private schema's, which the API doesn't expose (341).
    expect(BODY).toContain('create schema if not exists private;')
    expect(BODY).toContain('grant execute on function private.is_system_document(uuid, uuid, text) to authenticated, service_role;')
    const g = fn('document_system_guard')
    expect(g).not.toContain('security definer')
    expect(g.match(/private\.is_system_document\(/g)?.length).toBe(2)
    expect(g).not.toContain('public.is_system_document(')
    expect(fn('is_system_document')).toContain('select private.is_system_document(ws, doc, canon);')
    expect(BODY).toContain('revoke execute on function public.is_system_document(uuid, uuid, text) from public, anon, authenticated;')
    expect(BODY).toContain('grant execute on function public.is_system_document(uuid, uuid, text) to service_role;')
    expect(BODY).not.toMatch(/grant execute on function public\.is_system_document\([^)]*\) to [^;]*authenticated/)
  })

  it('refuses delete and archive for every caller, with the app\'s SQLSTATE', () => {
    const g = fn('document_system_guard')
    expect(SYSTEM_DOCUMENT_SQLSTATE).toBe('P0013')
    expect(g.match(/errcode = 'p0013'/g)?.length).toBe(2)
    // The delete and archive checks come before (and outside) the client-only key check.
    const del = g.indexOf("if tg_op = 'delete' then")
    const archive = g.indexOf("new.status = 'archived'")
    const client = g.indexOf("current_user in ('authenticated', 'anon')")
    expect(del).toBeGreaterThan(0)
    expect(archive).toBeGreaterThan(del)
    expect(client).toBeGreaterThan(archive)
    expect(g.slice(0, client)).not.toContain('current_user')
    expect(BODY).toContain('before insert or update or delete on public.document for each row execute function public.document_system_guard();')
  })

  it('only an owner or admin sets or clears a key from a client; the key is well-formed', () => {
    const g = fn('document_system_guard')
    expect(g).toContain("coalesce(public.get_member_role(new.workspace_id), '') not in ('owner', 'admin')")
    expect(BODY).toContain("check (canon_key is null or canon_key ~ '^[a-z0-9][a-z0-9:._-]{0,63}$')")
  })
})
