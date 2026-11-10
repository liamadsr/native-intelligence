/**
 * The one trust authority (caller.ts): every principal's class, the policy
 * table, who may approve, approval by reply (F3), and lasting memory (F8).
 * Plus: for every door the routes serve today, the policy refuses nothing its
 * ceiling admits, so wiring it in changed no one's behaviour.
 */
import { describe, it, expect } from 'vitest'
import {
  CALLER_CLASSES,
  approvalReplyCode,
  attendedOnlyToolsDeniedTo,
  bindReplyToApproval,
  callerClassOf,
  callerMayCall,
  channelCaller,
  channelShouldReply,
  decideAction,
  isCallerClass,
  mayApprove,
  policyEffectOf,
  runAsUserFor,
  runStarterClass,
  type CallerClass,
  type PendingApprovalRef,
  type PolicyEffect,
  type VerifiedPrincipal,
} from '../caller'
import { ALL_CATEGORY_IDS, ALL_TOOL_NAMES, ATTENDED_ONLY_TOOL_NAMES, NON_CHAT_TOOL_NAMES } from '@/lib/ai/tool-registry'
import { SURFACE_EXCLUDED_TOOLS, isServerTurnTool, serverTurnMayCall } from '@/lib/chat/chat-ceiling'
import { computeSkillCeiling } from '@/lib/flows/run-skill'
import { ceilingForWorkRun } from '@/lib/agent-run/run-work-spec-rebuild'
import { computeLiveAgentCeiling, LIVE_AGENT_TURN_TYPES } from '@/lib/live-agent/ceiling'

const OWNER = 'user-owner'
const TEAMMATE = 'user-teammate'

describe('callerClassOf: every principal today, from verified facts only', () => {
  const cases: Array<[string, VerifiedPrincipal, CallerClass]> = [
    ['the in-app chat', { kind: 'chat_run', claims: {} }, 'person'],
    ['a teammate chat / bot conversation (no relay)', { kind: 'chat_run', claims: {} }, 'person'],
    ['the device ask', { kind: 'chat_run', claims: { surface: 'device_ask' } }, 'person_remote'],
    ['a surface nobody knows (fail closed)', { kind: 'chat_run', claims: { surface: 'smart_fridge' } }, 'unknown'],
    ['a home turn', { kind: 'chat_run', claims: { server: 'home_turn' } }, 'agent_unattended'],
    ['idle compaction', { kind: 'chat_run', claims: { server: 'idle_compaction' } }, 'agent_unattended'],
    ['a relayed turn in a bot thread', { kind: 'chat_run', claims: { relay: 'relay-1' } }, 'agent_unattended'],
    ['a server turn that also names a surface', { kind: 'chat_run', claims: { server: 'home_turn', surface: 'device_ask' } }, 'agent_unattended'],
    ['a text from their verified phone (a channel turn, sms)', { kind: 'chat_run', claims: { server: 'channel_turn', surface: 'sms' } }, 'person_remote'],
    ['a channel turn that is also relayed', { kind: 'chat_run', claims: { server: 'channel_turn', surface: 'sms', relay: 'relay-1' } }, 'unknown'],
    ['the sms surface on a token no server minted (fail closed)', { kind: 'chat_run', claims: { surface: 'sms' } }, 'unknown'],
    ['a loop run', { kind: 'skill_run', claims: {} }, 'agent_unattended'],
    ['a loop run’s follow-up chat turn', { kind: 'skill_run', claims: { chat: {} } }, 'person'],
    ['a loop run’s relayed chat turn', { kind: 'skill_run', claims: { chat: { relay: true } } }, 'agent_unattended'],
    ['a work run’s own turns', { kind: 'work_run', claims: {} }, 'agent_unattended'],
    ['a work run’s follow-up chat turn', { kind: 'work_run', claims: { chat: true } }, 'person'],
    ['a work run’s chat turn the main agent relayed', { kind: 'work_run', claims: { chat: true, relay: true } }, 'agent_unattended'],
    ['a relay mark without a chat turn', { kind: 'work_run', claims: { relay: true } }, 'agent_unattended'],
    ['a coding run', { kind: 'coding_run' }, 'agent_unattended'],
    ['the live agent', { kind: 'live_agent' }, 'agent_unattended'],
    ['the person’s own MCP connector', { kind: 'mcp_connector' }, 'person'],
    ['the person’s own click', { kind: 'app_session' }, 'person'],
  ]
  it.each(cases)('%s', (_label, principal, expected) => {
    expect(callerClassOf(principal)).toBe(expected)
  })

  it('fails closed on nothing, or a kind it does not know', () => {
    expect(callerClassOf(null)).toBe('unknown')
    expect(callerClassOf(undefined)).toBe('unknown')
    expect(callerClassOf({ kind: 'browser_extension' } as unknown as VerifiedPrincipal)).toBe('unknown')
  })

  it('isCallerClass admits the six classes only', () => {
    for (const c of CALLER_CLASSES) expect(isCallerClass(c)).toBe(true)
    for (const v of ['admin', '', null, 3, 'Person']) expect(isCallerClass(v)).toBe(false)
  })
})

