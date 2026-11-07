/**
 * A home turn acts on its own, and every send waits for the person's yes
 * (Liam, 2026-10-26). Through the gate (action-review.ts, GateRequest.homeTurn):
 * work inside Dial8 runs, a delete of Dial8's own items runs, a plain read of
 * a connected app runs, the person's own calendar with nobody else on it
 * runs; anything that reaches another person or leaves Dial8 is held as the
 * person's approval card in their home thread (never a refusal), and they are
 * pinged (reachPerson). And the outward gate now holds an invite to anyone
 * but the person, teammates included.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({
  decide: vi.fn(async (): Promise<unknown> => ({ status: 'accepted', inferenceId: 'inf-a', value: { allow: true, probability: 0.97 } })),
  approve: vi.fn(async (): Promise<unknown> => ({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })),
  // email → the member's user id: the person (u) and a teammate (t).
  members: new Map<string, string>([['me@acme.com', 'u'], ['teammate@acme.com', 't']]),
}))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: mocks.decide }))
vi.mock('../approvals', () => ({ createToolApproval: mocks.approve }))
vi.mock('@/lib/integrations/calendar', () => ({ getCalendarEventAttendees: async () => null }))
vi.mock('@/lib/workspace-member-emails', () => ({
  findMembersByEmail: async (_ws: string, emails: Iterable<string>) =>
    new Map([...emails].filter((e) => mocks.members.has(e)).map((e) => [e, { id: `m-${e}`, userId: mocks.members.get(e)!, displayName: null, email: e }])),
}))

import { gateRiskyCall, homeTurnRunsOnItsOwn, type GateRequest } from '../action-review'
import { outwardHoldOf } from '../outward-gate'
import { decideAction } from '../caller'

const invite = (attendees: unknown[]) => ({ title: 'Sync', start: '2026-10-28T15:00:00Z', end: '2026-10-28T15:30:00Z', attendees })
const home = {
  door: 'chat' as const, userId: 'u', workspaceId: 'w', toolName: 'create_calendar_event',
  input: invite(['teammate@acme.com']), sideEffect: 'external-write' as const, personMessages: [],
  source: 'person' as const, personMessageSeq: null, runId: 'conv-home', caller: 'agent_unattended' as const,
  homeTurn: true as const,
  approval: { supabase: {} as never, conversationId: 'conv-home' },
} satisfies GateRequest
const run = vi.fn(async () => ({ success: true }))

beforeEach(() => {
  mocks.decide.mockClear()
  mocks.approve.mockClear()
  run.mockClear()
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

describe('homeTurnRunsOnItsOwn', () => {
  it('a delete, a freed plain read of a connected app, and the person\'s own calendar run; everything else waits', () => {
    expect(homeTurnRunsOnItsOwn({ toolName: 'delete_action', sideEffect: 'delete' })).toBe(true)
    expect(homeTurnRunsOnItsOwn({ toolName: 'mcp__notion__search_pages', sideEffect: 'unclassified', externalTool: { serverName: 'Notion', requiresApproval: false, toolName: 'search_pages' } })).toBe(true)
    // Its name stands in when the policy doesn't carry it.
    expect(homeTurnRunsOnItsOwn({ toolName: 'mcp__notion__search_pages', sideEffect: 'unclassified', externalTool: { serverName: 'Notion', requiresApproval: false } })).toBe(true)
    expect(homeTurnRunsOnItsOwn({ toolName: 'create_calendar_event', sideEffect: 'external-write' })).toBe(true)
    expect(homeTurnRunsOnItsOwn({ toolName: 'dial8_update_calendar_event', sideEffect: 'external-write' })).toBe(true)
    // A write the person freed to run without asking still waits: nothing is sent without their yes.
    expect(homeTurnRunsOnItsOwn({ toolName: 'mcp__slack__post_message', sideEffect: 'unclassified', externalTool: { serverName: 'Slack', requiresApproval: false, toolName: 'post_message' } })).toBe(false)
    // A read its server can't make a write (the GitHub integration's): runs whatever its name.
    expect(homeTurnRunsOnItsOwn({ toolName: 'mcp__github__pull_request_read', sideEffect: 'unclassified', externalTool: { serverName: 'GitHub', requiresApproval: false, toolName: 'pull_request_read', pinnedRead: true } })).toBe(true)
    expect(homeTurnRunsOnItsOwn({ toolName: 'mcp__github__pull_request_read', sideEffect: 'unclassified', externalTool: { serverName: 'GitHub', requiresApproval: false, toolName: 'pull_request_read' } })).toBe(false)
    expect(homeTurnRunsOnItsOwn({ toolName: 'mcp__github__pull_request_read', sideEffect: 'unclassified', externalTool: { serverName: 'GitHub', requiresApproval: true, toolName: 'pull_request_read', pinnedRead: true } })).toBe(false)
    expect(homeTurnRunsOnItsOwn({ toolName: 'mcp__notion__search_pages', sideEffect: 'unclassified' })).toBe(false)
    for (const toolName of ['publish_draft', 'push_action_to_jira', 'enroll_contacts_in_sequence', 'ask_agent']) {
      expect(homeTurnRunsOnItsOwn({ toolName, sideEffect: 'external-write' }), toolName).toBe(false)
    }
    expect(homeTurnRunsOnItsOwn({ toolName: 'create_flow', sideEffect: 'automation-write' })).toBe(false)
  })
})

describe('a home turn through the gate', () => {
  it('an invite to a teammate is the person\'s card (never a refusal), and they are pinged', async () => {
    const gated = await gateRiskyCall(home, run, false)
    expect(run).not.toHaveBeenCalled()
    expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED', approval_id: 'appr-1', message: expect.stringContaining('home thread') } })
    expect(mocks.approve).toHaveBeenCalledWith({}, expect.objectContaining({
      toolName: 'create_calendar_event', reason: 'teammate_attendees', reachPerson: true,
      card: expect.objectContaining({ title: expect.stringContaining('teammate@acme.com') }),
    }))
  })

  it('the person\'s own calendar with nobody else on it runs', async () => {
    expect(await gateRiskyCall({ ...home, input: invite(['Me@Acme.com']) }, run, false)).toMatchObject({ held: false })
    expect(await gateRiskyCall({ ...home, input: { title: 'Focus', start: 'a', end: 'b' } }, run, false)).toMatchObject({ held: false })
    expect(run).toHaveBeenCalledTimes(2)
    expect(mocks.approve).not.toHaveBeenCalled()
  })

  it('a delete of Dial8\'s own items runs', async () => {
    expect(await gateRiskyCall({ ...home, toolName: 'delete_action', input: { action_id: 'a1' }, sideEffect: 'delete' }, run, false)).toMatchObject({ held: false })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('anything else that leaves Dial8 is the person\'s card, whatever the reviewer\'s mode', async () => {
    for (const enforce of [false, true]) {
      const gated = await gateRiskyCall({ ...home, toolName: 'push_action_to_jira', input: { action_id: 'a1' } }, run, enforce)
      expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED' } })
    }
    expect(mocks.approve).toHaveBeenLastCalledWith({}, expect.objectContaining({ toolName: 'push_action_to_jira', reason: 'home_turn', reachPerson: true }))
    expect(run).not.toHaveBeenCalled()
  })

  it('a connected app\'s write the person freed still waits; a freed plain read runs', async () => {
    const write = { ...home, toolName: 'mcp__slack__post_message', input: { text: 'hi' }, sideEffect: 'unclassified' as const, externalTool: { serverName: 'Slack', requiresApproval: false, toolName: 'post_message' } }
    expect(await gateRiskyCall(write, run, false)).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED' } })
    const read = { ...write, toolName: 'mcp__slack__search_messages', externalTool: { serverName: 'Slack', requiresApproval: false, toolName: 'search_messages' } }
    expect(await gateRiskyCall(read, run, false)).toMatchObject({ held: false })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('a chat-native tool held as a refusal keeps that path (never carded here)', async () => {
    const gated = await gateRiskyCall({ ...home, toolName: 'start_helper', input: {}, sideEffect: 'automation-write', holdAs: 'refusal' }, run, false)
    expect(gated).toMatchObject({ held: false })
    expect(mocks.approve).not.toHaveBeenCalled()
  })
})

describe('the outward gate: anyone but the person', () => {
  it('holds an invite to a teammate, and names an outsider first', async () => {
    expect(await outwardHoldOf({ userId: 'u', workspaceId: 'w', toolName: 'create_calendar_event', input: invite(['teammate@acme.com']) }))
      .toMatchObject({ reason: 'teammate_attendees', card: { why: expect.stringContaining('Nothing reaches another person without your yes') } })
    const both = await outwardHoldOf({ userId: 'u', workspaceId: 'w', toolName: 'create_calendar_event', input: invite(['teammate@acme.com', 'client@other.com']) })
    expect(both).toMatchObject({ reason: 'outside_attendees', card: { title: 'Send a calendar invite to client@other.com, teammate@acme.com?' } })
    expect(both?.card.why).toContain('including people outside your workspace (client@other.com)')
  })

  it('passes the person\'s own address, and a change to a meeting only they are on', async () => {
    expect(await outwardHoldOf({ userId: 'u', workspaceId: 'w', toolName: 'create_calendar_event', input: invite(['me@acme.com']) })).toBeNull()
    expect(await outwardHoldOf({ userId: 'u', workspaceId: 'w', toolName: 'delete_calendar_event', input: { event_id: 'e' }, eventAttendees: async () => ['me@acme.com'] })).toBeNull()
  })

  it('an own-address lookup that fails counts no one as the person (held)', async () => {
    const hold = await outwardHoldOf({
      userId: 'u', workspaceId: 'w', toolName: 'create_calendar_event', input: invite(['me@acme.com']),
      ownEmails: async () => { throw new Error('down') },
    })
    expect(hold).toMatchObject({ reason: 'teammate_attendees' })
  })
})

describe('the caller policy', () => {
  it('a home turn\'s outward call asks the person; any other unattended one is still refused', () => {
    expect(decideAction('agent_unattended', 'outward', 'create_calendar_event', { homeTurn: true })).toBe('ask')
    expect(decideAction('agent_unattended', 'outward', 'create_calendar_event', {})).toBe('deny')
  })
})
