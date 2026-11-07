/**
 * Migration 369: private documents ("Only me"), the way captures are private
 * (223). Pins: no backslash; idempotent; the column and its CHECK;
 * document_visible_to; the guard (a private document needs its creator, is
 * never a system document, and from a client only its creator flips it); RLS
 * on document, chunks, revisions and the comment policy's document arm; and
 * every function it re-creates is its previous body plus ONLY the document
 * terms (the prior definition is found the way the database would have it,
 * the newest migration before 369).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { definitionsIn, latestDefinition, migrationsInOrder } from '@/test/migration-sql'

const FILE = '369_document_visibility.sql'
const SQL = readFileSync(join(process.cwd(), 'supabase/migrations', FILE), 'utf8')
const flat = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
const BODY = flat(SQL)
const BEFORE = migrationsInOrder().filter((m) => m.num < 369)

/** The one definition of `fn` in 369, and the one the database had before it. */
function pair(fn: string): { now: string; prior: string; priorFile: string } {
  const now = definitionsIn(SQL, fn)
  const prior = latestDefinition(fn, BEFORE)
  expect(now).toHaveLength(1)
  expect(prior.blocks).toHaveLength(1)
  return { now: flat(now[0]), prior: flat(prior.blocks[0]), priorFile: prior.file }
}

/** Take each added fragment out of `fn` (exactly `times` times) and hand back the rest. */
function without(fn: string, fragments: Array<[string, number]>): string {
  let out = fn
  for (const [frag, times] of fragments) {
    expect(out.split(frag).length - 1, frag).toBe(times)
    out = out.split(frag).join('')
  }
  return out
}

const VIS = " and (d.visibility = 'workspace' or (v_requester_member is not null and d.created_by = v_requester_member))"
const MEMBER_DECL = ' v_requester_member uuid;'
const MEMBER_LOOKUP =
  ' if v_requester is not null then select m.id into v_requester_member from public.member m where m.workspace_id = p_workspace_id and m.user_id = v_requester limit 1; end if;'