describe('outside channels (decisions 11 and 14), stamped at intake', () => {
  const sender = (over: Partial<Parameters<typeof channelCaller>[0]>) => ({ channel: 'slack' as const, ownerUserId: OWNER, senderUserId: OWNER, senderIsMember: true, ...over })
  it('the owner: a Slack message is the person; a text or a call is the person, remote', () => {
    expect(channelCaller(sender({}))).toBe('person')
    expect(channelCaller(sender({ channel: 'sms' }))).toBe('person_remote')
    expect(channelCaller(sender({ channel: 'call' }))).toBe('person_remote')
  })
  it('another member is other_person; anyone else is unknown', () => {
    expect(channelCaller(sender({ senderUserId: TEAMMATE }))).toBe('other_person')
    expect(channelCaller(sender({ senderUserId: TEAMMATE, senderIsMember: false }))).toBe('unknown')
    expect(channelCaller(sender({ senderUserId: null }))).toBe('unknown')
    expect(channelCaller(sender({ ownerUserId: '' }))).toBe('unknown')
  })
  it('callerClassOf reads a channel principal through the same rule', () => {
    expect(callerClassOf({ kind: 'channel', channel: 'slack', ownerUserId: OWNER, senderUserId: TEAMMATE, senderIsMember: true, place: 'group' })).toBe('other_person')
  })
  it('in a group thread it replies only when mentioned; in a direct conversation always', () => {
    expect(channelShouldReply('group', false)).toBe(false)
    expect(channelShouldReply('group', true)).toBe(true)
    expect(channelShouldReply('direct', false)).toBe(true)
  })
  it('a teammate’s ask runs over what THEY can see, never the owner’s; an unknown caller’s over nobody’s', () => {
    expect(runAsUserFor('other_person', { ownerUserId: OWNER, callerUserId: TEAMMATE })).toBe(TEAMMATE)
    expect(runAsUserFor('other_person', { ownerUserId: OWNER })).toBeNull()
    expect(runAsUserFor('person', { ownerUserId: OWNER, callerUserId: TEAMMATE })).toBe(OWNER)
    expect(runAsUserFor('agent_unattended', { ownerUserId: OWNER })).toBe(OWNER)
    expect(runAsUserFor('unknown', { ownerUserId: OWNER, callerUserId: TEAMMATE })).toBeNull()
  })
})

