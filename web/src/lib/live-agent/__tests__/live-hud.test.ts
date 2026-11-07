// @vitest-environment jsdom
/**
 * The live agent HUD chat's protocol: what crosses a window is checked, and
 * the recording context's announcement of a capture's conversation is
 * remembered, so a reader that comes later still finds it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LIVE_CAPTURE_CONVERSATION_EVENT,
  __resetLiveCaptureConversationsForTests,
  announcedLiveConversation,
  readLiveHudConversation,
  readLiveHudFlush,
  readLiveHudFlushed,
  subscribeLiveCaptureConversations,
} from '../live-hud'

beforeEach(() => __resetLiveCaptureConversationsForTests())

describe('readers', () => {
  it('take only well-formed payloads', () => {
    expect(readLiveHudConversation({ captureId: 'c', conversationId: 'v', agentId: '', workspaceId: 'w' })).toEqual({
      captureId: 'c',
      conversationId: 'v',
      agentId: null,
      workspaceId: 'w',
    })
    expect(readLiveHudConversation({ captureId: 'c' })).toBeNull()
    expect(readLiveHudConversation('nope')).toBeNull()
    expect(readLiveHudFlush({ captureId: 'c', id: 'f' })).toEqual({ captureId: 'c', id: 'f' })
    expect(readLiveHudFlush({ id: 'f' })).toBeNull()
    expect(readLiveHudFlushed({ id: 'f' })).toBe('f')
    expect(readLiveHudFlushed(null)).toBeNull()
  })
})

describe('the announcement, remembered', () => {
  const announce = (detail: unknown) => window.dispatchEvent(new CustomEvent(LIVE_CAPTURE_CONVERSATION_EVENT, { detail }))

  it('keeps the latest per capture and tells subscribers of a change only', () => {
    const listener = vi.fn()
    const off = subscribeLiveCaptureConversations(listener)
    announce({ conversationId: 'conv-1', captureId: 'cap-1', recipeId: 'agent-1' })
    expect(announcedLiveConversation('cap-1')).toEqual({ captureId: 'cap-1', conversationId: 'conv-1', agentId: 'agent-1' })
    announce({ conversationId: 'conv-1', captureId: 'cap-1', cwd: '/x', recipeId: 'agent-1' })
    expect(listener).toHaveBeenCalledTimes(1)
    // The agent re-pinned mid-call.
    announce({ conversationId: 'conv-1', captureId: 'cap-1', cwd: null, recipeId: null })
    expect(announcedLiveConversation('cap-1')!.agentId).toBeNull()
    expect(listener).toHaveBeenCalledTimes(2)
    announce({ captureId: 'cap-1' })
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    expect(announcedLiveConversation('cap-2')).toBeNull()
    expect(announcedLiveConversation(null)).toBeNull()
  })
})
