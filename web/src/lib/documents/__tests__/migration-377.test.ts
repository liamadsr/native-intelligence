/**
 * Migration 377: one row per ## section of a canon document, server-written;
 * a member reads only the rows of documents they can see.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/377_document_section_check.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
  .toLowerCase()

describe('migration 377', () => {
  it('has no backslash and is idempotent', () => {
    expect(SQL.includes('\\')).toBe(false)
    expect(BODY).toContain('create table if not exists public.document_section_check (')
    expect(BODY).toContain('drop policy if exists "document_section_check_select" on public.document_section_check;')
  })

  it('keys a row by (document, section), cascading with the document and the workspace', () => {
    expect(BODY).toContain('primary key (document_id, section)')
    expect(BODY).toContain('document_id uuid not null references public.document(id) on delete cascade')
    expect(BODY).toContain('workspace_id uuid not null references public.workspace(id) on delete cascade')
    expect(BODY).toContain("check (verified_kind in ('edit', 'agent', 'confirmed'))")
  })

  it('is read by members who can see the document, and written by no client', () => {
    expect(BODY).toContain('alter table public.document_section_check enable row level security;')
    expect(BODY).toContain('using (public.is_workspace_member(workspace_id) and public.document_visible_to(document_id, (select auth.uid())));')
    expect(BODY).toContain('revoke all on public.document_section_check from anon, authenticated; grant select on public.document_section_check to authenticated;')
    expect(BODY).not.toMatch(/for (insert|update|delete|all)/)
  })
})
