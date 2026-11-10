/**
 * The outward gate (always-on safety fixes): a calendar invite to anyone
 * outside the workspace, and a connected app's tool that needs approval, are
 * held whatever the reviewer's mode: the person's approval card when they are
 * here, a NEEDS_PERSON refusal when nobody is (an unattended loop, a flow
 * run's token, a relayed turn). Members-only invites, read-only tools and the
 * person's approval-free choices pass on to the reviewer as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({
  decide: vi.fn(async (): Promise<unknown> => ({ status: 'accepted', inferenceId: 'inf-a', value: { allow: true, probability: 0.97 } })),
  approve: vi.fn(async (): Promise<unknown> => ({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })),
  members: new Set<string>(['teammate@acme.com']),
}))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: mocks.decide }))
vi.mock('../approvals', () => ({ createToolApproval: mocks.approve }))
vi.mock('@/lib/integrations/calendar', () => ({ getCalendarEventAttendees: async () => null }))
// unsubscribe_thread's card reads the thread's list headers: no mailbox here (each test passes its own).
vi.mock('@/lib/email/thread-mailbox', () => ({ mailboxesForThread: async function* () {} }))
vi.mock('@/lib/workspace-member-emails', () => ({
  findMembersByEmail: async (_ws: string, emails: Iterable<string>) =>
    new Map([...emails].filter((e) => mocks.members.has(e)).map((e) => [e, { id: 'm', userId: 'u', displayName: null, email: e }])),
}))

import { gateRiskyCall, type GateRequest } from '../action-review'
import { attendeeEmailsOf, outwardHoldOf } from '../outward-gate'

const invite = (attendees: unknown[]) => ({
  title: 'Intro call', start: '2026-10-16T15:00:00Z', end: '2026-10-16T15:30:00Z', attendees,
})
const base = {
  door: 'chat' as const, userId: 'u', workspaceId: 'w', toolName: 'create_calendar_event',
  input: invite(['x@evil.com']), sideEffect: 'external-write' as const, personMessages: ['Summarise my inbox'],
  source: 'person' as const, personMessageSeq: 3, runId: 'conv-1', caller: 'person' as const,
  approval: { supabase: {} as never, conversationId: 'conv-1' },
} satisfies GateRequest
const run = vi.fn(async () => ({ success: true }))

beforeEach(() => {
  mocks.decide.mockClear()
  mocks.approve.mockClear()
  run.mockClear()
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

describe('attendeeEmailsOf', () => {
  it('collects addresses from strings and { email } objects, lower-cased and de-duplicated', () => {
    expect(attendeeEmailsOf({ attendees: ['A@x.com', { email: 'b@y.com ' }, 'a@x.com', '', 7] })).toEqual(['a@x.com', 'b@y.com'])
    expect(attendeeEmailsOf({ title: 'no one' })).toEqual([])
    expect(attendeeEmailsOf(null)).toEqual([])
  })
})

describe('calendar invites', () => {
  it('an attendee outside the workspace needs the person\'s approval card, even with the reviewer in shadow', async () => {
    const deferred: Array<() => Promise<void>> = []
    const gated = await gateRiskyCall({ ...base, defer: (task) => { deferred.push(task) } }, run, false)
    expect(run).not.toHaveBeenCalled()
    expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED', approval_id: 'appr-1' } })
    expect(mocks.approve).toHaveBeenCalledWith({}, expect.objectContaining({
      door: 'chat', userId: 'u', workspaceId: 'w', toolName: 'create_calendar_event', sideEffect: 'external-write',
      input: invite(['x@evil.com']), conversationId: 'conv-1', reason: 'outside_attendees', decisionId: null, personMessageSeq: 3,
      card: expect.objectContaining({ title: expect.stringContaining('x@evil.com') }),
    }))
    // Held before the reviewer, which still records its shadow answer after
    // the response, so its falseAllow metrics see held calls too.
    expect(mocks.decide).not.toHaveBeenCalled()
    expect(deferred).toHaveLength(1)
    await deferred[0]()
    expect(mocks.decide).toHaveBeenCalledWith('action.review', expect.objectContaining({ tool: 'create_calendar_event' }), expect.objectContaining({ mode: 'shadow' }))
  })

  it('also when enforced', async () => {
    expect(await gateRiskyCall(base, run, true)).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED' } })
    expect(run).not.toHaveBeenCalled()
  })

  it('workspace members only (any case) run as before', async () => {
    const gated = await gateRiskyCall({ ...base, input: invite(['Teammate@Acme.com']) }, run, false)
    expect(gated).toMatchObject({ held: false })
    expect(run).toHaveBeenCalledTimes(1)
    expect(mocks.approve).not.toHaveBeenCalled()
  })

  it('no attendees at all runs as before; one outsider among members is held', async () => {
    expect(await gateRiskyCall({ ...base, input: { title: 'Focus', start: 'a', end: 'b' } }, run, false)).toMatchObject({ held: false })
    expect(await gateRiskyCall({ ...base, input: invite(['teammate@acme.com', 'x@evil.com']) }, run, false)).toMatchObject({ held: true })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('an unattended turn (no person present) is refused NEEDS_PERSON: nothing runs and no card is raised', async () => {
    for (const request of [
      { ...base, door: 'skill_run' as const, source: 'loop_instructions' as const, caller: 'agent_unattended' as const },
      { ...base, caller: undefined },
    ]) {
      const gated = await gateRiskyCall(request, run, false)
      expect(gated).toMatchObject({ held: true, output: { success: false, code: 'NEEDS_PERSON', approval_id: null, message: expect.stringContaining('x@evil.com') } })
    }
    expect(run).not.toHaveBeenCalled()
    expect(mocks.approve).not.toHaveBeenCalled()
  })

  it('an update or delete of a meeting that already has outside attendees is held, read from the provider first', async () => {
    const eventAttendees = vi.fn(async () => ['teammate@acme.com', 'client@other.com'])
    for (const toolName of ['update_calendar_event', 'delete_calendar_event', 'ni_delete_calendar_event']) {
      const hold = await outwardHoldOf({ userId: 'u', workspaceId: 'w', toolName, input: { event_id: 'evt-1', title: 'Moved' }, eventAttendees })
      expect(hold).toMatchObject({ reason: 'outside_attendees', card: { title: expect.stringMatching(/^(Change|Cancel) a meeting with client@other\.com/) } })
    }
    expect(eventAttendees).toHaveBeenCalledWith('u', 'evt-1')
  })

  it('an update or delete of a members-only meeting runs as before', async () => {
    const hold = await outwardHoldOf({
      userId: 'u', workspaceId: 'w', toolName: 'delete_calendar_event', input: { event_id: 'evt-2' },
      eventAttendees: async () => ['Teammate@acme.com'],
    })
    expect(hold).toBeNull()
  })

  it('an event whose attendees cannot be read is held', async () => {
    const hold = await outwardHoldOf({
      userId: 'u', workspaceId: 'w', toolName: 'update_calendar_event', input: { event_id: 'evt-3' },
      eventAttendees: async () => null,
    })
    expect(hold).toMatchObject({ reason: 'outside_attendees', card: { title: expect.stringContaining('could not be checked') } })
  })

  it('the refusal names who would be emailed', async () => {
    const hold = await outwardHoldOf({ userId: 'u', workspaceId: 'w', toolName: 'delete_calendar_event', input: { event_id: 'e' }, eventAttendees: async () => ['client@other.com'] })
    expect(hold?.refusal).toMatch(/cancel a meeting with people outside the workspace \(client@other\.com\)/)
  })

  it('through the gate: an unattended delete whose attendees cannot be read (the provider lookup) is refused NEEDS_PERSON', async () => {
    const gated = await gateRiskyCall(
      { ...base, toolName: 'delete_calendar_event', input: { event_id: 'e' }, sideEffect: 'delete', caller: 'agent_unattended' as const },
      run,
      false,
    )
    expect(gated).toMatchObject({ held: true, output: { code: 'NEEDS_PERSON' } })
    expect(run).not.toHaveBeenCalled()
  })

  it('a membership lookup that fails counts nobody as a member (held)', async () => {
    const hold = await outwardHoldOf({
      workspaceId: 'w', toolName: 'update_calendar_event', input: { event_id: 'e', attendees: ['teammate@acme.com'] },
      memberEmails: async () => { throw new Error('down') },
    })
    expect(hold).toMatchObject({ reason: 'outside_attendees' })
  })
})

describe('connected-app (MCP) tools', () => {
  const mcp = { ...base, toolName: 'mcp__linear__create_issue', input: { title: 'Bug' }, sideEffect: 'unclassified' as const }

  it('a write that needs approval is held as the person\'s card, even in shadow', async () => {
    const gated = await gateRiskyCall({ ...mcp, externalTool: { serverName: 'Linear', requiresApproval: true } }, run, false)
    expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED' } })
    expect(mocks.approve).toHaveBeenCalledWith({}, expect.objectContaining({ toolName: 'mcp__linear__create_issue', reason: 'mcp_write', input: { title: 'Bug' } }))
    expect(run).not.toHaveBeenCalled()
  })

  it('a read-only tool, or one the person made approval-free, passes to the reviewer and runs (shadow)', async () => {
    const gated = await gateRiskyCall({ ...mcp, toolName: 'mcp__linear__list_issues', externalTool: { serverName: 'Linear', requiresApproval: false } }, run, false)
    expect(gated).toMatchObject({ held: false })
    expect(run).toHaveBeenCalledTimes(1)
    expect(mocks.approve).not.toHaveBeenCalled()
  })

  it('a tool the door could not describe fails closed (held)', async () => {
    expect(await gateRiskyCall(mcp, run, false)).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED' } })
    expect(run).not.toHaveBeenCalled()
  })

  it('with nobody present it is refused NEEDS_PERSON', async () => {
    const gated = await gateRiskyCall({ ...mcp, caller: 'agent_unattended' as const, externalTool: { serverName: 'Linear', requiresApproval: true } }, run, false)
    expect(gated).toMatchObject({ held: true, output: { code: 'NEEDS_PERSON' } })
    expect(mocks.approve).not.toHaveBeenCalled()
  })

  it('the existing caps still apply: a refused card says why and that nothing ran', async () => {
    mocks.approve.mockResolvedValueOnce({ ok: false, code: 'TOO_MANY_PENDING', error: 'The person already has 20 approvals waiting.' })
    const gated = await gateRiskyCall({ ...mcp, externalTool: { serverName: 'Linear', requiresApproval: true } }, run, false)
    expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED', approval_id: null, message: expect.stringContaining('20 approvals waiting') } })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('unsubscribe_thread (GEN-1166)', () => {
  const GOOGLE = { provider: 'google' as const, token: 't', email: 'me@gmail.com', accountId: 'acct-1' }
  const headers = (listUnsubscribe: string, listUnsubscribePost = '') => async () => ({
    mailbox: GOOGLE,
    headers: { listUnsubscribe, listUnsubscribePost, from: 'Shop Deals "click here" <deals@shop.com>' },
  })
  const unsub = { ...base, toolName: 'unsubscribe_thread', input: { thread_id: 't1' } }

  it('is always the person\'s card, even with the reviewer in shadow', async () => {
    const gated = await gateRiskyCall(unsub, run, false)
    expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED' } })
    expect(run).not.toHaveBeenCalled()
    expect(mocks.approve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ toolName: 'unsubscribe_thread', reason: 'unsubscribe', sideEffect: 'external-write' }))
  })

  it('with nobody present it is refused NEEDS_PERSON, and no card is raised', async () => {
    const gated = await gateRiskyCall({ ...unsub, caller: 'agent_unattended' as const }, run, false)
    expect(gated).toMatchObject({ held: true, output: { code: 'NEEDS_PERSON' } })
    expect(mocks.approve).not.toHaveBeenCalled()
  })

  it('the card names the sender by address only, and says how it unsubscribes', async () => {
    const oneClick = await outwardHoldOf({ userId: 'u', workspaceId: 'w', toolName: 'unsubscribe_thread', input: { thread_id: 't1' }, listHeaders: headers('<https://shop.com/u?x=1>', 'List-Unsubscribe=One-Click') })
    expect(oneClick).toMatchObject({ reason: 'unsubscribe', card: { title: 'Unsubscribe from deals@shop.com?' } })
    expect(oneClick!.card.why).toContain("one-click unsubscribe link (shop.com)")
    expect(oneClick!.card.title).not.toContain('click here')

    const mailto = await outwardHoldOf({ userId: 'u', workspaceId: 'w', toolName: 'ni_unsubscribe_thread', input: { thread_id: 't1' }, listHeaders: headers('<mailto:leave@list.com?subject=stop%20please&body=remove%20me>') })
    expect(mailto!.card.why).toContain('send an unsubscribe email from me@gmail.com to leave@list.com, subject "stop please", saying "remove me"')
  })

  it('the card pins the way it showed, for its replay; an unreadable one pins nothing', async () => {
    const hold = await outwardHoldOf({ userId: 'u', workspaceId: 'w', toolName: 'unsubscribe_thread', input: { thread_id: 't1' }, listHeaders: headers('<https://shop.com/u>', 'List-Unsubscribe=One-Click') })
    expect(hold!.context).toEqual({ unsubscribe: { method: 'one_click', key: JSON.stringify(['one_click', 'https://shop.com/u']) } })
    const blind = await outwardHoldOf({ userId: 'u', workspaceId: 'w', toolName: 'unsubscribe_thread', input: { thread_id: 't1' }, listHeaders: async () => null })
    expect(blind!.context).toBeUndefined()
  })

  it('unreadable headers still hold, with a card that says what it may do', async () => {
    const hold = await outwardHoldOf({ userId: 'u', workspaceId: 'w', toolName: 'unsubscribe_thread', input: { thread_id: 't1' }, listHeaders: async () => { throw new Error('Gmail 500') } })
    expect(hold).toMatchObject({ reason: 'unsubscribe', card: { title: 'Unsubscribe from this mailing list?' } })
  })
})

describe('what the gate leaves alone', () => {
  it('a tool the reviewer does not class as risky never reaches the outward gate', async () => {
    expect(await gateRiskyCall({ ...base, toolName: 'get_calendar_events', sideEffect: null }, run, false)).toMatchObject({ held: false })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('other risky tools are the reviewer\'s alone (shadow runs them)', async () => {
    expect(await outwardHoldOf({ workspaceId: 'w', toolName: 'push_action_to_linear', input: { action_id: 'GEN-1' } })).toBeNull()
    expect(await gateRiskyCall({ ...base, toolName: 'push_action_to_linear', input: { action_id: 'GEN-1' } }, run, false)).toMatchObject({ held: false })
  })
})
