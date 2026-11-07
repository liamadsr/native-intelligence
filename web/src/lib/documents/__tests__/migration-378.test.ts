/**
 * Migration 378: when a report or prep was last opened, in its own table (a
 * stamp on the document would move updated_at), at most one write a day,
 * service role only.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/378_document_open.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
  .toLowerCase()

describe('migration 378', () => {
  it('has no backslash and is idempotent', () => {
    expect(SQL.includes('\\')).toBe(false)
    expect(BODY).toContain('create table if not exists public.document_open (')
    expect(BODY).not.toMatch(/create function /)
  })

  it('one row per document, cascading with it', () => {
    expect(BODY).toContain('document_id uuid primary key references public.document(id) on delete cascade')
  })

  it('stamps at most once a day, fenced to the workspace, for the service role only', () => {
    expect(BODY).toContain('where d.id = p_document_id and d.workspace_id = p_workspace_id')
    expect(BODY).toContain("where public.document_open.last_opened_at < now() - interval '1 day';")
    expect(BODY).toContain('revoke all on function public.note_document_open(uuid, uuid) from public, anon, authenticated;')
    expect(BODY).toContain('grant execute on function public.note_document_open(uuid, uuid) to service_role;')
    expect(BODY).toContain('revoke all on public.document_open from anon, authenticated;')
  })
})