describe('migration 369', () => {
  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('is idempotent', () => {
    expect(BODY).not.toMatch(/create function /)
    expect(BODY).toContain("alter table public.document add column if not exists visibility text not null default 'workspace';")
    expect(BODY).toContain("if not exists (select 1 from pg_constraint where conname = 'document_visibility_check')")
    expect(BODY).toContain("check (visibility in ('workspace', 'private'))")
    expect(BODY).toContain("create index if not exists idx_document_private_creator on public.document (workspace_id, created_by) where visibility = 'private';")
    for (const policy of ['document_select', 'document_update', 'document_chunks_select', 'document_chunks_write', 'document_revision_select']) {
      expect(BODY).toContain(`drop policy if exists ${policy} on public.`)
    }
    expect(BODY).toContain('drop trigger if exists document_visibility_guard on public.document;')
  })

  it("document_visible_to: workspace, or the requester's own (its creator member row); a missing document is not visible", () => {
    const [fn] = definitionsIn(SQL, 'document_visible_to').map(flat)
    expect(fn).toContain(
      "select exists ( select 1 from public.document d where d.id = p_document_id and ( d.visibility = 'workspace' or ( p_user_id is not null and exists ( select 1 from public.member m where m.id = d.created_by and m.user_id = p_user_id ) ) ) );",
    )
    expect(fn).toContain('security definer stable set search_path = public, pg_temp;')
    expect(BODY).toContain('revoke execute on function public.document_visible_to(uuid, uuid) from public, anon;')
  })

  it('the guard: a creator, never a system document, and from a client only the creator flips it', () => {
    const [guard] = definitionsIn(SQL, 'document_visibility_guard').map(flat)
    expect(guard).toContain("if new.visibility = 'private' then if new.created_by is null then raise exception 'a private document needs its creator' using errcode = 'p0015';")
    // The guard runs as the caller: the private schema's function (366), which members may execute.
    expect(guard).toContain("if private.is_system_document(new.workspace_id, new.id, new.canon_key) then raise exception 'this is a system document: it can''t be private' using errcode = 'p0014';")
    expect(guard).not.toContain('public.is_system_document(')
    expect(guard).not.toContain('security definer')
    expect(guard).toContain(
      "if tg_op = 'update' and new.visibility is distinct from old.visibility and current_user in ('authenticated', 'anon') and (old.created_by is null or old.created_by is distinct from public.current_member_id(old.workspace_id)) then raise exception 'only its creator can change who can see a document' using errcode = '42501';",
    )
    expect(BODY).toContain('create trigger document_visibility_guard before insert or update on public.document for each row execute function public.document_visibility_guard();')
  })

  it('RLS: the document, its chunks, its history and its comments follow the rule; no admin override', () => {
    const RULE = "(visibility = 'workspace' or created_by = public.current_member_id(workspace_id))"
    const PARENT = "(d.visibility = 'workspace' or d.created_by = public.current_member_id(d.workspace_id))"
    expect(BODY).toContain('drop policy if exists "workspace members can view documents" on public.document;')
    expect(BODY).toContain(`create policy document_select on public.document for select using ( public.is_workspace_member(workspace_id) and ${RULE} );`)
    const canEdit = 'public.can_edit_document(id, workspace_id, created_by, type, slug, published_status, frontmatter, project_id)'
    expect(BODY).toContain(`create policy document_update on public.document for update to authenticated using ( ${canEdit} and ${RULE} ) with check ( ${canEdit} and ${RULE} );`)
    for (const [table, policy] of [
      ['document_chunks', 'document_chunks_select'],
      ['document_chunks', 'document_chunks_write'],
      ['document_revision', 'document_revision_select'],
    ]) {
      const at = BODY.indexOf(`create policy ${policy} on public.${table}`)
      expect(at, policy).toBeGreaterThan(0)
      // Chunks keep 365's rule too: the parent document is in the chunk's workspace.
      const parent = table === 'document_chunks' ? `where d.id = ${table}.document_id and d.workspace_id = ${table}.workspace_id and ${PARENT}` : `where d.id = ${table}.document_id and ${PARENT}`
      expect(BODY.slice(at, BODY.indexOf(');', at) + 2 + 400)).toContain(parent)
    }
    expect(BODY).toContain(`when 'document' then exists ( select 1 from public.document d where d.id = commentable_id and public.is_workspace_member(d.workspace_id) and ${PARENT} )`)
    // Nothing here grants an owner or admin a way in.
    expect(BODY).not.toMatch(/is_workspace_admin|role in \('owner', 'admin'\)/)
  })

  it("the comment policy is 223's with only the document arm changed", () => {
    const at223 = migrationsInOrder().find((m) => m.file.startsWith('223_'))!
    const cut = (sql: string) => {
      const i = sql.indexOf('drop policy if exists "view comments: members + own external" on public.comment;')
      const j = sql.indexOf(' );', sql.indexOf('create policy "view comments: members + own external"', i)) + 3
      return sql.slice(i, j)
    }
    const now = cut(BODY)
    expect(now.length).toBeGreaterThan(100)
    expect(without(now, [[" and (d.visibility = 'workspace' or d.created_by = public.current_member_id(d.workspace_id))", 1]])).toBe(cut(flat(at223.sql)))
  })

  it('claim_visible_to gains a document arm only', () => {
    const { now, prior } = pair('claim_visible_to')
    expect(without(now, [[" when 'document' then public.document_visible_to(cs.source_id, p_user_id)", 1]])).toBe(prior)
  })

  it("private.claim_sources_hidden_from_me also hides sources citing someone else's private document", () => {
    const needle = 'CREATE OR REPLACE FUNCTION private.claim_sources_hidden_from_me()'
    const cut = (sql: string) => {
      const i = sql.indexOf(needle)
      const close = sql.indexOf('$$', sql.indexOf('$$', i) + 2)
      return flat(sql.slice(i, sql.indexOf(';', close) + 1))
    }
    const prior = [...BEFORE].reverse().find((m) => m.sql.includes(needle))!
    const added =
      " union select cs.id from ws join public.document d on d.workspace_id = ws.workspace_id join public.claim_source cs on cs.source_type = 'document' and cs.source_id = d.id where d.visibility = 'private' and not exists ( select 1 from public.member m where m.id = d.created_by and m.user_id = auth.uid() )"
    expect(without(cut(SQL), [[added, 1]])).toBe(cut(prior.sql))
  })

  it("hybrid_search (365's body) adds the requester's member row and the rule to both document reads, and the document claim source", () => {
    const { now, prior, priorFile } = pair('hybrid_search')
    expect(priorFile).toBe('365_document_search_everywhere.sql')
    // The member row is read after the membership gate.
    expect(now.indexOf(MEMBER_LOOKUP.trim())).toBeGreaterThan(now.indexOf('if v_requester is not null and not public._is_member_of(v_requester, p_workspace_id) then'))
    expect(
      without(now, [
        [MEMBER_DECL, 1],
        [MEMBER_LOOKUP, 1],
        [VIS, 2],
        [" when 'document' then public.document_visible_to(cs.source_id, v_requester)", 1],
      ]),
    ).toBe(prior)
  })

  it("unified_search (275's body) adds the rule to its document read", () => {
    const { now, prior } = pair('unified_search')
    expect(without(now, [[MEMBER_DECL, 1], [MEMBER_LOOKUP, 1], [VIS, 1]])).toBe(prior)
  })

  it('claim_neighborhood: a private document is neither a centre, a step, nor a label for anyone else', () => {
    const { now, prior } = pair('claim_neighborhood')
    expect(
      without(now, [
        [" or (p_entity_type = 'document' and not public.document_visible_to(v_center_id, v_requester))", 1],
        [" and (nxt.node_type <> 'document' or public.document_visible_to(nxt.node_id, v_requester))", 1],
        [' and public.document_visible_to(doc.id, v_requester)', 1],
      ]),
    ).toBe(prior)
  })

  it("moves: a private document moves only with its creator, and a project never carries someone else's", () => {
    const doc = pair('move_document')
    const docGate =
      " if exists ( select 1 from public.document d where d.id = p_document_id and d.visibility = 'private' and not coalesce(v_owns, false) ) then raise exception 'only its creator can move a private document' using errcode = '42501'; end if;"
    expect(without(doc.now, [[docGate, 1]])).toBe(doc.prior)
    // The gate sits before the move itself.
    expect(doc.now.indexOf(docGate.trim())).toBeLessThan(doc.now.indexOf('v_core := public._wsmove_documents_core('))

    const proj = pair('move_project')
    const projGate =
      " if p_move_documents and exists ( select 1 from public.document d where d.project_id = p_project_id and d.workspace_id = v_source and d.visibility = 'private' and not exists ( select 1 from public.member m where m.id = d.created_by and m.user_id = v_user_id ) ) then raise exception 'the project holds someone else''s private document' using errcode = '42501'; end if;"
    expect(without(proj.now, [[projGate, 1]])).toBe(proj.prior)
  })

  it("keeps every re-created function's grants", () => {
    for (const fn of ['hybrid_search', 'unified_search', 'claim_neighborhood', 'claim_visible_to', 'move_document', 'move_project']) {
      const prior = flat(latestDefinition(fn, BEFORE).file === '(none)' ? '' : readFileSync(join(process.cwd(), 'supabase/migrations', latestDefinition(fn, BEFORE).file), 'utf8'))
      const grants = prior.split(';').filter((s) => s.includes(`function public.${fn}(`) && /\b(grant|revoke)\b/.test(s) && !s.includes('create or replace'))
      expect(grants.length, fn).toBeGreaterThan(0)
      for (const g of grants) expect(BODY, `${fn}: ${g}`).toContain(g.trim())
    }
  })

  it('backfill: every meeting prep becomes private, owned by the person it was prepared for; never a system document', () => {
    const owner =
      "coalesce( (select m.id from public.member m where m.workspace_id = d.workspace_id and m.user_id::text = d.frontmatter -> 'meeting_prep' ->> 'userid' limit 1), d.created_by)"
    expect(BODY).toContain(`update public.document d set visibility = 'private', created_by = ${owner} where d.frontmatter ? 'meeting_prep' and d.visibility = 'workspace' and ${owner} is not null and not private.is_system_document(d.workspace_id, d.id, d.canon_key);`)
  })
})
