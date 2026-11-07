import { describe, it, expect } from 'vitest'
import { nudgeChannelName, NUDGE_EVENT } from '../nudge-channel'
import { LIVE_AGENT_READ_TOOLS } from '../read-tool-names'

/**
 * The live agent's "talk back" channel: an ephemeral Realtime broadcast (no DB).
 * These guard the contract the HUD relay depends on — the channel is scoped to
 * one capture, and say_to_user is NOT a read/mutation tool (it's display-only).
 */

describe('nudgeChannelName', () => {
  it('scopes the channel to a single capture id', () => {
    expect(nudgeChannelName('cap-123')).toBe('agent-nudge:cap-123')
    // Different captures → different channels (no cross-meeting bleed).
    expect(nudgeChannelName('a')).not.toBe(nudgeChannelName('b'))
  })

  it('uses a stable event name', () => {
    expect(NUDGE_EVENT).toBe('nudge')
  })
})

describe('say_to_user vs the read surface', () => {
  it('is NOT in the read allowlist (it is a display tool, not a read or write)', () => {
    // say_to_user must never be reachable via the read-discovery ceiling — it's a
    // first-class staging-side tool, always active, never something search_tools
    // surfaces. (It also writes nothing, so it has no business in the read set.)
    expect(LIVE_AGENT_READ_TOOLS.has('say_to_user')).toBe(false)
  })
})
