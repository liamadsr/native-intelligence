// @vitest-environment jsdom
/**
 * A home-thread message as a notice names it (lib/chat/home-message.ts):
 * only the router's `agent_message` names one, its ids are checked, and the
 * window event carries it to the chat as it was announced.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { HOME_MESSAGE_EVENT, announceHomeMessage, homeMessageOfNotice, parseHomeMessageDetail, parseRevealDetail } from '../home-message'

const WS = '33333333-3333-4333-8333-333333333333'
const HOME = '11111111-1111-4111-8111-111111111111'

describe('homeMessageOfNotice', () => {
  it('an agent_message names its thread and message', () => {
    expect(homeMessageOfNotice({ type: 'agent_message', workspace_id: WS, metadata: { conversation_id: HOME, message_id: 'home-turn:1' } })).toEqual({
      workspaceId: WS,
      conversationId: HOME,
      messageId: 'home-turn:1',
    })
  })

  it('one written before it carried the message id names the thread alone', () => {
    expect(homeMessageOfNotice({ type: 'agent_message', workspace_id: WS, metadata: { conversation_id: HOME, home_message_id: 'row' } })).toEqual({
      workspaceId: WS,
      conversationId: HOME,
      messageId: null,
    })
  })

  it('anything else names nothing: another type, no thread, a garbled id', () => {
    expect(homeMessageOfNotice({ type: 'agent_digest', workspace_id: WS, metadata: { conversation_id: HOME } })).toBeNull()
    expect(homeMessageOfNotice({ type: 'agent_message', workspace_id: WS, metadata: {} })).toBeNull()
    expect(homeMessageOfNotice({ type: 'agent_message', metadata: { conversation_id: HOME } })).toBeNull()
    expect(homeMessageOfNotice({ type: 'agent_message', workspace_id: WS, metadata: { conversation_id: 'x'.repeat(65) } })).toBeNull()
    expect(homeMessageOfNotice({ type: 'agent_message', workspace_id: WS, metadata: { conversation_id: 7 } })).toBeNull()
    expect(homeMessageOfNotice({ type: 'agent_message', workspace_id: WS, metadata: null })).toBeNull()
    expect(homeMessageOfNotice(null)).toBeNull()
  })

  it('an over-long or empty message id is no id', () => {
    expect(homeMessageOfNotice({ type: 'agent_message', workspace_id: WS, metadata: { conversation_id: HOME, message_id: 'x'.repeat(201) } })?.messageId).toBeNull()
    expect(homeMessageOfNotice({ type: 'agent_message', workspace_id: WS, metadata: { conversation_id: HOME, message_id: '' } })?.messageId).toBeNull()
  })
})

describe('the window event', () => {
  const heard: unknown[] = []
  const listen = (e: Event) => heard.push((e as CustomEvent).detail)
  afterEach(() => {
    window.removeEventListener(HOME_MESSAGE_EVENT, listen)
    heard.length = 0
  })

  it('carries the message as announced, and parses back', () => {
    window.addEventListener(HOME_MESSAGE_EVENT, listen)
    announceHomeMessage({ workspaceId: WS, conversationId: HOME, messageId: 'home-turn:1' })
    expect(heard).toHaveLength(1)
    expect(parseHomeMessageDetail(heard[0])).toEqual({ workspaceId: WS, conversationId: HOME, messageId: 'home-turn:1' })
    expect(parseHomeMessageDetail({ workspaceId: WS })).toBeNull()
    expect(parseHomeMessageDetail(null)).toBeNull()
  })

  it('a click’s reveal parses to its message, or none', () => {
    expect(parseRevealDetail({ messageId: 'home-turn:1' })).toEqual({ messageId: 'home-turn:1' })
    expect(parseRevealDetail({})).toEqual({ messageId: null })
    expect(parseRevealDetail(undefined)).toBeNull()
  })
})