describe('decideAction: the decision table', () => {
  const READ = 'list_actions'
  const INTERNAL = 'create_action'
  const EXTERNAL = 'push_action_to_linear'
  const DELETE = 'delete_action'
  const AUTOMATION = 'create_flow'
  const ATTENDED = 'settle_card'
  const MCP = 'mcp__linear__create_issue'

  it('the registry classes the table is written against', () => {
    expect(policyEffectOf(READ)).toBe('read')
    expect(policyEffectOf(INTERNAL)).toBe('internal-write')
    expect(policyEffectOf(EXTERNAL)).toBe('external-write')
    expect(policyEffectOf(DELETE)).toBe('delete')
    expect(policyEffectOf(MCP)).toBe('unclassified')
    expect(policyEffectOf('ni_list_actions')).toBe('read')
    expect(policyEffectOf('search_tools')).toBe('read')
  })

  const table: Record<CallerClass, Record<string, ReturnType<typeof decideAction>>> = {
    person: { read: 'run', write: 'run', outward: 'ask', attended: 'run' },
    person_remote: { read: 'run', write: 'run', outward: 'ask', attended: 'deny' },
    agent_unattended: { read: 'run', write: 'run', outward: 'deny', attended: 'deny' },
    other_person: { read: 'run', write: 'deny', outward: 'deny', attended: 'deny' },
    // With no asks given a guest's every write asks the owner (its asks: caller-guest.test.ts).
    guest: { read: 'run', write: 'ask', outward: 'ask', attended: 'deny' },
    unknown: { read: 'deny', write: 'deny', outward: 'deny', attended: 'deny' },
  }
  it.each(CALLER_CLASSES)('%s', (caller) => {
    const row = table[caller]
    expect(decideAction(caller, 'read', READ)).toBe(row.read)
    for (const [effect, tool] of [['internal-write', INTERNAL], ['external-write', EXTERNAL], ['delete', DELETE], ['unclassified', MCP]] as Array<[PolicyEffect, string]>) {
      // A guest never holds an outside app's tool (it would act in the owner's account).
      expect(decideAction(caller, effect, tool)).toBe(caller === 'guest' && effect === 'unclassified' ? 'deny' : row.write)
    }
    expect(decideAction(caller, policyEffectOf(AUTOMATION), AUTOMATION)).toBe(caller === 'person' ? 'run' : 'deny') // create_flow is attended-only too
    expect(decideAction(caller, 'outward', MCP)).toBe(caller === 'guest' ? 'deny' : row.outward)
    expect(decideAction(caller, 'outward', 'create_calendar_event')).toBe(row.outward)
    expect(decideAction(caller, policyEffectOf(ATTENDED), ATTENDED)).toBe(row.attended)
  })

  it('unattended never waits: a hold is a deny, never an ask', () => {
    for (const tool of [MCP, 'create_calendar_event', 'update_calendar_event', 'delete_calendar_event']) {
      expect(decideAction('agent_unattended', 'outward', tool)).toBe('deny')
    }
  })

  it('a bot’s follow-through grant reaches an unattended (relayed) turn, and nothing else', () => {
    expect(decideAction('agent_unattended', 'internal-write', ATTENDED, { granted: true })).toBe('run')
    expect(decideAction('person_remote', 'internal-write', ATTENDED, { granted: true })).toBe('deny')
    expect(decideAction('other_person', 'internal-write', ATTENDED, { granted: true })).toBe('deny')
    expect(decideAction('unknown', 'read', ATTENDED, { granted: true })).toBe('deny')
    // A grant never turns an outward hold into a run.
    expect(decideAction('agent_unattended', 'outward', MCP, { granted: true })).toBe('deny')
  })

  it('another person may read only workspace tools, never an outside app’s or the main chat’s own', () => {
    expect(decideAction('other_person', 'read', 'list_emails')).toBe('run')
    expect(decideAction('other_person', 'read', 'mcp__linear__list_issues')).toBe('deny')
    expect(decideAction('other_person', 'read', 'wait_for_bot_reply')).toBe('deny')
    expect(decideAction('other_person', 'read', 'list_bot_work')).toBe('deny')
    expect(decideAction('other_person', 'read', 'read_card')).toBe('deny')
    expect(decideAction('other_person', 'read', 'search_tools')).toBe('run')
  })

  it('fails closed on a class it does not know', () => {
    expect(decideAction('admin' as CallerClass, 'read', READ)).toBe('deny')
  })

  it('attendedOnlyToolsDeniedTo: all of them for the remote person and an unattended caller, none for the person', () => {
    expect(new Set(attendedOnlyToolsDeniedTo('person_remote'))).toEqual(new Set(ATTENDED_ONLY_TOOL_NAMES))
    expect(new Set(attendedOnlyToolsDeniedTo('agent_unattended'))).toEqual(new Set(ATTENDED_ONLY_TOOL_NAMES))
    expect(attendedOnlyToolsDeniedTo('person')).toEqual([])
  })
})

