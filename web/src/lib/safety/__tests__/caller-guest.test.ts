/**
 * The guest class (guest access, migration 427): a person the owner added,
 * texting the agent made for them. Pinned here: who is a guest (a text from
 * an activated guest's number, nobody's own), what the policy lets a guest's
 * agent do under each ask, that the guest-only tools are a guest's and
 * nobody else's, and that a guest never approves anything.
 */
import { describe, expect, it } from 'vitest'
import {
  CALLER_CLASSES,
  attendedOnlyToolsDeniedTo,
  bindReplyToApproval,
  callerClassOf,
  callerMayCall,
  channelCaller,
  decideAction,
  mayApprove,
  policyEffectOf,
  runAsUserFor,
} from '../caller'
import { ATTENDED_ONLY_TOOL_NAMES, CHAT_NATIVE_TOOL_NAMES } from '@/lib/ai/tool-registry'
import { GUEST_ONLY_TOOL_NAMES } from '@/lib/guests/tools'

const OWNER = 'user-owner'
const GUEST = 'guest-sam'

describe('who is a guest', () => {
  const sms = { channel: 'sms' as const, ownerUserId: OWNER, senderUserId: null, senderIsMember: false }

  it('a text from an activated guest’s number', () => {
    expect(channelCaller({ ...sms, senderGuestId: GUEST })).toBe('guest')
    expect(callerClassOf({ kind: 'channel', ...sms, senderGuestId: GUEST, place: 'direct' })).toBe('guest')
  })

  it('nobody else: no guest matched, a guest id on Slack or a call, no owner', () => {
    expect(channelCaller(sms)).toBe('unknown')
    expect(channelCaller({ ...sms, senderGuestId: '' })).toBe('unknown')
    expect(channelCaller({ ...sms, senderGuestId: null })).toBe('unknown')
    expect(channelCaller({ ...sms, channel: 'slack', senderGuestId: GUEST })).toBe('unknown')
    expect(channelCaller({ ...sms, channel: 'call', senderGuestId: GUEST })).toBe('unknown')
    expect(channelCaller({ ...sms, ownerUserId: '', senderGuestId: GUEST })).toBe('unknown')
  })

  it('a verified person’s own number is them, never a guest', () => {
    expect(channelCaller({ ...sms, senderUserId: OWNER, senderIsMember: true, senderGuestId: GUEST })).toBe('person_remote')
    expect(channelCaller({ ...sms, senderUserId: 'user-teammate', senderIsMember: true, senderGuestId: GUEST })).toBe('other_person')
  })

  it('a guest’s agent acts over the owner’s data', () => {
    expect(runAsUserFor('guest', { ownerUserId: OWNER, callerUserId: 'anyone' })).toBe(OWNER)
  })
})

