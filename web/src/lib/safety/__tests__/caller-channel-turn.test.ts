/**
 * A channel turn (a Slack DM from the person's linked account, decision 14)
 * is the person, not an unattended server turn: the class comes from the
 * verified token, and with it what the policy allows (an outward call is the
 * person's card, never a refusal). Anything else on the server principal
 * stays unattended, and an unknown channel fails closed.
 */
import { describe, expect, it } from 'vitest'
import { callerClassOf, decideAction, mayApprove } from '../caller'
import { SURFACE_EXCLUDED_TOOLS, serverTurnMayCall } from '@/lib/chat/chat-ceiling'

const chatRun = (claims: { server?: string; surface?: string; relay?: string }) => callerClassOf({ kind: 'chat_run', claims })

describe('callerClassOf: a channel turn', () => {
  it('a Slack DM is the person', () => {
    expect(chatRun({ server: 'channel_turn', surface: 'slack' })).toBe('person')
  })

  it('a channel turn naming no channel, or one it does not know, is unknown (fails closed)', () => {
    expect(chatRun({ server: 'channel_turn' })).toBe('unknown')
    expect(chatRun({ server: 'channel_turn', surface: 'device_ask' })).toBe('unknown')
    expect(chatRun({ server: 'channel_turn', surface: 'carrier-pigeon' })).toBe('unknown')
  })

  it('every other server principal stays unattended', () => {
    expect(chatRun({ server: 'home_turn' })).toBe('agent_unattended')
    expect(chatRun({ server: 'idle_compaction' })).toBe('agent_unattended')
  })

  it('so an outward call from Slack becomes the person’s card, and they may approve it themselves', () => {
    const caller = chatRun({ server: 'channel_turn', surface: 'slack' })
    expect(decideAction(caller, 'outward', 'create_calendar_event')).toBe('ask')
    expect(decideAction(caller, 'internal-write', 'create_action')).toBe('run')
    expect(mayApprove({ callerClass: caller, userId: 'u1' }, 'u1')).toBe(true)
    expect(mayApprove({ callerClass: caller, userId: 'u2' }, 'u1')).toBe(false)
  })
})

describe('the Slack surface’s ceiling', () => {
  const excluded = SURFACE_EXCLUDED_TOOLS.slack

  it('takes out everything that needs a screen, and the JWT tools a server token cannot serve', () => {
    for (const name of ['show', 'read_card', 'mcp_confirm_call', 'helpers', 'send_bot_message', 'settle_card', 'generate_email_drafts', 'draft_followup_email']) {
      expect(excluded.has(name), name).toBe(true)
    }
    // A background helper and a message to another person's agent stay: what comes back is posted to them in Slack (Liam, 2026-10-26).
    for (const name of ['start_helper', 'stop_helper', 'ask_agent']) expect(excluded.has(name), name).toBe(false)
  })

  it('keeps the person’s ordinary tools', () => {
    for (const name of ['list_actions', 'create_action', 'get_calendar_events', 'search']) expect(excluded.has(name), name).toBe(false)
  })

  it('a channel turn is not held to reads (its surface’s ceiling and the policy decide); nor is an acting home turn now, though a guest’s ask still is', () => {
    expect(serverTurnMayCall('create_action', 'channel_turn')).toBe(true)
    expect(serverTurnMayCall('create_action', 'home_turn', 'helper_report')).toBe(true)
    expect(serverTurnMayCall('create_action', 'home_turn', 'guest_ask')).toBe(false)
    expect(serverTurnMayCall('create_action', 'idle_compaction')).toBe(false)
  })
})
