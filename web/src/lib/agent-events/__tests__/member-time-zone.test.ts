/**
 * member.time_zone (migration 336), saved by the chat spec from the turn's
 * checked zone: only a real IANA zone the column's check accepts, only on the
 * person's own member row in that workspace, only when it differs; never
 * throwing.
 */
import { describe, it, expect, vi } from 'vitest'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { isStorableTimeZone, saveMemberTimeZone } from '../member-time-zone'

describe('saveMemberTimeZone', () => {
  it('writes a checked zone that differs, on the person’s row in that workspace only', async () => {
    const db = makeFakeSupabase()
    db.seed('member', [
      { id: 'm1', workspace_id: 'w1', user_id: 'u1', time_zone: null },
      { id: 'm2', workspace_id: 'w2', user_id: 'u1', time_zone: null },
    ])
    expect(await saveMemberTimeZone(db as never, { workspaceId: 'w1', userId: 'u1', timeZone: 'Europe/London' })).toBe(true)
    expect(db.rows('member').map((m) => m.time_zone)).toEqual(['Europe/London', null])
    // Same zone again: no write.
    expect(await saveMemberTimeZone(db as never, { workspaceId: 'w1', userId: 'u1', timeZone: 'Europe/London' })).toBe(false)
    expect(db.calls.filter((c) => c.op === 'update')).toHaveLength(1)
  })

  it('refuses an unchecked zone, a missing member, and never throws', async () => {
    const db = makeFakeSupabase()
    db.seed('member', [{ id: 'm1', workspace_id: 'w1', user_id: 'u1' }])
    expect(isStorableTimeZone('Mars/Olympus')).toBe(false)
    expect(await saveMemberTimeZone(db as never, { workspaceId: 'w1', userId: 'u1', timeZone: 'Mars/Olympus' })).toBe(false)
    expect(await saveMemberTimeZone(db as never, { workspaceId: 'w1', userId: 'nobody', timeZone: 'UTC' })).toBe(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await saveMemberTimeZone({ from: () => { throw new Error('down') } } as never, { workspaceId: 'w1', userId: 'u1', timeZone: 'UTC' })).toBe(false)
    warn.mockRestore()
  })
})