describe('callerMayCall refuses nothing a door’s ceiling admits today (behaviour unchanged)', () => {
  it('the person (in-app chat, teammate chat, MCP connector, follow-up chat turns): every registry tool', () => {
    for (const name of [...ALL_TOOL_NAMES, 'search_tools', 'mcp__linear__create_issue']) expect(callerMayCall('person', name)).toBe(true)
  })

  it('the device ask: every tool its surface keeps', () => {
    for (const name of ALL_TOOL_NAMES) {
      if (SURFACE_EXCLUDED_TOOLS.device_ask.has(name)) continue
      expect(callerMayCall('person_remote', name)).toBe(true)
    }
  })

  it('a server turn: every tool it may call (reads, and start_helper on a home turn)', () => {
    for (const name of [...ALL_TOOL_NAMES, 'search_tools']) {
      if (serverTurnMayCall(name, 'home_turn') || isServerTurnTool(name)) expect(callerMayCall('agent_unattended', name)).toBe(true)
    }
  })

  it('a loop run: every tool any skill ceiling holds, and inherit-all’s', () => {
    for (const name of NON_CHAT_TOOL_NAMES) expect(callerMayCall('agent_unattended', name)).toBe(true)
    for (const config of [{ enabled_tools: [...ALL_CATEGORY_IDS] }, { enabled_tools: [] }, null]) {
      for (const mode of ['act', 'report'] as const) {
        for (const name of computeSkillCeiling(config as never, mode, true) ?? []) expect(callerMayCall('agent_unattended', name)).toBe(true)
      }
    }
  })

  it('a work run’s own turns: every tool its ceiling holds, whoever started it', () => {
    for (const origin of ['user', 'attempt', 'loop', 'chat', 'delegation', null]) {
      for (const name of ceilingForWorkRun(origin)) expect(callerMayCall('agent_unattended', name)).toBe(true)
    }
  })

  it('the live agent: every tool any turn type’s ceiling holds', () => {
    for (const turnType of LIVE_AGENT_TURN_TYPES) {
      for (const assistOnly of [true, false]) {
        const { ceiling } = computeLiveAgentCeiling({ turnType, assistOnly, agentConfig: null, mcpLookups: ['mcp__linear__list_issues'] })
        for (const name of ceiling) expect(callerMayCall('agent_unattended', name)).toBe(true)
      }
    }
  })

  it('a relayed turn: a bot’s follow-through grant (any attended-only tool in its ceiling)', () => {
    for (const name of ATTENDED_ONLY_TOOL_NAMES) {
      expect(callerMayCall('agent_unattended', name)).toBe(false)
      expect(callerMayCall('agent_unattended', name, { granted: true })).toBe(true)
    }
  })
})

describe('mayApprove: only the owner, in their own hand (decision 11)', () => {
  it('the owner as the person, in the app or remote', () => {
    expect(mayApprove({ callerClass: 'person', userId: OWNER }, OWNER)).toBe(true)
    expect(mayApprove({ callerClass: 'person_remote', userId: OWNER }, OWNER)).toBe(true)
  })
  it('never another person, an unattended run, an unknown caller, or nobody', () => {
    expect(mayApprove({ callerClass: 'person', userId: TEAMMATE }, OWNER)).toBe(false)
    expect(mayApprove({ callerClass: 'other_person', userId: OWNER }, OWNER)).toBe(false)
    expect(mayApprove({ callerClass: 'agent_unattended', userId: OWNER }, OWNER)).toBe(false)
    expect(mayApprove({ callerClass: 'unknown', userId: OWNER }, OWNER)).toBe(false)
    expect(mayApprove(null, OWNER)).toBe(false)
    expect(mayApprove({ callerClass: 'person', userId: '' }, '')).toBe(false)
    expect(mayApprove({ callerClass: 'person', userId: OWNER }, null)).toBe(false)
  })
})

