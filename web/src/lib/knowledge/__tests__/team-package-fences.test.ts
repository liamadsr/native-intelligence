/**
 * Teams and knowledge packages as graph endpoints (migration 673):
 *  - a team: every member reads a public one; a private one only its members;
 *  - a package: a workspace one to every member, a personal one to its
 *    creator, a team one to that team, and one shared with the person or a
 *    team of theirs; nothing to someone outside the workspace, or to no one;
 *  - a written mention of either is fenced the same way;
 *  - 673 fences their edges with its OWN function and RESTRICTIVE policies,
 *    and redefines nothing that exists.
 * Fixtures are made up.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { visibleMentionTargets } from '@/lib/entity-links/mentions'
import { isMentionableType } from '@/lib/entity-links/mentionable'
import { LINK_FENCED_KINDS, isPrivateGraphKind, visiblePrivateKindIds } from '../entity-fences'
import { LINKABLE_ENTITY_TYPES } from '../entity-registry'

const WS = '11111111-1111-4111-8111-111111111111'
const OTHER_WS = '11111111-1111-4111-8111-999999999999'
const ANA = '22222222-2222-4222-8222-aaaaaaaaaaaa'
const BEN = '22222222-2222-4222-8222-bbbbbbbbbbbb'
const OUTSIDER = '22222222-2222-4222-8222-cccccccccccc'
const M_ANA = '33333333-3333-4333-8333-aaaaaaaaaaaa'
const M_BEN = '33333333-3333-4333-8333-bbbbbbbbbbbb'
const T_OPEN = '44444444-4444-4444-8444-000000000001'
const T_ANA = '44444444-4444-4444-8444-000000000002'
const T_BEN = '44444444-4444-4444-8444-000000000003'
const T_FAR = '44444444-4444-4444-8444-000000000004'
const P_WS = '55555555-5555-4555-8555-000000000001'
const P_ANA = '55555555-5555-4555-8555-000000000002'
const P_BEN = '55555555-5555-4555-8555-000000000003'
const P_TEAM_ANA = '55555555-5555-4555-8555-000000000004'
const P_TEAM_BEN = '55555555-5555-4555-8555-000000000005'
const P_SHARED = '55555555-5555-4555-8555-000000000006'
const P_SHARED_TEAM = '55555555-5555-4555-8555-000000000007'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>

beforeEach(() => {
  tables = {
    member: [
      { id: M_ANA, user_id: ANA, workspace_id: WS },
      { id: M_BEN, user_id: BEN, workspace_id: WS },
      { id: 'm-out', user_id: OUTSIDER, workspace_id: OTHER_WS },
    ],
    team: [
      { id: T_OPEN, workspace_id: WS, name: 'General', is_private: false },
      { id: T_ANA, workspace_id: WS, name: 'Harbor crew', is_private: true },
      { id: T_BEN, workspace_id: WS, name: 'Pricing', is_private: true },
      { id: T_FAR, workspace_id: OTHER_WS, name: 'Elsewhere', is_private: false },
    ],
    team_member: [
      { team_id: T_ANA, member_id: M_ANA },
      { team_id: T_BEN, member_id: M_BEN },
    ],
    knowledge_package: [
      { id: P_WS, workspace_id: WS, name: 'Brand voice', visibility: 'workspace', team_id: null, created_by: BEN },
      { id: P_ANA, workspace_id: WS, name: 'My notes', visibility: 'personal', team_id: null, created_by: ANA },
      { id: P_BEN, workspace_id: WS, name: 'Ben’s notes', visibility: 'personal', team_id: null, created_by: BEN },
      { id: P_TEAM_ANA, workspace_id: WS, name: 'Harbor facts', visibility: 'team', team_id: T_ANA, created_by: BEN },
      { id: P_TEAM_BEN, workspace_id: WS, name: 'Pricing facts', visibility: 'team', team_id: T_BEN, created_by: BEN },
      { id: P_SHARED, workspace_id: WS, name: 'Shared with Ana', visibility: 'personal', team_id: null, created_by: BEN },
      { id: P_SHARED_TEAM, workspace_id: WS, name: 'Shared with her team', visibility: 'personal', team_id: null, created_by: BEN },
    ],
    knowledge_package_share: [
      { package_id: P_SHARED, shared_with_member_id: M_ANA, shared_with_team_id: null },
      { package_id: P_SHARED_TEAM, shared_with_member_id: null, shared_with_team_id: T_ANA },
    ],
  }
})

const TEAMS = [T_OPEN, T_ANA, T_BEN, T_FAR]
const PACKAGES = [P_WS, P_ANA, P_BEN, P_TEAM_ANA, P_TEAM_BEN, P_SHARED, P_SHARED_TEAM]
const sorted = (s: Set<string>) => [...s].sort()

describe('the registries', () => {
  it('make both graph endpoints, mentionable, private and fenced kinds', () => {
    for (const kind of ['team', 'knowledge_package'] as const) {
      expect(LINKABLE_ENTITY_TYPES, kind).toContain(kind)
      expect(isMentionableType(kind), kind).toBe(true)
      expect(isPrivateGraphKind(kind), kind).toBe(true)
      expect(LINK_FENCED_KINDS as readonly string[], kind).toContain(kind)
    }
  })
})

describe('a team', () => {
  it('is read by its workspace’s members, a private one only by its own', async () => {
    expect(sorted(await visiblePrivateKindIds(memoryDb(tables), 'team', ANA, TEAMS, WS))).toEqual([T_OPEN, T_ANA].sort())
    expect(sorted(await visiblePrivateKindIds(memoryDb(tables), 'team', BEN, TEAMS, WS))).toEqual([T_OPEN, T_BEN].sort())
  })

  it('is no one’s outside its workspace, or with no user', async () => {
    expect(sorted(await visiblePrivateKindIds(memoryDb(tables), 'team', OUTSIDER, TEAMS, WS))).toEqual([])
    expect(sorted(await visiblePrivateKindIds(memoryDb(tables), 'team', null, TEAMS, WS))).toEqual([])
    // Asked without a workspace, a team elsewhere is still only its own workspace's members'.
    expect(sorted(await visiblePrivateKindIds(memoryDb(tables), 'team', ANA, [T_FAR]))).toEqual([])
  })
})

describe('a knowledge package', () => {
  it('follows its visibility, its creator and its shares', async () => {
    expect(sorted(await visiblePrivateKindIds(memoryDb(tables), 'knowledge_package', ANA, PACKAGES, WS))).toEqual([P_WS, P_ANA, P_TEAM_ANA, P_SHARED, P_SHARED_TEAM].sort())
    expect(sorted(await visiblePrivateKindIds(memoryDb(tables), 'knowledge_package', BEN, PACKAGES, WS))).toEqual([P_WS, P_BEN, P_TEAM_ANA, P_TEAM_BEN, P_SHARED, P_SHARED_TEAM].sort())
  })

  it('is no one’s outside its workspace, or with no user', async () => {
    expect(sorted(await visiblePrivateKindIds(memoryDb(tables), 'knowledge_package', OUTSIDER, PACKAGES, WS))).toEqual([])
    expect(sorted(await visiblePrivateKindIds(memoryDb(tables), 'knowledge_package', null, PACKAGES, WS))).toEqual([])
  })
})

describe('a written mention', () => {
  it('keeps only the teams and packages its writer may read', async () => {
    const visible = await visibleMentionTargets(memoryDb(tables), { workspaceId: WS, userId: ANA }, [
      { type: 'team', id: T_ANA },
      { type: 'team', id: T_BEN },
      { type: 'knowledge_package', id: P_ANA },
      { type: 'knowledge_package', id: P_BEN },
    ])
    expect(visible).toEqual([
      { type: 'team', id: T_ANA },
      { type: 'knowledge_package', id: P_ANA },
    ])
  })
})

describe('migration 673, section A', () => {
  const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/673_mentions_shares.sql'), 'utf8')
  const BODY = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ')

  it('fences team and package edges with its own function and restrictive policies', () => {
    expect(SQL).not.toContain('\\')
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
    expect(BODY).toContain('create or replace function public.team_package_entity_visible_to(p_type text, p_id uuid, p_workspace uuid, p_user uuid)')
    // A signed-in caller asks only about themself; no user reads nothing.
    expect(BODY).toContain('if p_id is null or p_user is null then return false; end if;')
    expect(BODY).toContain('if auth.uid() is not null and p_user is distinct from auth.uid() then return false; end if;')
    expect(BODY).toContain('return public.package_visible_to(p_id, p_user);')
    for (const op of ['select', 'insert', 'update', 'delete']) {
      expect(BODY, op).toContain(`drop policy if exists entity_link_team_package_${op} on public.entity_link; create policy entity_link_team_package_${op} on public.entity_link as restrictive for ${op}`)
    }
    expect(BODY).toContain('revoke all on function public.team_package_entity_visible_to(text, uuid, uuid, uuid) from public, anon;')
  })

  it('redefines no function or policy that already exists', () => {
    expect(BODY).not.toContain('function public.entity_visible_to')
    expect(BODY).not.toMatch(/policy entity_link_select\b/)
    expect(BODY).not.toMatch(/policy entity_link_insert\b/)
    expect(BODY).not.toContain('on public.chat_conversations')
    expect(BODY).not.toContain('on public.chat_messages')
    expect(BODY).not.toMatch(/alter table public\.email_share\b/)
  })
})
