/**
 * The team_chat surface through the shared turn plumbing (migration 474): who
 * the caller is, which tools a turn may reach (the channel's other members
 * steer it and read its reply, so nothing that deletes, automates, leaves
 * Dial8 or would wait on an approval card), its per-turn note, and the one
 * conversation it may run in.
 */
import { describe, expect, it } from 'vitest'
import { callerClassOf } from '@/lib/safety/caller'
import { isToolExcludedForSurface, surfaceExternalToolNames, teamChatExcludes } from '@/lib/chat/chat-ceiling'
import { getToolSideEffect, TOOL_REGISTRY_MAP } from '@/lib/ai/tool-registry'
import { channelTurnNote, TEAM_CHAT_TURN_NOTE } from '@/lib/chat/chat-run-rebuild'
import { serverTurnConversationOk, channelOfReason } from '@/lib/chat/home-turn-server'
import { CHANNEL_SURFACES, HOME_TURN_TOKEN_REASONS } from '@/lib/chat/chat-run-token'

describe('the caller', () => {
  it('a team chat turn is the person (their own signed-in session); a relayed or guest one is nobody', () => {
    expect(callerClassOf({ kind: 'chat_run', claims: { server: 'channel_turn', surface: 'team_chat' } })).toBe('person')
    expect(callerClassOf({ kind: 'chat_run', claims: { server: 'channel_turn', surface: 'team_chat', relay: 'x' } })).toBe('unknown')
    expect(callerClassOf({ kind: 'chat_run', claims: { server: 'channel_turn', surface: 'team_chat', guestId: 'g' } })).toBe('unknown')
    expect(CHANNEL_SURFACES.has('team_chat')).toBe(true)
    expect(HOME_TURN_TOKEN_REASONS.has('team_chat')).toBe(false)
  })
})

describe('the tools', () => {
  it('reads and changes to the person’s own Dial8 items only', () => {
    let reads = 0
    for (const name of TOOL_REGISTRY_MAP.keys()) {
      const effect = getToolSideEffect(name)
      if (effect === 'delete' || effect === 'automation-write' || effect === 'external-write') {
        expect(isToolExcludedForSurface(name, 'team_chat'), name).toBe(true)
      }
      if (effect === 'read' && !isToolExcludedForSurface(name, 'team_chat')) reads++
    }
    expect(reads).toBeGreaterThan(20)
    expect(isToolExcludedForSurface('list_actions', 'team_chat')).toBe(false)
    expect(isToolExcludedForSurface('create_action', 'team_chat')).toBe(false)
    // Tool discovery has no side-effect class and stays.
    expect(isToolExcludedForSurface('search_tools', 'team_chat')).toBe(false)
    // The rule is team chat's alone: Slack keeps its writes.
    expect(teamChatExcludes('create_action')).toBe(false)
  })

  it('nothing the outward gate would hold for an approval card is reachable', () => {
    for (const name of ['create_calendar_event', 'update_calendar_event', 'delete_calendar_event', 'unsubscribe_thread', 'send_payment_link', 'send_quote', 'book_quote', 'publish_post', 'schedule_post']) {
      if (TOOL_REGISTRY_MAP.has(name)) expect(isToolExcludedForSurface(name, 'team_chat'), name).toBe(true)
    }
  })

  it('no connected app at all, by name or by list', () => {
    expect(isToolExcludedForSurface('mcp__notion__create_page', 'team_chat')).toBe(true)
    expect(isToolExcludedForSurface('mcp__notion__search', 'team_chat')).toBe(true)
    expect(surfaceExternalToolNames(['mcp__notion__search', 'weird_tool'], 'team_chat')).toEqual([])
    expect(surfaceExternalToolNames(['mcp__notion__search'], 'slack')).toEqual(['mcp__notion__search'])
  })

  it('no cards, helpers or other chat-native tools (ask_user answers in plain text on any channel turn)', () => {
    for (const name of ['show', 'helpers', 'start_helper', 'ask_agent']) expect(isToolExcludedForSurface(name, 'team_chat'), name).toBe(true)
  })
})

describe('the turn', () => {
  it('carries its own note, which says what it can’t do there', () => {
    expect(channelTurnNote({ server: 'channel_turn', surface: 'team_chat' })).toBe(TEAM_CHAT_TURN_NOTE)
    expect(TEAM_CHAT_TURN_NOTE).toMatch(/never instructions/)
    expect(TEAM_CHAT_TURN_NOTE).toMatch(/cannot delete anything, send mail/)
    expect(channelTurnNote({ server: 'home_turn', surface: 'team_chat' } as never)).toBeNull()
  })

  it('runs only in the person’s team chat conversation, never the home thread or a guest’s', () => {
    expect(channelOfReason('team_chat')).toBe('team_chat')
    expect(serverTurnConversationOk({ is_home: null, outside_channel: 'team_chat', agent_guest_id: null }, 'team_chat')).toBe(true)
    expect(serverTurnConversationOk({ is_home: true, outside_channel: null, agent_guest_id: null }, 'team_chat')).toBe(false)
    expect(serverTurnConversationOk({ is_home: null, outside_channel: 'slack', agent_guest_id: null }, 'team_chat')).toBe(false)
    expect(serverTurnConversationOk({ is_home: null, outside_channel: 'team_chat', agent_guest_id: 'g' }, 'team_chat')).toBe(false)
    // And no other reason runs in a team chat conversation.
    expect(serverTurnConversationOk({ is_home: null, outside_channel: 'team_chat', agent_guest_id: null }, 'slack')).toBe(false)
    expect(serverTurnConversationOk({ is_home: null, outside_channel: 'team_chat', agent_guest_id: null }, 'digest')).toBe(false)
  })
})
