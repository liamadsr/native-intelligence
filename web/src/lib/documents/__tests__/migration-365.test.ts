/**
 * Migration 365: search finds documents wherever they match. Pins: no
 * backslash; idempotent; hybrid_search is 353's body with ONLY the document
 * branch changed (archived left out, the window by updated_at, the matching
 * passage as the excerpt with its section), same signature and grants;
 * document_chunks gains heading; replace_document_chunks swaps a document's
 * chunks in one transaction (new rows first, reusing unchanged vectors, the
 * old ones deleted after), SECURITY INVOKER, serialized per document.
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
const SQL = read('365_document_search_everywhere.sql')
const BODY = flat(SQL)
const fnBody = (body: string, name: string) => {
  const start = body.indexOf(`create or replace function public.${name}(`)
  return body.slice(start, body.indexOf('$$;', start) + 3)
}
const HYBRID = fnBody(BODY, 'hybrid_search')
const PRIOR = fnBody(flat(read('353_learn_by_default.sql')), 'hybrid_search')
const SWAP = fnBody(BODY, 'replace_document_chunks')
const docBranch = (fn: string) => fn.slice(fn.indexOf('document_fts as ('), fn.indexOf('select * from claim_final'))

describe('migration 365', () => {
  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('is idempotent', () => {
    expect(BODY).not.toMatch(/create function /)
    expect(BODY).toContain('alter table public.document_chunks add column if not exists heading text;')
  })

  it('hybrid_search changes the document branch only', () => {
    const before = PRIOR.replace(docBranch(PRIOR), '')
    const after = HYBRID.replace(docBranch(HYBRID), '')
    expect(after).toBe(before)
    expect(BODY).toContain(
      'grant execute on function public.hybrid_search(uuid, text, text, text[], timestamptz, timestamptz, integer, integer, double precision, double precision, double precision, text, uuid) to authenticated, service_role;',
    )
  })

  it('documents: archived left out, an explicit window by updated_at, recency by updated_at', () => {
    const docs = docBranch(HYBRID)
    expect(docs.match(/d\.status <> 'archived'/g)?.length).toBe(2)
    expect(docs).toContain('(p_since is null or d.updated_at >= p_since)')
    expect(docs).toContain('(p_until is null or d.updated_at <= p_until)')
    expect(docs).not.toContain('d.created_at')
    expect(docs).toContain('row_number() over (order by d.updated_at desc)')
    expect(docs).toContain('d.updated_at as event_at')
  })

  it('the excerpt is the matching passage, with its section, for the documents that can make the list only', () => {
    const docs = docBranch(HYBRID)
    expect(docs).not.toMatch(/left\(d\.content, 300\) as excerpt/)
    expect(docs).toContain('coalesce(passage.chunk_text, left(doc.content, 300)) as excerpt')
    expect(docs).toContain("jsonb_build_object('section', passage.heading)")
    expect(docs).toContain('where dc.id = ds.chunk_id')
    expect(docs).toContain("ts_headline('english', doc.content, v_tsquery,")
    // document_scored is cut to p_limit before any passage is read.
    expect(docs).toMatch(/document_scored as \(.*order by score desc limit p_limit \)/)
  })

  it('chunks never cross workspaces: the swap refuses a document outside the workspace, search reads only its own', () => {
    // The swap refuses before it touches anything, and only touches that workspace's chunks.
    expect(SWAP).toContain(
      "if not exists ( select 1 from public.document d where d.id = p_document_id and d.workspace_id = p_workspace_id ) then raise exception 'document % is not in workspace %', p_document_id, p_workspace_id using errcode = '42501';",
    )
    expect(SWAP.indexOf('raise exception')).toBeLessThan(SWAP.indexOf('pg_advisory_xact_lock'))
    expect(SWAP).toContain('where old.document_id = p_document_id and old.workspace_id = p_workspace_id')
    expect(SWAP).toContain('delete from public.document_chunks where document_id = p_document_id and workspace_id = p_workspace_id and chunk_index >= 0;')
    expect(SWAP).toContain('where document_id = p_document_id and workspace_id = p_workspace_id and chunk_index < 0;')
    // hybrid_search: the vector read wants the document in the workspace too,
    // and both passage reads and the no-vectors check read this workspace's chunks.
    const docs = docBranch(HYBRID)
    expect(docs).toContain('where dc.workspace_id = p_workspace_id and d.workspace_id = p_workspace_id')
    expect(docs).toContain('where dc.id = ds.chunk_id and dc.workspace_id = p_workspace_id')
    expect(docs).toContain('and dc.document_id = ds.result_id and dc.workspace_id = p_workspace_id')
    expect(docs).toContain('where dc2.document_id = ds.result_id and dc2.workspace_id = p_workspace_id')
    expect(docs.match(/from public\.document_chunks/g)?.length).toBe(4)
  })

  it("document_chunks RLS: a chunk's document must be in the chunk's workspace (185 checked the chunk alone)", () => {
    const parent = 'exists ( select 1 from public.document d where d.id = document_chunks.document_id and d.workspace_id = document_chunks.workspace_id )'
    expect(BODY).toContain('drop policy if exists "workspace members can view document chunks" on public.document_chunks;')
    expect(BODY).toContain('drop policy if exists "workspace members can write document chunks" on public.document_chunks;')
    expect(BODY).toContain(`create policy document_chunks_select on public.document_chunks for select using ( public.is_workspace_member(workspace_id) and ${parent} );`)
    expect(BODY).toContain(
      `create policy document_chunks_write on public.document_chunks for all using ( public.is_workspace_member(workspace_id) and ${parent} ) with check ( public.is_workspace_member(workspace_id) and ${parent} );`,
    )
    // Any chunk already filed under another workspace's document goes.
    expect(BODY).toContain('delete from public.document_chunks dc using public.document d where d.id = dc.document_id and d.workspace_id <> dc.workspace_id;')
  })

  it('replace_document_chunks: invoker, serialized, new rows first, then the old ones go', () => {
    expect(SWAP).toContain('security invoker set search_path = public, pg_temp')
    expect(SWAP).toContain("pg_advisory_xact_lock(hashtextextended('replace_document_chunks:' || p_document_id::text, 0))")
    const insert = SWAP.indexOf('insert into public.document_chunks')
    const del = SWAP.indexOf('delete from public.document_chunks')
    const renumber = SWAP.indexOf('update public.document_chunks set chunk_index = -1 - chunk_index')
    expect(insert).toBeGreaterThan(0)
    expect(del).toBeGreaterThan(insert)
    expect(renumber).toBeGreaterThan(del)
    // An unchanged chunk reuses its vector.
    expect(SWAP).toContain("coalesce( (r ->> 'embedding')::vector(1536), (select old.embedding from public.document_chunks old")
    expect(BODY).toContain('revoke execute on function public.replace_document_chunks(uuid, uuid, uuid, jsonb) from public, anon;')
  })
})
