/**
 * The private-team rule for a teammate chat, checked explicitly
 * (src/lib/chat/teammate-access.ts) because ai_team_member's admin ALL policy
 * grants SELECT to every owner and admin with no team check.
 *
 * Pins:
 *   1. a system teammate is reachable with no read;
 *   2. a public team is reachable; a private team only from a seat on it;
 *   3. an owner/admin NOT on a private team is refused (the finding);
 *   4. a team that reads as missing (RLS hides a private team, or it sits in
 *      another workspace), a teammate with no team and a user with no member
 *      row are refused;
 *   5. a known member id skips the member read; a query error throws.
 */
import { describe, it, expect } from 'vitest'
import { callerCanReachTeammate, callerReachableTeammateIds } from '../teammate-access'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'

type Row = Record<string, unknown> | null
interface Call {
  table: string
  eqs: Array<[string, unknown]>
}

function fakeSupabase(answers: Record<string, Row | { error: string }>) {
  const calls: Call[] = []
  const from = (table: string) => {
    const call: Call = { table, eqs: [] }
    calls.push(call)
    const c: Record<string, unknown> = {}
    c.select = () => c
    c.eq = (col: string, v: unknown) => (call.eqs.push([col, v]), c)
    c.maybeSingle = async () => {
      const a = answers[table] ?? null
      if (a && 'error' in a) return { data: null, error: { message: String(a.error) } }
      return { data: a, error: null }
    }
    return c
  }
  return { client: { from } as never, calls }
}

const BASE = { userId: 'user-admin', workspaceId: 'ws-1' }
const ROLE = { isSystem: false, teamId: 'team-sales' }