describe('bindReplyToApproval (F3): a reply approves only the one approval it names, by its code, from the owner', () => {
  const me = { callerClass: 'person_remote' as const, userId: OWNER }
  const future = new Date(Date.now() + 3_600_000).toISOString()
  const DANA = '2b1f7c5e-0d3a-4c8e-9a51-7f0e2c9d1b44'
  const INVITE = '9c0e1a2b-3d4f-4a5b-8c6d-7e8f9a0b1c2d'
  const THEIRS = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d'
  const code = (id: string) => approvalReplyCode(id)
  const pending: PendingApprovalRef[] = [
    { approvalId: DANA, ownerUserId: OWNER, status: 'pending', expiresAt: future },
    { approvalId: INVITE, ownerUserId: OWNER, expiresAt: future },
    { approvalId: THEIRS, ownerUserId: TEAMMATE, status: 'pending' },
  ]

  it('the codes differ, so the test below means something', () => {
    expect(new Set([code(DANA), code(INVITE), code(THEIRS)]).size).toBe(3)
  })

  it.each(['yes', 'Yes!', 'ok', 'yes please', 'approve', 'Y', 'sure, go ahead'])('a stray "%s" approves nothing', (reply) => {
    expect(bindReplyToApproval(reply, me, pending)).toEqual({ bound: false, reason: 'stray_yes' })
  })

  it('a stray yes approves nothing even when only one approval is pending', () => {
    expect(bindReplyToApproval('yes', me, pending.slice(0, 1))).toEqual({ bound: false, reason: 'stray_yes' })
  })

  it('a number binds nothing: only a persisted per-message map may say what "1" means', () => {
    for (const reply of ['1', '#1', 'yes 1', '2']) expect(bindReplyToApproval(reply, me, pending)).toEqual({ bound: false, reason: 'no_match' })
  })

  it('the right code from the owner binds, in any case, with yes words around it', () => {
    expect(bindReplyToApproval(code(DANA), me, pending)).toEqual({ bound: true, decision: 'approve', approvalId: DANA })
    expect(bindReplyToApproval(code(DANA).toLowerCase(), me, pending)).toEqual({ bound: true, decision: 'approve', approvalId: DANA })
    expect(bindReplyToApproval(`yes ${code(INVITE)} thanks`, me, pending)).toEqual({ bound: true, decision: 'approve', approvalId: INVITE })
    expect(bindReplyToApproval(`Approve ${code(INVITE)}.`, me, pending)).toEqual({ bound: true, decision: 'approve', approvalId: INVITE })
  })

  it('"no <code>" declines that one', () => {
    expect(bindReplyToApproval(`no ${code(DANA)}`, me, pending)).toEqual({ bound: true, decision: 'decline', approvalId: DANA })
    expect(bindReplyToApproval(`Don't ${code(INVITE)}`, me, pending)).toEqual({ bound: true, decision: 'decline', approvalId: INVITE })
  })

  it('the wrong person binds nothing: another member, an unattended run, an unknown sender, nobody', () => {
    expect(bindReplyToApproval(code(DANA), { callerClass: 'person', userId: TEAMMATE }, pending)).toEqual({ bound: false, reason: 'not_owner' })
    expect(bindReplyToApproval(code(DANA), { callerClass: 'other_person', userId: TEAMMATE }, pending)).toEqual({ bound: false, reason: 'not_owner' })
    expect(bindReplyToApproval(code(DANA), { callerClass: 'agent_unattended', userId: OWNER }, pending)).toEqual({ bound: false, reason: 'not_owner' })
    expect(bindReplyToApproval(code(DANA), { callerClass: 'unknown', userId: OWNER }, pending)).toEqual({ bound: false, reason: 'not_owner' })
    expect(bindReplyToApproval(code(DANA), null, pending)).toEqual({ bound: false, reason: 'not_owner' })
  })

  it('a code of someone else’s approval binds nothing for me, and binds for them', () => {
    expect(bindReplyToApproval(code(THEIRS), me, pending)).toEqual({ bound: false, reason: 'not_owner' })
    expect(bindReplyToApproval(code(THEIRS), { callerClass: 'person', userId: TEAMMATE }, pending)).toEqual({ bound: true, decision: 'approve', approvalId: THEIRS })
  })

  it('two codes, a yes and a no together, or other words mixed in bind nothing', () => {
    expect(bindReplyToApproval(`${code(DANA)} ${code(INVITE)}`, me, pending)).toEqual({ bound: false, reason: 'ambiguous' })
    expect(bindReplyToApproval(`yes no ${code(DANA)}`, me, pending)).toEqual({ bound: false, reason: 'ambiguous' })
    expect(bindReplyToApproval(`send it to bob ${code(DANA)}`, me, pending)).toEqual({ bound: false, reason: 'ambiguous' })
  })

  it('an unknown code, an empty reply, or junk binds nothing', () => {
    expect(bindReplyToApproval('QQQQ', me, pending)).toEqual({ bound: false, reason: 'no_match' })
    expect(bindReplyToApproval('   ', me, pending)).toEqual({ bound: false, reason: 'empty' })
    expect(bindReplyToApproval(undefined as unknown as string, me, pending)).toEqual({ bound: false, reason: 'empty' })
    expect(bindReplyToApproval(code(DANA), me, [])).toEqual({ bound: false, reason: 'no_match' })
  })

  it('a lapsed or already-settled approval cannot be answered', () => {
    const past = new Date(Date.now() - 1000).toISOString()
    expect(bindReplyToApproval(code(DANA), me, [{ approvalId: DANA, ownerUserId: OWNER, expiresAt: past }])).toEqual({ bound: false, reason: 'no_match' })
    for (const status of ['approved', 'denied', 'expired', 'failed']) {
      expect(bindReplyToApproval(code(DANA), me, [{ approvalId: DANA, ownerUserId: OWNER, status }])).toEqual({ bound: false, reason: 'no_match' })
    }
  })

  it('approvalReplyCode is stable, short, unambiguous, and never a yes or no word', () => {
    expect(code(DANA)).toMatch(/^[ACDEFGHJKMNPQRTUVWXY34679]{4}$/)
    expect(code(DANA)).toBe(approvalReplyCode(DANA))
    const words = new Set(['yeah', 'deny', 'send', 'sure', 'nope', 'okay', 'stop', 'dont', 'yeap'])
    for (let i = 0; i < 20_000; i++) {
      const c = approvalReplyCode(`approval-${i}`)
      expect(c).toMatch(/^[ACDEFGHJKMNPQRTUVWXY34679]{4}$/)
      expect(words.has(c.toLowerCase())).toBe(false)
      // Every code binds as itself: none is swallowed as a plain yes or no.
      expect(bindReplyToApproval(c, me, [{ approvalId: `approval-${i}`, ownerUserId: OWNER }])).toMatchObject({ bound: true })
    }
  })
})

describe('lasting memory (F8, decision 16)', () => {
  it('who started a work run: only a person’s Start is the person', () => {
    expect(runStarterClass('user')).toBe('person')
    for (const origin of [null, undefined, 'attempt', 'loop', 'chat', 'delegation', 'something-new']) expect(runStarterClass(origin)).toBe('agent_unattended')
  })
  it('there is no suggest-only memory any more: nothing here decides whether an entry waits (apply with undo)', async () => {
    expect(Object.keys(await import('../caller'))).not.toContain('lastingMemoryWrite')
  })
})
