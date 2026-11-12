/**
 * Migration 500: a graph edge is readable only when both its ends are. It
 * can't be run here, so the file is pinned as text, and held to the app's
 * mirror (LINK_FENCED_KINDS): the policy fences exactly those kinds, every
 * linkable kind is either fenced or one every member reads, and the writes
 * keep what the old ALL policy said.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { LINK_FENCED_KINDS, PRIVATE_GRAPH_KINDS } from '../entity-fences'
import { LINKABLE_ENTITY_TYPES } from '../entity-registry'

const sql = readFileSync(path.join(process.cwd(), 'supabase/migrations/500_entity_link_read_follows_endpoints.sql'), 'utf8')
const code = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')

/** The SELECT policy's text, up to the next statement. */
const selectPolicy = (() => {
  const start = code.indexOf('create policy entity_link_select')
  expect(start).toBeGreaterThan(-1)
  return code.slice(start, code.indexOf(';', start))
})()

/**
 * A kind's name when 500 was written: 503 renamed the graph's `email` to
 * `email_thread` (and redefines this policy and function under the new
 * name, pinned by migration-503.test.ts), so 500 is read here as written.
 */
const NAME_IN_500: Record<string, string> = { email_thread: 'email' }
const in500 = (kind: string) => NAME_IN_500[kind] ?? kind

/**
 * Kinds fenced elsewhere: tables and their rows by later migrations (522 and
 * 600, ./migration-522.test.ts), the Studio's by 624's own restrictive
 * policies (migration-624.test.ts).
 */
const LATER = new Set<string>(['data_table', 'data_row', 'studio_video', 'studio_project'])
const FENCED_IN_500 = LINK_FENCED_KINDS.filter((k) => !LATER.has(k))

/** Linkable kinds every member of the workspace reads (their tables' RLS is membership only). */
const OPEN_KINDS = ['project', 'action', 'initiative', 'cycle', 'member', 'campaign', 'milestone', 'deal', 'flow']

describe('migration 500: entity_link reads follow both ends', () => {
  it('holds no backslash', () => {
    expect(sql.includes(String.fromCharCode(92))).toBe(false)
  })

  it('drops both old policies and splits the writes out', () => {
    expect(code).toContain('drop policy if exists "Workspace members can view entity links" on public.entity_link;')
    expect(code).toContain('drop policy if exists "Workspace members can write entity links" on public.entity_link;')
    for (const cmd of ['insert', 'update', 'delete']) {
      expect(code).toMatch(new RegExp(`create policy entity_link_${cmd} on public.entity_link\\s+for ${cmd}`))
    }
    // No ALL policy any more: it would read every row too.
    expect(code).not.toMatch(/for all/i)
  })

  it('asks the claim table its own hidden set, and entity_visible_to for every other fenced kind, at both ends', () => {
    expect(selectPolicy).toContain("(source_type <> 'claim' or not (source_id in (select private.claims_hidden_from_me())))")
    expect(selectPolicy).toContain("(target_type <> 'claim' or not (target_id in (select private.claims_hidden_from_me())))")
    const lists = [...selectPolicy.matchAll(/<> all \('\{([a-z_,]+)\}'::text\[\]\)/g)].map((m) => m[1].split(','))
    expect(lists).toHaveLength(2)
    const expected = FENCED_IN_500.filter((k) => k !== 'claim').map(in500)
    for (const list of lists) expect([...list].sort()).toEqual([...expected].sort())
    expect(selectPolicy).toContain('public.entity_visible_to(source_type, source_id, workspace_id, (select auth.uid()))')
    expect(selectPolicy).toContain('public.entity_visible_to(target_type, target_id, workspace_id, (select auth.uid()))')
    expect(selectPolicy.indexOf('public.is_workspace_member(workspace_id)')).toBeGreaterThan(-1)
  })

  it('entity_visible_to has a branch for every fenced kind but claim-in-policy, and answers a signed-in caller only about themself', () => {
    const fn = code.slice(code.indexOf('create or replace function public.entity_visible_to'), code.indexOf('create or replace function public.entity_refs_hidden'))
    for (const kind of FENCED_IN_500) expect(fn, kind).toMatch(new RegExp(`'${in500(kind)}'`))
    expect(fn).toContain('if auth.uid() is not null and p_user is distinct from auth.uid() then return false; end if;')
    expect(fn).toContain('security definer')
    expect(fn).toContain('set search_path = public, pg_temp')
  })

  it('every linkable kind is either fenced or one every member reads', () => {
    const fenced = new Set<string>(LINK_FENCED_KINDS)
    for (const kind of LINKABLE_ENTITY_TYPES) {
      expect(fenced.has(kind) || OPEN_KINDS.includes(kind), `${kind} must be classified`).toBe(true)
    }
    for (const kind of OPEN_KINDS) expect(fenced.has(kind), kind).toBe(false)
    // The private graph kinds are among the fenced ones.
    for (const kind of PRIVATE_GRAPH_KINDS) expect(fenced.has(kind), kind).toBe(true)
  })

  it('the service-role helper takes the caller as the user when signed in', () => {
    expect(code).toContain('not public.entity_visible_to(r.t, r.i, p_workspace, coalesce(auth.uid(), p_user))')
    expect(code).toContain('revoke all on function public.entity_visible_to(text, uuid, uuid, uuid) from public, anon;')
    expect(code).toContain('revoke all on function public.entity_refs_hidden(uuid, uuid, text[], uuid[]) from public, anon;')
  })
})