describe('callerCanReachTeammate', () => {
  it('a system teammate is reachable by every member, with no read', async () => {
    const { client, calls } = fakeSupabase({})
    expect(await callerCanReachTeammate(client, { ...BASE, teammate: { isSystem: true, teamId: null } })).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('a teammate on a public team is reachable (no seat read)', async () => {
    const { client, calls } = fakeSupabase({ team: { is_private: false } })
    expect(await callerCanReachTeammate(client, { ...BASE, teammate: ROLE })).toBe(true)
    expect(calls.map((c) => c.table)).toEqual(['team'])
    // Fenced to the teammate's workspace.
    expect(calls[0].eqs).toEqual([['id', 'team-sales'], ['workspace_id', 'ws-1']])
  })

  it('a private team: reachable from a seat on it, looked up by the user’s member row', async () => {
    const { client, calls } = fakeSupabase({ team: { is_private: true }, member: { id: 'mem-1' }, team_member: { team_id: 'team-sales' } })
    expect(await callerCanReachTeammate(client, { ...BASE, teammate: ROLE })).toBe(true)
    expect(calls.map((c) => c.table)).toEqual(['team', 'member', 'team_member'])
    expect(calls[1].eqs).toEqual([['user_id', 'user-admin'], ['workspace_id', 'ws-1']])
    expect(calls[2].eqs).toEqual([['team_id', 'team-sales'], ['member_id', 'mem-1']])
  })

  it('an owner/admin NOT on a private team is refused (the service client still reads the team)', async () => {
    const { client } = fakeSupabase({ team: { is_private: true }, member: { id: 'mem-admin' }, team_member: null })
    expect(await callerCanReachTeammate(client, { ...BASE, teammate: ROLE })).toBe(false)
  })

  it('is_private that is not an explicit false reads as private', async () => {
    const { client } = fakeSupabase({ team: { is_private: null }, member: { id: 'mem-1' }, team_member: null })
    expect(await callerCanReachTeammate(client, { ...BASE, teammate: ROLE })).toBe(false)
  })

  it('refused: the team reads as missing (RLS hides a private team, or another workspace’s), no team, no member row', async () => {
    expect(await callerCanReachTeammate(fakeSupabase({ team: null }).client, { ...BASE, teammate: ROLE })).toBe(false)
    expect(await callerCanReachTeammate(fakeSupabase({}).client, { ...BASE, teammate: { isSystem: false, teamId: null } })).toBe(false)
    const noMember = fakeSupabase({ team: { is_private: true }, member: null, team_member: { team_id: 'team-sales' } })
    expect(await callerCanReachTeammate(noMember.client, { ...BASE, teammate: ROLE })).toBe(false)
    expect(noMember.calls.map((c) => c.table)).toEqual(['team', 'member'])
  })

  it('a known member id skips the member read; null means none', async () => {
    const known = fakeSupabase({ team: { is_private: true }, team_member: { team_id: 'team-sales' } })
    expect(await callerCanReachTeammate(known.client, { ...BASE, teammate: ROLE, memberId: 'mem-9' })).toBe(true)
    expect(known.calls.map((c) => c.table)).toEqual(['team', 'team_member'])
    expect(known.calls[1].eqs).toEqual([['team_id', 'team-sales'], ['member_id', 'mem-9']])
    const none = fakeSupabase({ team: { is_private: true }, team_member: { team_id: 'team-sales' } })
    expect(await callerCanReachTeammate(none.client, { ...BASE, teammate: ROLE, memberId: null })).toBe(false)
  })

  it('throws on a query error (the caller decides: a 500, or a closed door)', async () => {
    await expect(callerCanReachTeammate(fakeSupabase({ team: { error: 'db down' } }).client, { ...BASE, teammate: ROLE })).rejects.toThrow(/team lookup failed/)
    await expect(
      callerCanReachTeammate(fakeSupabase({ team: { is_private: true }, member: { id: 'm' }, team_member: { error: 'x' } }).client, { ...BASE, teammate: ROLE }),
    ).rejects.toThrow(/team membership lookup failed/)
  })
})

// ── Many at once (bots-v4 Phase C): each roster entry's `reachable` ──────────
describe('callerReachableTeammateIds — callerCanReachTeammate’s rule, for a roster', () => {
  /** A caller (mem-1 in ws-1, mem-9 in ws-9) and a roster over public, private and missing teams. */
  function world() {
    const db = makeFakeSupabase({ project: true })
    db.seed('team', [
      { id: 'team-open', workspace_id: 'ws-1', is_private: false },
      { id: 'team-mine', workspace_id: 'ws-1', is_private: true },
      { id: 'team-theirs', workspace_id: 'ws-1', is_private: true },
      { id: 'team-null', workspace_id: 'ws-1', is_private: null },
      { id: 'team-ws9', workspace_id: 'ws-9', is_private: true },
    ])
    db.seed('member', [
      { id: 'mem-1', user_id: 'user-1', workspace_id: 'ws-1' },
      { id: 'mem-9', user_id: 'user-1', workspace_id: 'ws-9' },
      { id: 'mem-other', user_id: 'user-2', workspace_id: 'ws-1' },
    ])
    db.seed('team_member', [
      { team_id: 'team-mine', member_id: 'mem-1' },
      { team_id: 'team-theirs', member_id: 'mem-other' },
      { team_id: 'team-ws9', member_id: 'mem-9' },
    ])
    return db
  }
  const t = (id: string, teamId: string | null, over: { isSystem?: boolean; workspaceId?: string } = {}) => ({
    id,
    workspaceId: over.workspaceId ?? 'ws-1',
    isSystem: over.isSystem ?? false,
    teamId,
  })

  it('a system teammate, a public team’s, and a private team’s you hold a seat on are reachable; the rest are not', async () => {
    const db = world()
    const reachable = await callerReachableTeammateIds(db as never, {
      userId: 'user-1',
      teammates: [
        t('triage', null, { isSystem: true }),
        t('open', 'team-open'),
        t('mine', 'team-mine'),
        t('theirs', 'team-theirs'), // an owner/admin sees it under RLS, but holds no seat
        t('null-private', 'team-null'), // not an explicit false: private
        t('no-team', null),
        t('missing', 'team-gone'), // hidden by RLS, or deleted
        t('wrong-ws', 'team-open', { workspaceId: 'ws-2' }), // a team of another workspace
        t('ws9', 'team-ws9', { workspaceId: 'ws-9' }), // its own workspace's seat counts
      ],
    })
    expect([...reachable].sort()).toEqual(['mine', 'open', 'triage', 'ws9'])
  })

  it('reads at most three times whatever the roster, and only what it needs', async () => {
    const db = world()
    await callerReachableTeammateIds(db as never, { userId: 'user-1', teammates: [t('a', 'team-open'), t('b', 'team-open'), t('c', 'team-mine'), t('d', 'team-theirs')] })
    expect(db.calls.map((c) => c.table)).toEqual(['team', 'member', 'team_member'])
    const systemOnly = world()
    await callerReachableTeammateIds(systemOnly as never, { userId: 'user-1', teammates: [t('s', null, { isSystem: true })] })
    expect(systemOnly.calls).toHaveLength(0)
    const publicOnly = world()
    await callerReachableTeammateIds(publicOnly as never, { userId: 'user-1', teammates: [t('a', 'team-open')] })
    expect(publicOnly.calls.map((c) => c.table)).toEqual(['team'])
  })

  it('agrees with the single check, case for case', async () => {
    const cases = [t('open', 'team-open'), t('mine', 'team-mine'), t('theirs', 'team-theirs'), t('null-private', 'team-null'), t('missing', 'team-gone')]
    const many = await callerReachableTeammateIds(world() as never, { userId: 'user-1', teammates: cases })
    for (const c of cases) {
      const one = await callerCanReachTeammate(world() as never, { userId: 'user-1', workspaceId: c.workspaceId, teammate: { isSystem: c.isSystem, teamId: c.teamId } })
      expect(many.has(c.id), c.id).toBe(one)
    }
  })
})
