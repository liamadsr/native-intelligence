/**
 * Role routing (B PR 4): the teammate a role's work goes to — unattended (the
 * gate) or for a person's Start — and the card's own named teammate first.
 */
import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'
import { resolveRoleTeammate, resolveStartTeammate, roleDefaultTeammateId } from '../role-routing'

function mate(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: 'w1',
    name: id,
    role: 'writer',
    autonomy: 'propose',
    allowed_side_effects: ['read'],
    is_system: false,
    created_at: '2026-09-01T00:00:00.000Z',
    ...over,
  }
}

describe('resolveRoleTeammate', () => {
  it('service delegation explicitly checks requester membership and private-team access', async () => {
    const fake = makeFakeSupabase()
    fake.seed('member', [{ id: 'm1', workspace_id: 'w1', user_id: 'u1' }])
    fake.seed('team', [{ id: 'private', workspace_id: 'w1', is_private: true }])
    fake.seed('ai_team_member', [mate('writer', { team_id: 'private' })])
    const args = { workspaceId: 'w1', role: 'writer' as const, purpose: 'start' as const, requestingUserId: 'u1' }
    expect(await resolveRoleTeammate(fake as never, args)).toMatchObject({ teammate: null })
    fake.seed('team_member', [{ team_id: 'private', member_id: 'm1' }])
    expect(await resolveRoleTeammate(fake as never, args)).toMatchObject({ teammate: { id: 'writer' } })
    fake.rows('member').splice(0)
    expect(await resolveRoleTeammate(fake as never, args)).toHaveProperty('error')
  })

  it('unattended: the oldest teammate that attempts and may draft, with the whole roster for the breaker', async () => {
    const fake = makeFakeSupabase()
    fake.seed('ai_team_member', [
      mate('newest', { autonomy: 'attempt', allowed_side_effects: ['read', 'internal-write'], created_at: '2026-09-03T00:00:00.000Z' }),
      mate('reader', { autonomy: 'attempt', allowed_side_effects: ['read'], created_at: '2026-09-01T00:00:00.000Z' }),
      mate('drafter', { autonomy: 'attempt', allowed_side_effects: ['read', 'internal-write'], created_at: '2026-09-02T00:00:00.000Z' }),
      mate('proposer', { created_at: '2026-08-01T00:00:00.000Z' }),
      mate('other-role', { role: 'researcher', autonomy: 'attempt', allowed_side_effects: ['internal-write'] }),
      mate('other-ws', { workspace_id: 'w2', autonomy: 'attempt', allowed_side_effects: ['internal-write'] }),
    ])
    const routed = await resolveRoleTeammate(fake as never, { workspaceId: 'w1', role: 'writer', purpose: 'attempt' })
    expect('teammate' in routed && routed.teammate?.id).toBe('drafter')
    expect('roster' in routed && routed.roster.map((m) => m.id)).toEqual(['proposer', 'reader', 'drafter', 'newest'])
  })

  it('unattended refusals keep the gate’s order: none, none attempting, none that may draft', async () => {
    const none = makeFakeSupabase()
    expect(await resolveRoleTeammate(none as never, { workspaceId: 'w1', role: 'writer', purpose: 'attempt' })).toMatchObject({ teammate: null, reason: 'no_teammate' })
    const proposing = makeFakeSupabase()
    proposing.seed('ai_team_member', [mate('a')])
    expect(await resolveRoleTeammate(proposing as never, { workspaceId: 'w1', role: 'writer', purpose: 'attempt' })).toMatchObject({ teammate: null, reason: 'teammate_not_attempt' })
    const reading = makeFakeSupabase()
    reading.seed('ai_team_member', [mate('a', { autonomy: 'attempt' })])
    expect(await resolveRoleTeammate(reading as never, { workspaceId: 'w1', role: 'writer', purpose: 'attempt' })).toMatchObject({ teammate: null, reason: 'teammate_cannot_draft' })
  })

  it('a person’s Start: the oldest teammate holding the role that is not switched off', async () => {
    const fake = makeFakeSupabase()
    fake.seed('ai_team_member', [
      mate('off', { autonomy: 'off', created_at: '2026-08-01T00:00:00.000Z' }),
      mate('proposer', { created_at: '2026-09-01T00:00:00.000Z' }),
      mate('attempter', { autonomy: 'attempt', created_at: '2026-09-02T00:00:00.000Z' }),
    ])
    const routed = await resolveRoleTeammate(fake as never, { workspaceId: 'w1', role: 'writer', purpose: 'start' })
    expect('teammate' in routed && routed.teammate?.id).toBe('proposer')
    const allOff = makeFakeSupabase()
    allOff.seed('ai_team_member', [mate('off', { autonomy: 'off' })])
    expect(await resolveRoleTeammate(allOff as never, { workspaceId: 'w1', role: 'writer', purpose: 'start' })).toMatchObject({ teammate: null, reason: 'teammate_off' })
  })

  // The chat admission RPC (_admit_chat_work_delegation, migration 299) routes
  // the same way; scripts/check-chat-delegation-sql.mjs pins the SQL half.
  describe('a handoff (delegate): enabled, visible, non-system, and may draft — oldest first', () => {
    function visible() {
      const fake = makeFakeSupabase()
      fake.seed('member', [{ id: 'm1', workspace_id: 'w1', user_id: 'u1' }])
      fake.seed('team', [{ id: 'open', workspace_id: 'w1', is_private: false }, { id: 'hidden', workspace_id: 'w1', is_private: true }])
      return fake
    }
    const args = { workspaceId: 'w1', role: 'writer' as const, purpose: 'delegate' as const, requestingUserId: 'u1' }
    const draft = ['read', 'internal-write']

    it('takes the oldest holder that may draft, skipping older read-only, off, system and hidden ones', async () => {
      const fake = visible()
      fake.seed('ai_team_member', [
        mate('reader', { team_id: 'open', autonomy: 'attempt', created_at: '2026-01-01T00:00:00.000Z' }),
        mate('off', { team_id: 'open', autonomy: 'off', allowed_side_effects: draft, created_at: '2026-01-02T00:00:00.000Z' }),
        mate('system', { team_id: 'open', is_system: true, allowed_side_effects: draft, created_at: '2026-01-03T00:00:00.000Z' }),
        // A work bot holds no role (its CHECK, migration 302), so no handoff reaches it.
        mate('work-bot', { team_id: 'open', role: null, fronts_only: true, allowed_side_effects: draft, created_at: '2026-01-03T12:00:00.000Z' }),
        mate('hidden', { team_id: 'hidden', allowed_side_effects: draft, created_at: '2026-01-04T00:00:00.000Z' }),
        mate('drafter', { team_id: 'open', allowed_side_effects: draft, created_at: '2026-02-01T00:00:00.000Z' }),
        mate('younger', { team_id: 'open', allowed_side_effects: draft, created_at: '2026-03-01T00:00:00.000Z' }),
      ])
      expect(await resolveRoleTeammate(fake as never, args)).toMatchObject({ teammate: { id: 'drafter' } })
    })

    it('filters in the query, so a long roster of holders that cannot draft never hides one that can', async () => {
      const fake = visible()
      fake.seed('ai_team_member', [
        ...Array.from({ length: 25 }, (_, i) => mate(`reader-${i}`, { team_id: 'open', created_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` })),
        mate('drafter', { team_id: 'open', allowed_side_effects: draft, created_at: '2026-03-01T00:00:00.000Z' }),
      ])
      expect(await resolveRoleTeammate(fake as never, args)).toMatchObject({ teammate: { id: 'drafter' } })
    })

    it('refuses clearly: enabled holders that cannot draft, or none at all; and needs a requester', async () => {
      const readers = visible()
      readers.seed('ai_team_member', [mate('reader', { team_id: 'open' })])
      expect(await resolveRoleTeammate(readers as never, args)).toMatchObject({ teammate: null, reason: 'teammate_cannot_draft' })
      const none = visible()
      none.seed('ai_team_member', [mate('off', { team_id: 'open', autonomy: 'off', allowed_side_effects: draft }), mate('hidden', { team_id: 'hidden', allowed_side_effects: draft })])
      expect(await resolveRoleTeammate(none as never, args)).toMatchObject({ teammate: null, reason: 'no_teammate' })
      expect(await resolveRoleTeammate(none as never, { ...args, requestingUserId: undefined })).toHaveProperty('error')
    })
  })
})

describe('roleDefaultTeammateId', () => {
  it('the oldest holder of the role, whatever its autonomy; id breaks a created_at tie', async () => {
    const fake = makeFakeSupabase()
    fake.seed('ai_team_member', [
      mate('newest', { role: 'correspondent', autonomy: 'attempt', created_at: '2026-09-03T00:00:00.000Z' }),
      mate('tie-b', { role: 'correspondent', created_at: '2026-09-02T00:00:00.000Z' }),
      mate('tie-a', { role: 'correspondent', autonomy: 'off', created_at: '2026-09-02T00:00:00.000Z' }),
      mate('older-writer', { created_at: '2026-08-01T00:00:00.000Z' }),
      mate('other-ws', { role: 'correspondent', workspace_id: 'w2', created_at: '2026-08-01T00:00:00.000Z' }),
    ])
    expect(await roleDefaultTeammateId(fake as never, 'w1', 'correspondent')).toBe('tie-a')
    expect(await roleDefaultTeammateId(fake as never, 'w1', 'writer')).toBe('older-writer')
    expect(await roleDefaultTeammateId(fake as never, 'w2', 'correspondent')).toBe('other-ws')
  })

  it('null when no teammate holds the role; a system row never counts', async () => {
    const fake = makeFakeSupabase()
    fake.seed('ai_team_member', [
      // System teammates hold no role (a CHECK, migration 283)...
      mate('email-drafts', { role: null, is_system: true, system_key: 'email_drafts', created_at: '2026-01-01T00:00:00.000Z' }),
      // ...and the is_system fence would keep one out even if it did.
      mate('system-with-role', { role: 'correspondent', is_system: true, created_at: '2026-01-01T00:00:00.000Z' }),
      mate('writer'),
    ])
    expect(await roleDefaultTeammateId(fake as never, 'w1', 'correspondent')).toBeNull()
  })

  it('throws on a failed read, so the caller picks its own fallback', async () => {
    const failing = {
      from: () => {
        const chain: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = () => chain
        chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve)
        return chain
      },
    }
    await expect(roleDefaultTeammateId(failing as never, 'w1', 'correspondent')).rejects.toThrow('boom')
  })
})

describe('resolveStartTeammate', () => {
  function world() {
    const fake = makeFakeSupabase()
    fake.seed('ai_team_member', [
      mate('writer-default', { created_at: '2026-09-01T00:00:00.000Z' }),
      mate('named', { role: 'researcher' }),
      mate('named-no-role', { role: null }),
      mate('system', { role: null, is_system: true }),
      // A work bot (bots-v3 Phase 3): fronts loops, takes no work.
      mate('work-bot', { role: null, fronts_only: true }),
      mate('named-off', { autonomy: 'off' }),
      mate('elsewhere', { workspace_id: 'w2' }),
    ])
    return fake
  }

  it('takes the teammate the card names, even one with no role', async () => {
    expect((await resolveStartTeammate(world() as never, { workspaceId: 'w1', payload: { assignee_ai_member_id: 'named', role: 'writer' } }))?.id).toBe('named')
    expect((await resolveStartTeammate(world() as never, { workspaceId: 'w1', payload: { assignee_ai_member_id: 'named-no-role' } }))).toMatchObject({ id: 'named-no-role', role: null })
  })

  it('never a system teammate, a work bot, a switched-off one or another workspace’s: falls back to the role’s default', async () => {
    for (const named of ['system', 'work-bot', 'named-off', 'elsewhere', 'missing']) {
      expect((await resolveStartTeammate(world() as never, { workspaceId: 'w1', payload: { assignee_ai_member_id: named, role: 'writer' } }))?.id, named).toBe('writer-default')
    }
  })

  it('no teammate named and no role (or an unknown one): no one, as before', async () => {
    expect(await resolveStartTeammate(world() as never, { workspaceId: 'w1', payload: {} })).toBeNull()
    expect(await resolveStartTeammate(world() as never, { workspaceId: 'w1', payload: { role: 'astronaut' } })).toBeNull()
  })

  it('a failed read routes to no one instead of blocking the Start', async () => {
    const broken = { from: () => { throw new Error('boom') } }
    expect(await resolveStartTeammate(broken as never, { workspaceId: 'w1', payload: { role: 'writer' } })).toBeNull()
  })
})
