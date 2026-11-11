/**
 * Availability sharing (../sharing.ts, member.availability_sharing,
 * migration 552): busy_only or none, read and saved on the person's own
 * member row in one workspace; anything unreadable shares nothing.
 */
import { describe, expect, it } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { isAvailabilitySharing, readSharing, readSharingValue, saveSharing } from '../sharing'

const ADA = { userId: 'user-ada', workspaceId: 'ws-fernhill' }

const tables = () => ({
  member: [
    { id: 'm-ada', user_id: 'user-ada', workspace_id: 'ws-fernhill', availability_sharing: 'busy_only' },
    { id: 'm-ada-2', user_id: 'user-ada', workspace_id: 'ws-other', availability_sharing: 'busy_only' },
    { id: 'm-dana', user_id: 'user-dana', workspace_id: 'ws-fernhill', availability_sharing: 'busy_only' },
  ],
})

describe('the values', () => {
  it('busy_only and none only; anything else reads as none', () => {
    expect(isAvailabilitySharing('busy_only')).toBe(true)
    expect(isAvailabilitySharing('none')).toBe(true)
    expect(isAvailabilitySharing('everything')).toBe(false)
    expect(readSharingValue('busy_only')).toBe('busy_only')
    for (const odd of ['none', null, undefined, 'BUSY_ONLY', 1]) expect(readSharingValue(odd)).toBe('none')
  })
})

describe('read and save', () => {
  it("changes only the person's own row in that workspace", async () => {
    const t = tables()
    const supabase = memoryDb(t)
    expect(await readSharing(supabase, ADA)).toBe('busy_only')
    expect(await saveSharing(supabase, ADA, 'none')).toBe('none')
    expect(await readSharing(supabase, ADA)).toBe('none')
    expect(t.member.map((r) => [r.id, r.availability_sharing])).toEqual([
      ['m-ada', 'none'],
      ['m-ada-2', 'busy_only'],
      ['m-dana', 'busy_only'],
    ])
  })

  it('refuses a bad value, and someone who is not a member there', async () => {
    const supabase = memoryDb(tables())
    await expect(saveSharing(supabase, ADA, 'everyone' as never)).rejects.toThrow(/'busy_only' or 'none'/)
    await expect(saveSharing(supabase, { userId: 'user-stranger', workspaceId: 'ws-fernhill' }, 'none')).rejects.toThrow('Not a member of this workspace')
    await expect(readSharing(supabase, { userId: 'user-stranger', workspaceId: 'ws-fernhill' })).rejects.toThrow('Not a member of this workspace')
  })

  it('a failed read throws, never guesses', async () => {
    const failing = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'timeout' } }) }) }) }) }) } as never
    await expect(readSharing(failing, ADA)).rejects.toThrow('Availability sharing could not be read: timeout')
  })
})
