/**
 * Migration 506: the agent reads what is shared with its person. Pins: no
 * backslash; idempotent; entity_grant_ids_for (the explicit-user, one-
 * workspace twin of my_entity_grant_ids: every grantee arm, the self-only
 * guard, not for anon); and every function it re-creates is the previous
 * body (the newest migration before 506, as the database has it) plus ONLY
 * the grant terms, so no other rule moved: the claim arms, the eval fence,
 * the mail fences, the membership gate all travel unchanged.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { definitionsIn, latestDefinition, migrationsInOrder } from '@/test/migration-sql'

const FILE = '506_agent_reads_shared_records.sql'
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
const BEFORE = migrationsInOrder().filter((m) => m.num < 506)

/** The function body between its dollar quotes (the header's layout differs between hand-written and dumped forms). */
function bodyOf(block: string): string {
  const open = block.indexOf('$$')
  const close = block.indexOf('$$', open + 2)
  expect(open).toBeGreaterThan(-1)
  expect(close).toBeGreaterThan(open)
  return flat(block.slice(open + 2, close))
}

/** The one definition of `fn` in 506, and the one the database had before it. */
function pair(fn: string): { now: string; prior: string; nowBlock: string; priorFile: string } {
  const now = definitionsIn(SQL, fn)
  const prior = latestDefinition(fn, BEFORE)
  expect(now).toHaveLength(1)
  expect(prior.blocks).toHaveLength(1)
  return { now: bodyOf(now[0]), prior: bodyOf(prior.blocks[0]), nowBlock: flat(now[0]), priorFile: prior.file }
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

const DECLS: Array<[string, number]> = [
  [" v_granted_captures uuid[] := '{}'::uuid[];", 1],
  [" v_granted_documents uuid[] := '{}'::uuid[];", 1],
]
const READ_ONCE =
  " if v_requester is not null then v_granted_captures := public.entity_grant_ids_for('capture', p_workspace_id, v_requester); v_granted_documents := public.entity_grant_ids_for('document', p_workspace_id, v_requester); end if;"

describe('migration 506', () => {
  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('is idempotent and reloads the API schema', () => {
    expect(BODY).not.toMatch(/create function /)
    expect(BODY).not.toMatch(/create table /)
    expect(BODY.trim().endsWith("notify pgrst, 'reload schema';")).toBe(true)
  })

  describe('entity_grant_ids_for', () => {
    // Written in lower case, so read off the flattened file (definitionsIn looks for the upper-case form).
    const start = BODY.indexOf('create or replace function public.entity_grant_ids_for(')
    const fn = BODY.slice(start, BODY.indexOf('$$;', start) + 3)

    it('is defined once', () => {
      expect(start).toBeGreaterThan(-1)
      expect(BODY.split('function public.entity_grant_ids_for(text, uuid, uuid)').length - 1).toBe(2)
    })

    it('is SECURITY DEFINER with a pinned search_path, and stable', () => {
      expect(fn).toContain('security definer')
      expect(fn).toContain('set search_path = public, pg_temp')
      expect(fn).toContain('stable')
    })

    it('answers a signed-in caller only about themself, and only in one workspace', () => {
      expect(fn).toContain('where m.user_id = p_user and m.workspace_id = p_workspace and (auth.uid() is null or auth.uid() = p_user)')
      expect(fn).toContain('where g.workspace_id = p_workspace and g.entity_type = p_type')
    })

    it('reaches the member, a team of the workspace they are in, and a channel they can read (474)', () => {
      expect(fn).toContain("(g.grantee_kind = 'member' and g.grantee_member_id in (select id from me))")
      expect(fn).toContain("(g.grantee_kind = 'team' and g.grantee_team_id in (select team_id from my_teams))")
      expect(fn).toContain("(g.grantee_kind = 'channel' and g.grantee_channel_id in (select id from my_channels))")
      expect(fn).toContain('join public.team t on t.id = tm.team_id and t.workspace_id = p_workspace')
      // team_chat_can_read: a team channel is its team's (every member's with no team), a DM its members'.
      expect(fn).toContain("(c.kind = 'channel' and (c.team_id is null or c.team_id in (select team_id from my_teams)))")
      expect(fn).toContain("(c.kind = 'dm' and exists ( select 1 from public.team_chat_member cm where cm.channel_id = c.id and cm.member_id in (select id from me)))")
    })

    it('hands back the most recently granted first, never null', () => {
      expect(fn).toContain("select coalesce(array_agg(h.entity_id order by h.last_at desc), '{}'::uuid[]) from hits h where case p_type")
    })

    it('answers only records that still exist and that only the grant opens (the 200-id lists never fill with dead or redundant ids)', () => {
      expect(fn).toContain(
        "when 'document' then exists ( select 1 from public.document d where d.id = h.entity_id and d.workspace_id = p_workspace and d.visibility = 'private' and (d.created_by is null or d.created_by not in (select id from me)))",
      )
      expect(fn).toContain(
        "when 'capture' then exists ( select 1 from public.captures c where c.id = h.entity_id and c.workspace_id = p_workspace and c.visibility = 'private' and c.user_id is distinct from p_user and not c.is_eval)",
      )
      expect(fn).toContain("when 'contact' then exists (select 1 from public.contact ct where ct.id = h.entity_id and ct.workspace_id = p_workspace)")
      expect(fn).toContain("when 'company' then exists (select 1 from public.company co where co.id = h.entity_id and co.workspace_id = p_workspace)")
      expect(fn).toContain('else false end;')
    })

    it('is not for anon', () => {
      expect(BODY).toContain('revoke all on function public.entity_grant_ids_for(text, uuid, uuid) from public, anon;')
      expect(BODY).toContain('grant execute on function public.entity_grant_ids_for(text, uuid, uuid) to authenticated, service_role;')
    })
  })

  it("unified_search (369's body) adds the grants, read once, to its capture, document and decision reads", () => {
    const { now, prior, priorFile, nowBlock } = pair('unified_search')
    expect(priorFile).toBe('369_document_visibility.sql')
    expect(nowBlock).toContain('security definer')
    expect(nowBlock).toContain('set search_path = public, pg_temp')
    // The grants are read after the membership gate.
    expect(now.indexOf(READ_ONCE.trim())).toBeGreaterThan(now.indexOf('if v_requester is not null and not public._is_member_of(v_requester, p_workspace_id) then'))
    expect(
      without(now, [
        ...DECLS,
        [READ_ONCE, 1],
        // The capture branch and the decision branch (its capture's grant, 493).
        [' or c.id = any(v_granted_captures)', 2],
        [' or d.id = any(v_granted_documents)', 1],
      ]),
    ).toBe(prior)
  })

  it("hybrid_search (369's body) adds them to its capture and document reads; its claim arms are untouched", () => {
    const { now, prior, priorFile, nowBlock } = pair('hybrid_search')
    expect(priorFile).toBe('369_document_visibility.sql')
    expect(nowBlock).toContain('security definer')
    expect(nowBlock).toContain('set search_path = public, pg_temp')
    expect(now.indexOf(READ_ONCE.trim())).toBeGreaterThan(now.indexOf('if v_requester is not null and not public._is_member_of(v_requester, p_workspace_id) then'))
    expect(
      without(now, [
        ...DECLS,
        [READ_ONCE, 1],
        [' or c.id = any(v_granted_captures)', 2],
        [' or cap.id = any(v_granted_captures)', 1],
        [' or d.id = any(v_granted_documents)', 2],
      ]),
    ).toBe(prior)
    // A claim's provenance (cap2 / cap3) never follows a grant: claims key off their sources' own rules.
    expect(now).not.toContain('cap2.id = any')
    expect(now).not.toContain('cap3.id = any')
  })

  it("list_companies_with_stats (236's body) also lists a company shared with the person", () => {
    const { now, prior, nowBlock } = pair('list_companies_with_stats')
    expect(nowBlock).toContain('security definer')
    expect(nowBlock).toContain('set search_path = public, pg_temp')
    // Read only once the person is known to be a member (the NOT FOUND return comes first).
    expect(now.indexOf("v_granted := public.entity_grant_ids_for('company', p_workspace_id, p_user_id);")).toBeGreaterThan(
      now.indexOf('if not found then return; end if;'),
    )
    expect(
      without(now, [
        [" v_granted uuid[] := '{}'::uuid[];", 1],
        [" v_granted := public.entity_grant_ids_for('company', p_workspace_id, p_user_id);", 1],
        [' or c.id = any(v_granted)', 1],
      ]),
    ).toBe(prior)
  })
})
