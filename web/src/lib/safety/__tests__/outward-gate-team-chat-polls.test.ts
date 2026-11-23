/**
 * A channel poll posted by the agent (docs/plans/channels-inbox.md, phase 3)
 * always waits on the person's card: the gate holds every post_team_chat_poll
 * call, the card says the poll as the call gives it, and there is no way
 * around it by name (a connector's prefix is still the tool).
 */
import { describe, expect, it } from 'vitest'
import { outwardHoldOf } from '../outward-gate'

const input = { channel_id: '55555555-5555-4555-8555-555555555555', question: 'Lunch on Friday?', options: ['Tacos', 'Ramen'], multiple: true, anonymous: true, closes_in_hours: 24 }

describe('post_team_chat_poll at the outward gate', () => {
  it('is always held, with the poll on the card', async () => {
    const hold = await outwardHoldOf({ workspaceId: 'ws', toolName: 'post_team_chat_poll', input })
    expect(hold?.reason).toBe('team_chat_poll')
    expect(hold?.card.title).toBe('Post a poll: "Lunch on Friday?"')
    expect(hold?.card.why).toContain('Tacos · Ramen')
    expect(hold?.card.why).toContain('people can pick more than one, anonymous')
    expect(hold?.card.why).toContain('closes in 24 hours')
    expect(hold?.refusal).toMatch(/Nothing was posted/)
  })
  it('holds a call with junk input too (the card says what it can)', async () => {
    const hold = await outwardHoldOf({ workspaceId: 'ws', toolName: 'post_team_chat_poll', input: null })
    expect(hold?.reason).toBe('team_chat_poll')
    expect(hold?.card.title).toBe('Post a poll: "a poll"')
  })
  it('the read is never held', async () => {
    expect(await outwardHoldOf({ workspaceId: 'ws', toolName: 'read_team_chat_poll', input: { poll_id: 'x' } })).toBeNull()
  })
})
