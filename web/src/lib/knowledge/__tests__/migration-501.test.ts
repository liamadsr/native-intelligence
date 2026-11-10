/**
 * Migration 501: the review fixes to 500, pinned as text. claim_neighborhood
 * and _claim_sync_project_ids are the service role's alone; a company end is
 * asked of one set-based hidden set, as a claim end is; writing an edge asks
 * the read rule; and the policy (now 501's) still fences exactly the app's
 * LINK_FENCED_KINDS.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { LINK_FENCED_KINDS } from '../entity-fences'

const sql = readFileSync(path.join(process.cwd(), 'supabase/migrations/501_entity_link_read_review_fixes.sql'), 'utf8')
const code = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')

/** A policy's rule: the text after its USING / WITH CHECK, up to the statement's end. */
function rule(name: string, clause: 'using' | 'with check'): string {
  const start = code.indexOf(`create policy ${name}`)
  expect(start, name).toBeGreaterThan(-1)
  const body = code.slice(start, code.indexOf(';', start))
  return body.slice(body.indexOf(clause) + clause.length).trim()
}

const SET_KINDS = ['claim', 'company']

describe('migration 501: graph edges after review', () => {
  it('holds no backslash and reloads the API schema', () => {
    expect(sql.includes(String.fromCharCode(92))).toBe(false)
    expect(code.trim().endsWith("notify pgrst, 'reload schema';")).toBe(true)
  })

  it('takes claim_neighborhood and _claim_sync_project_ids from every signed-in caller', () => {
    expect(code).toContain(
      'revoke all on function public.claim_neighborhood(text, text, text, integer, integer, uuid) from public, anon, authenticated;',
    )
    expect(code).toContain('grant execute on function public.claim_neighborhood(text, text, text, integer, integer, uuid) to service_role;')
    expect(code).toContain('revoke all on function public._claim_sync_project_ids(uuid) from public, anon, authenticated;')
  })

  it('asks claims and companies of their hidden sets, at both ends, as uncorrelated (hashed) INs', () => {
    const select = rule('entity_link_select', 'using')
    for (const kind of SET_KINDS) {
      const fn = kind === 'claim' ? 'private.claims_hidden_from_me()' : 'private.companies_hidden_from_me()'
      expect(select).toContain(`(source_type <> '${kind}' or not (source_id in (select ${fn})))`)
      expect(select).toContain(`(target_type <> '${kind}' or not (target_id in (select ${fn})))`)
    }
  })

  it('every other fenced kind goes through entity_visible_to, and the two lists together are LINK_FENCED_KINDS', () => {
    const select = rule('entity_link_select', 'using')
    const lists = [...select.matchAll(/<> all \('\{([a-z_,]+)\}'::text\[\]\)/g)].map((m) => m[1].split(','))
    expect(lists).toHaveLength(2)
    const expected = LINK_FENCED_KINDS.filter((k) => !SET_KINDS.includes(k))
    for (const list of lists) expect([...list].sort()).toEqual([...expected].sort())
    expect(select).toContain('public.entity_visible_to(source_type, source_id, workspace_id, (select auth.uid()))')
    expect(select).toContain('public.entity_visible_to(target_type, target_id, workspace_id, (select auth.uid()))')
  })

  it('writing an edge asks exactly the read rule', () => {
    expect(rule('entity_link_insert', 'with check')).toBe(rule('entity_link_select', 'using'))
  })

  it("the company set restates company_visible_to: admins see all, then a grant, then a live contact they can see", () => {
    const fn = code.slice(code.indexOf('create or replace function private.companies_hidden_from_me()'), code.indexOf('revoke all on function private.companies_hidden_from_me()'))
    expect(fn).toContain("coalesce(me.role, '') not in ('owner', 'admin')")
    expect(fn).toContain("public.my_entity_grant_ids('company')")
    expect(fn).toContain('ct.merged_into_contact_id is null')
    expect(fn).toContain("ct.visibility = 'workspace'")
    expect(fn).toContain('public.contact_share')
    expect(fn).toContain("public.my_entity_grant_ids('contact')")
    expect(fn).toContain('security definer')
  })
})