describe('decideAction for a guest', () => {
  const household = { guest: { askBefore: ['payments', 'deletes'] } }
  const colleague = { guest: { askBefore: ['payments', 'deletes', 'changes'] } }
  const trusting = { guest: { askBefore: [] as string[] } }

  it('reads run', () => {
    for (const options of [household, colleague, trusting, {}]) {
      expect(decideAction('guest', 'read', 'get_calendar_events', options)).toBe('run')
      expect(decideAction('guest', 'read', 'list_actions', options)).toBe('run')
    }
  })

  it('Household: changes run, deletes ask', () => {
    expect(decideAction('guest', 'internal-write', 'create_action', household)).toBe('run')
    expect(decideAction('guest', 'external-write', 'create_calendar_event', household)).toBe('run')
    expect(decideAction('guest', 'delete', 'delete_calendar_event', household)).toBe('ask')
  })

  it('Colleague: every change asks', () => {
    expect(decideAction('guest', 'internal-write', 'create_action', colleague)).toBe('ask')
    expect(decideAction('guest', 'external-write', 'create_calendar_event', colleague)).toBe('ask')
    expect(decideAction('guest', 'delete', 'delete_calendar_event', colleague)).toBe('ask')
  })

  it('with deletes turned off, a delete runs', () => {
    expect(decideAction('guest', 'delete', 'delete_calendar_event', trusting)).toBe('run')
  })

  it('missing or malformed asks read as every ask (fail closed)', () => {
    expect(decideAction('guest', 'internal-write', 'create_action')).toBe('ask')
    expect(decideAction('guest', 'delete', 'delete_action', { guest: {} })).toBe('ask')
    expect(decideAction('guest', 'external-write', 'create_calendar_event', { guest: { askBefore: null } })).toBe('ask')
  })

  it('an outward call is the owner’s card unless they set the tool to Always allow', () => {
    for (const options of [household, colleague, trusting, {}]) {
      expect(decideAction('guest', 'outward', 'create_calendar_event', options)).toBe('ask')
    }
  })

  // Liam, 2026-11-02: "I should be able to decide what she can do".
  it('the owner’s Always allow for a tool runs it, an outward call or a delete included; "any change at all" still asks', () => {
    for (const askBefore of [['payments', 'deletes'], [], null]) {
      expect(decideAction('guest', 'outward', 'update_calendar_event', { guest: { askBefore: askBefore === null ? undefined : askBefore, allowed: true } }), String(askBefore)).toBe(askBefore === null ? 'ask' : 'run')
      expect(decideAction('guest', 'delete', 'delete_calendar_event', { guest: { askBefore: askBefore === null ? undefined : askBefore, allowed: true } }), String(askBefore)).toBe(askBefore === null ? 'ask' : 'run')
    }
    expect(decideAction('guest', 'outward', 'update_calendar_event', { guest: { askBefore: ['changes'], allowed: true } })).toBe('ask')
    // Never what is denied outright.
    expect(decideAction('guest', 'automation-write', 'create_flow', { guest: { askBefore: [], allowed: true } })).toBe('deny')
    expect(decideAction('guest', 'outward', 'mcp__gmail__send', { guest: { askBefore: [], allowed: true } })).toBe('deny')
  })

  it('never an outside app’s tool, an automation write, an attended-only or a main-chat tool', () => {
    expect(decideAction('guest', 'unclassified', 'mcp__linear__create_issue', trusting)).toBe('deny')
    expect(decideAction('guest', 'read', 'mcp__linear__list_issues', trusting)).toBe('deny')
    expect(decideAction('guest', 'outward', 'mcp__linear__create_issue', trusting)).toBe('deny')
    expect(decideAction('guest', 'automation-write', 'start_helper', trusting)).toBe('deny')
    expect(decideAction('guest', 'unclassified', 'some_tool_nobody_classified', trusting)).toBe('deny')
    for (const name of [...ATTENDED_ONLY_TOOL_NAMES, ...CHAT_NATIVE_TOOL_NAMES]) {
      expect(callerMayCall('guest', name, trusting), name).toBe(false)
    }
    expect(new Set(attendedOnlyToolsDeniedTo('guest'))).toEqual(new Set(ATTENDED_ONLY_TOOL_NAMES))
  })

  it('never the owner’s memory: remember is attended-only', () => {
    expect(callerMayCall('guest', 'remember', trusting)).toBe(false)
    expect(callerMayCall('guest', 'dial8_remember', trusting)).toBe(false)
  })

  it('the guest-only tools run for a guest and nobody else', () => {
    for (const name of GUEST_ONLY_TOOL_NAMES) {
      expect(policyEffectOf(name)).toBe('unclassified')
      expect(callerMayCall('guest', name), name).toBe(true)
      for (const caller of CALLER_CLASSES) {
        if (caller !== 'guest') expect(callerMayCall(caller, name), `${caller}/${name}`).toBe(false)
      }
    }
  })
})

describe('a guest never approves', () => {
  it('mayApprove and reply binding refuse a guest, even one who knows the code', () => {
    expect(mayApprove({ callerClass: 'guest', userId: OWNER }, OWNER)).toBe(false)
    const binding = bindReplyToApproval('yes ABCD', { callerClass: 'guest', userId: OWNER }, [{ approvalId: 'a1', ownerUserId: OWNER }], Date.now(), () => 'ABCD')
    expect(binding).toEqual({ bound: false, reason: 'not_owner' })
  })
})
