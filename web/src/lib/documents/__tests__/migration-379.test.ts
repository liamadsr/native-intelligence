/**
 * Migration 379: removing a member who created a private document works.
 * The foreign key's SET NULL on document.created_by goes through for a
 * document that was already private (it stays private, kept, visible to no
 * one); an INSERT of a private document with no creator, and making a
 * creator-less document private, are still refused. No delete and no flip to
 * workspace visibility anywhere. Depends on 369 only: it redefines 369's guard
 * and touches nothing later migrations added.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/379_member_removal_private_docs.sql'), 'utf8')
const OLD = readFileSync(join(process.cwd(), 'supabase/migrations/369_document_visibility.sql'), 'utf8')
const flat = (s: string) =>
  s
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
const guard = (body: string) => {
  const start = body.indexOf('create or replace function public.document_visibility_guard(')
  return body.slice(start, body.indexOf('$$;', start) + 3)
}
const BODY = flat(SQL)
const G = guard(BODY)

describe('migration 379', () => {
  it('has no backslash and is idempotent', () => {
    expect(SQL.includes('\\')).toBe(false)
    expect(BODY).not.toMatch(/create function /)
    expect(BODY).toContain('drop trigger if exists document_visibility_guard on public.document;')
    expect(BODY).toContain('before insert or update on public.document for each row execute function public.document_visibility_guard();')
  })

  it('lets an already-private document lose its creator, and nothing else', () => {
    expect(G).toContain("if new.created_by is null and not (tg_op = 'update' and old.visibility = 'private') then")
    expect(G).toContain("raise exception 'a private document needs its creator' using errcode = 'p0015';")
  })

  it('deletes nothing and never makes a document visible to the workspace', () => {
    expect(BODY).not.toMatch(/delete from/)
    expect(BODY).not.toMatch(/visibility\s*=\s*'workspace'/)
    expect(BODY).not.toMatch(/update public\.document/)
  })

  it('is 369’s guard otherwise, and needs nothing after 369', () => {
    const strip = (g: string) => g.replace(/if new\.created_by is null( and not \(tg_op = 'update' and old\.visibility = 'private'\))? then/, 'if new.created_by is null then')
    expect(strip(G)).toBe(strip(guard(flat(OLD))))
    // Nothing from a later migration: no canon personal keys, no edit_meta.
    expect(BODY).not.toContain('canon_key ~')
    expect(BODY).not.toContain('edit_meta')
  })
})
