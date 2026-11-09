/**
 * The reviewer's gate (A5 slice 2; blocking by default since L5): which tools
 * are reviewed, what Jev is asked, how shadow and enforce differ, the kill
 * switch (ACTION_REVIEW_MODE), and that the doors it does not guard (work
 * runs, the live agent) cannot reach a risky tool at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({
  decide: vi.fn(),
  approve: vi.fn(async (): Promise<unknown> => ({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })),
}))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: mocks.decide }))
vi.mock('../approvals', () => ({ createToolApproval: mocks.approve }))

import {
  ACTION_REVIEW_MODE_ENV, actionReviewMode, approvalCardCopy, gateRiskyCall, holdEveryCallAs, refusalMessage, reviewerBlocks,
  reviewCouldNotRun, reviewRiskyCall, riskClassOf, type GateRequest,
} from '../action-review'
import { getToolSideEffect } from '@/lib/ai/tool-registry'
import { computeWorkRunCeiling } from '@/lib/agent-run/run-work-spec-rebuild'
import { computeLiveAgentCeiling, LIVE_AGENT_TURN_TYPES } from '@/lib/live-agent/ceiling'

const base = {
  door: 'chat' as const, userId: 'u', workspaceId: 'w', toolName: 'delete_action', input: { action_id: 'GEN-12' },
  sideEffect: 'delete' as const, personMessages: ['Delete GEN-12'], source: 'person' as const, personMessageSeq: 4,
  toolsThisTurn: ['list_actions'], runId: 'conv-1',
  approval: { supabase: {} as never, conversationId: 'conv-1', context: { agentId: 'agent-1' } },
} satisfies GateRequest
const allow = { status: 'accepted', inferenceId: 'inf-a', value: { allow: true, probability: 0.97 } }
const deny = { status: 'accepted', inferenceId: 'inf-b', value: { allow: false, probability: 0.2 } }

beforeEach(() => {
  mocks.decide.mockReset().mockResolvedValue(allow)
  mocks.approve.mockClear()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('riskClassOf', () => {
  it('reviews external-write, delete and automation-write; never read or internal-write', () => {
    expect(riskClassOf('push_action_to_linear')).toBe('external-write')
    expect(riskClassOf('delete_action')).toBe('delete')
    expect(riskClassOf('create_flow')).toBe('automation-write')
    expect(riskClassOf('list_actions')).toBeNull()
    expect(riskClassOf('create_action')).toBeNull()
  })

  it('an external mcp__ tool or a name nobody classified is reviewed as unclassified (fails closed when enforced)', () => {
    expect(riskClassOf('mcp__atlassian__create_issue')).toBe('unclassified')
    expect(riskClassOf('brand_new_tool_without_a_class')).toBe('unclassified')
  })

  it('never reviews search_tools or mcp_confirm_call (which only raises an approval)', () => {
    expect(riskClassOf('search_tools')).toBeNull()
    expect(riskClassOf('mcp_confirm_call')).toBeNull()
  })

  it('never holds the outreach launches either: each raises its own card (every email, every recipient), so a text turn gets one code, not two', () => {
    for (const name of ['launch_sequence', 'launch_campaign', 'dial8_launch_sequence']) expect(riskClassOf(name)).toBeNull()
    // Their registry class stays external-write: no work run holds them.
    for (const name of ['launch_sequence', 'launch_campaign']) expect(getToolSideEffect(name)).toBe('external-write')
  })

  it('holds complete_job like any send (it emails the customer their review request): a text alone never runs it', () => {
    expect(riskClassOf('complete_job')).toBe('external-write')
  })

  it('reviews the internal-writes that also write outside Native Intelligence as external (HubSpot writeback, the mailbox draft), without changing their registry class', () => {
    for (const name of ['create_contact', 'update_crm_contact', 'revise_email_draft', 'dial8_create_contact']) expect(riskClassOf(name)).toBe('external-write')
    for (const name of ['create_contact', 'update_crm_contact', 'revise_email_draft']) expect(getToolSideEffect(name)).toBe('internal-write')
  })
})

describe('reviewRiskyCall', () => {
  it('asks action.review with the capped evidence, the arguments as JSON text, and the mode this caller gets', async () => {
    const outcome = await reviewRiskyCall({ ...base, personMessages: ['a', 'b', 'c', 'Delete GEN-12'] })
    // Not a Mac call: the default records it in shadow.
    expect(outcome).toMatchObject({ verdict: 'allow', reason: 'asked', probability: 0.97, inferenceId: 'inf-a', mode: 'shadow', card: null })
    expect(mocks.decide).toHaveBeenCalledWith('action.review', {
      door: 'chat', tool: 'delete_action', sideEffect: 'delete', arguments: '{"action_id":"GEN-12"}', source: 'person',
      personMessages: ['b', 'c', 'Delete GEN-12'], toolsThisTurn: ['list_actions'],
    }, { userId: 'u', workspaceId: 'w', runId: 'conv-1', mode: 'shadow' })
    // A Mac call (mustEnforce, or its job named) is enforced.
    expect(await reviewRiskyCall({ ...base, mustEnforce: true })).toMatchObject({ mode: 'enforce' })
    expect(await reviewRiskyCall({ ...base, localAgent: { sessionId: 's-1' } })).toMatchObject({ mode: 'enforce' })
  })

  it('in shadow (the kill switch) it asks with the shadow mode', async () => {
    vi.stubEnv(ACTION_REVIEW_MODE_ENV, 'shadow')
    expect(await reviewRiskyCall(base)).toMatchObject({ verdict: 'allow', mode: 'shadow' })
    expect(mocks.decide.mock.calls[0][2]).toMatchObject({ mode: 'shadow' })
  })

  it('a no, an escalation or a thrown call is a block with its reason and a templated card', async () => {
    mocks.decide.mockResolvedValueOnce(deny)
    expect(await reviewRiskyCall(base)).toMatchObject({ verdict: 'block', reason: 'not_asked', inferenceId: 'inf-b',
      card: { title: 'Approve delete_action?', why: "This deletes something (delete_action), once, with exactly the inputs below; you didn't ask for that in this conversation." } })
    mocks.decide.mockResolvedValueOnce({ status: 'escalate', reason: 'temporarily_unavailable' })
    expect(await reviewRiskyCall(base)).toMatchObject({ verdict: 'block', reason: 'temporarily_unavailable',
      card: { why: "This deletes something (delete_action), once, with exactly the inputs below; Native Intelligence's safety check couldn't run just now, so it asks you first." } })
    mocks.decide.mockRejectedValueOnce(new Error('boom'))
    expect(await reviewRiskyCall(base)).toMatchObject({ verdict: 'block', reason: 'unavailable', card: { why: expect.stringContaining("couldn't run just now") } })
    mocks.decide.mockResolvedValueOnce({ status: 'escalate', reason: 'uncertain', inferenceId: 'inf-u' })
    expect(await reviewRiskyCall(base)).toMatchObject({ verdict: 'block', reason: 'uncertain', inferenceId: 'inf-u',
      card: { why: expect.stringContaining("Native Intelligence couldn't tell whether you asked for that in this conversation") } })
  })

  it('with no words to check against it blocks without asking Jev (a wake turn has none)', async () => {
    expect(await reviewRiskyCall({ ...base, personMessages: [] })).toMatchObject({ verdict: 'block', reason: 'no_request',
      card: { why: expect.stringContaining("it didn't come from a message you typed") } })
    expect(mocks.decide).not.toHaveBeenCalled()
  })

  it('shadow logs the card it would raise: ids and the class only, never the arguments or words', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    mocks.decide.mockResolvedValueOnce(deny)
    await reviewRiskyCall(base, false)
    const line = info.mock.calls.map((c) => c.join(' ')).find((l) => l.includes('[action-review] shadow'))!
    expect(line).toContain('"tool":"delete_action"')
    expect(line).toContain('"reason":"not_asked"')
    expect(line).not.toContain('GEN-12')
  })

  it('enforced, a block logs that the call is held: ids and the class only', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    mocks.decide.mockResolvedValueOnce(deny)
    await reviewRiskyCall(base, true)
    const line = info.mock.calls.map((c) => c.join(' ')).find((l) => l.includes('[action-review] blocked'))!
    expect(line).toContain('"reason":"not_asked"')
    expect(line).not.toContain('GEN-12')
  })

  it('a loop\'s card names its instructions', () => {
    const loop = { toolName: 'push_action_to_jira', sideEffect: 'external-write', source: 'loop_instructions' } as const
    expect(approvalCardCopy(loop).why)
      .toBe("This changes something outside Native Intelligence (push_action_to_jira), once, with exactly the inputs below; the loop's instructions don't ask for that.")
    expect(approvalCardCopy(loop, 'no_request').why).toContain('the loop has no saved instructions to check it against')
    expect(approvalCardCopy(loop, 'uncertain').why).toContain("Native Intelligence couldn't tell whether the loop's instructions ask for that")
    expect(approvalCardCopy(loop, 'deadline_exceeded').why).toContain("Native Intelligence's safety check couldn't run just now")
  })

  it('tells a judgement (not asked, unsure, no words) from a review that never ran', () => {
    for (const reason of ['not_asked', 'uncertain', 'no_request', 'asked']) expect(reviewCouldNotRun(reason), reason).toBe(false)
    for (const reason of ['unavailable', 'temporarily_unavailable', 'deadline_exceeded', 'budget_unavailable', 'accounting_unavailable', 'not_authorized', 'invalid_input', 'question_budget']) {
      expect(reviewCouldNotRun(reason), reason).toBe(true)
    }
    expect(refusalMessage('send_bot_message', 'not_asked')).toMatch(/hasn't asked for send_bot_message in their own words/)
    expect(refusalMessage('send_bot_message', 'unavailable')).toMatch(/safety check couldn't confirm the person asked for send_bot_message/)
    // An unattended caller has nobody to ask in chat (N8).
    for (const reason of ['not_asked', 'unavailable']) {
      const text = refusalMessage('send_bot_message', reason, 'agent_unattended')
      expect(text).not.toMatch(/ask them in chat|Ask them|Tell them/i)
      expect(text).toContain("Don't retry")
    }
  })
})

describe('reviewRiskyCall: stale words and loaders', () => {
  it('passes how many forwarded words are stale, re-based on the last three kept', async () => {
    await reviewRiskyCall({ ...base, personMessages: ['a', 'b', 'c', 'd'], personMessagesStale: 3 })
    expect(mocks.decide.mock.calls[0][1]).toMatchObject({ personMessages: ['b', 'c', 'd'], staleCount: 2 })
  })

  it('reads a words loader inside the review', async () => {
    const load = vi.fn(async () => ['Loop: push bugs to Linear.'])
    await reviewRiskyCall({ ...base, source: 'loop_instructions', personMessages: load })
    expect(load).toHaveBeenCalledTimes(1)
    expect(mocks.decide.mock.calls[0][1]).toMatchObject({ personMessages: ['Loop: push bugs to Linear.'], source: 'loop_instructions' })
  })

  it('a loader that throws is no words (a block, Jev never asked)', async () => {
    expect(await reviewRiskyCall({ ...base, personMessages: async () => { throw new Error('db down') } })).toMatchObject({ verdict: 'block', reason: 'no_request' })
    expect(mocks.decide).not.toHaveBeenCalled()
  })
})

describe('gateRiskyCall', () => {
  it('a call that is not risky just runs, with no review', async () => {
    const run = vi.fn(async () => 'ran')
    expect(await gateRiskyCall({ ...base, sideEffect: null }, run)).toEqual({ held: false, value: 'ran' })
    expect(mocks.decide).not.toHaveBeenCalled()
  })

  it('shadow: the call runs at once and the review is deferred past the response (no added latency)', async () => {
    mocks.decide.mockResolvedValue(deny)
    const deferred: Array<() => Promise<void>> = []
    const load = vi.fn(async () => ['Delete GEN-12'])
    const run = vi.fn(async () => ({ ok: true }))
    expect(await gateRiskyCall({ ...base, personMessages: load, defer: (task) => { deferred.push(task) } }, run, false)).toEqual({ held: false, value: { ok: true } })
    expect(run).toHaveBeenCalledTimes(1)
    // Nothing was read or asked before the response...
    expect(load).not.toHaveBeenCalled()
    expect(mocks.decide).not.toHaveBeenCalled()
    // ...the deferred task does both, and holds nothing.
    await deferred[0]()
    expect(load).toHaveBeenCalledTimes(1)
    expect(mocks.decide.mock.calls[0][2]).toMatchObject({ mode: 'shadow' })
    expect(mocks.approve).not.toHaveBeenCalled()
  })

  it('shadow: a throwing call still throws', async () => {
    await expect(gateRiskyCall({ ...base, defer: () => {} }, async () => { throw new Error('tool broke') }, false)).rejects.toThrow('tool broke')
  })

  it('enforce: an allow runs the call', async () => {
    const run = vi.fn(async () => 'ran')
    expect(await gateRiskyCall(base, run, true)).toEqual({ held: false, value: 'ran' })
    expect(mocks.decide.mock.calls[0][2]).toMatchObject({ mode: 'enforce' })
  })

  it('enforce: a block never runs the call and holds it as an approval for the person', async () => {
    mocks.decide.mockResolvedValue(deny)
    const run = vi.fn(async () => 'ran')
    const gated = await gateRiskyCall(base, run, true)
    expect(run).not.toHaveBeenCalled()
    expect(gated).toMatchObject({ held: true, output: { success: false, code: 'APPROVAL_REQUIRED', approval_id: 'appr-1' } })
    expect(mocks.approve).toHaveBeenCalledWith(base.approval.supabase, expect.objectContaining({
      door: 'chat', userId: 'u', workspaceId: 'w', toolName: 'delete_action', sideEffect: 'delete', input: { action_id: 'GEN-12' },
      conversationId: 'conv-1', context: { agentId: 'agent-1' }, decisionId: 'inf-b', reason: 'not_asked', personMessageSeq: 4,
      card: expect.objectContaining({ title: 'Approve delete_action?', why: expect.stringContaining('exactly the inputs below') }),
    }))
  })

  it('enforce: a chat-native tool (holdAs refusal) is refused, never carded', async () => {
    mocks.decide.mockResolvedValue(deny)
    const run = vi.fn(async () => 'sent')
    const gated = await gateRiskyCall({ ...base, toolName: 'send_bot_message', sideEffect: 'automation-write', holdAs: 'refusal' }, run, true)
    expect(gated).toMatchObject({ held: true, output: { code: 'NEEDS_PERSON', approval_id: null } })
    expect(run).not.toHaveBeenCalled()
    expect(mocks.approve).not.toHaveBeenCalled()
  })

  it('enforce: an unknown tool with no words fails closed (held, Jev never asked)', async () => {
    const run = vi.fn(async () => 'ran')
    const gated = await gateRiskyCall({ ...base, toolName: 'mystery', sideEffect: riskClassOf('mystery'), personMessages: [] }, run, true)
    expect(gated.held).toBe(true)
    expect(run).not.toHaveBeenCalled()
    expect(mocks.decide).not.toHaveBeenCalled()
  })

  it('enforce: when no approval was made the model is told why and that nothing ran', async () => {
    mocks.decide.mockResolvedValue(deny)
    mocks.approve.mockResolvedValueOnce({ ok: false, code: 'INPUT_TOO_LARGE', error: 'The inputs are too large to show on an approval card.' })
    const gated = await gateRiskyCall(base, async () => 'ran', true)
    expect(gated).toMatchObject({ held: true, output: { approval_id: null } })
    expect((gated as { output: { message: string } }).output.message).toMatch(/Nothing ran.*too large to show/)
  })
})

describe("holdEveryCallAs: a door's own ask first, over a call the reviewer would run", () => {
  const HOLD = { reason: 'guest_text', message: "Nothing ran: this needs the owner's OK.", cardWhy: 'Sam asked for it by text, and nothing they ask for runs without your OK' }
  const call = (over: Partial<GateRequest>): GateRequest => ({ ...base, toolName: 'create_action', sideEffect: null, input: { title: 'Milk' }, caller: 'guest', ...over })

  it("a guest's internal write is the owner's card, stored as an internal write, never run and never reviewed", async () => {
    const run = vi.fn(async () => 'ran')
    const gated = await holdEveryCallAs('internal-write', HOLD)(call({}), run)
    expect(gated).toEqual({ held: true, output: { success: false, code: 'APPROVAL_REQUIRED', approval_id: 'appr-1', message: HOLD.message } })
    expect(run).not.toHaveBeenCalled()
    expect(mocks.decide).not.toHaveBeenCalled()
    expect(mocks.approve).toHaveBeenCalledWith(base.approval.supabase, expect.objectContaining({
      toolName: 'create_action',
      sideEffect: 'internal-write',
      input: { title: 'Milk' },
      reason: 'guest_text',
      decisionId: null,
      card: { title: 'Approve create_action?', why: `This changes something in Native Intelligence (create_action), once, with exactly the inputs below; ${HOLD.cardWhy}.` },
    }))
  })

  it('the person themselves gets the card too; anyone else, or a refusal-only tool, is refused (never run)', async () => {
    const run = vi.fn(async () => 'ran')
    for (const caller of ['person', 'person_remote'] as const) {
      expect(await holdEveryCallAs('internal-write', HOLD)(call({ caller }), run)).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED' } })
    }
    mocks.approve.mockClear()
    for (const over of [{ holdAs: 'refusal' as const }, { caller: 'agent_unattended' as const }, { caller: 'other_person' as const }, { caller: undefined }]) {
      expect(await holdEveryCallAs('internal-write', HOLD)(call(over), run)).toMatchObject({ held: true, output: { code: 'NEEDS_PERSON', approval_id: null } })
    }
    expect(mocks.approve).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
})

describe('gateRiskyCall: a text turn holds every risky call (alwaysHold), whatever the mode', () => {
  const HOLD = { reason: 'text_turn', message: "Nothing ran. Tell them: I've put it in Native Intelligence for you to approve." }
  const textTurn = (over: Partial<GateRequest>): GateRequest => ({ ...base, caller: 'person_remote', alwaysHold: HOLD, defer: () => {}, ...over })

  it.each([
    ['delete_action', 'delete'],
    ['push_action_to_linear', 'external-write'],
    ['publish_prospect_list', 'external-write'],
    ['delete_calendar_event', 'delete'],
    ['update_calendar_event', 'external-write'],
    ['mcp__gmail__send_email', 'unclassified'],
  ])('%s (%s) is the person’s card, never run, even in shadow and with an allowing reviewer', async (toolName, cls) => {
    expect(riskClassOf(toolName)).toBe(cls)
    mocks.decide.mockResolvedValue({ verdict: 'allow' })
    const run = vi.fn(async () => 'ran')
    for (const enforce of [false, true]) {
      const gated = await gateRiskyCall(textTurn({ toolName, sideEffect: riskClassOf(toolName) }), run, enforce)
      expect(gated).toEqual({ held: true, output: { success: false, code: 'APPROVAL_REQUIRED', approval_id: 'appr-1', message: HOLD.message } })
    }
    expect(run).not.toHaveBeenCalled()
    expect(mocks.approve).toHaveBeenCalledWith(base.approval.supabase, expect.objectContaining({ toolName, reason: 'text_turn', decisionId: null }))
  })

  it('the card says why it waits in the hold’s own words: they did ask, by text', async () => {
    const hold = { ...HOLD, cardWhy: 'you asked for it by text, and a text alone never runs it' }
    await gateRiskyCall(textTurn({ toolName: 'delete_action', sideEffect: 'delete', alwaysHold: hold }), async () => 'ran')
    expect(mocks.approve).toHaveBeenCalledWith(base.approval.supabase, expect.objectContaining({
      card: { title: 'Approve delete_action?', why: 'This deletes something (delete_action), once, with exactly the inputs below; you asked for it by text, and a text alone never runs it.' },
    }))
  })

  it('the person’s own items still change: an internal write (no risk class) runs', async () => {
    const run = vi.fn(async () => 'ran')
    expect(riskClassOf('create_action')).toBeNull()
    expect(await gateRiskyCall(textTurn({ toolName: 'create_action', sideEffect: riskClassOf('create_action') }), run)).toEqual({ held: false, value: 'ran' })
    expect(mocks.approve).not.toHaveBeenCalled()
  })

  it('a chat-native refusal, or nobody to hand a card to (a caller other than the person), is refused (never run)', async () => {
    const run = vi.fn(async () => 'ran')
    const overs: Partial<GateRequest>[] = [{ holdAs: 'refusal' }, { caller: 'agent_unattended' }, { caller: 'other_person' }, { caller: undefined }]
    for (const over of overs) {
      const gated = await gateRiskyCall(textTurn({ ...over }), run)
      expect(gated).toMatchObject({ held: true, output: { code: 'NEEDS_PERSON', approval_id: null } })
    }
    expect(run).not.toHaveBeenCalled()
  })

  it("a guest's risky call (guest access) is the owner's card, never run, whatever the mode", async () => {
    mocks.decide.mockResolvedValue({ verdict: 'allow' })
    const run = vi.fn(async () => 'ran')
    for (const enforce of [false, true]) {
      const gated = await gateRiskyCall(textTurn({ caller: 'guest', toolName: 'update_calendar_event', sideEffect: 'external-write' }), run, enforce)
      expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED', approval_id: 'appr-1' } })
    }
    expect(run).not.toHaveBeenCalled()
  })
})

describe('the mode (ACTION_REVIEW_MODE)', () => {
  it('unset or empty is the default; blocking and shadow as said; anything else is blocking', () => {
    expect(actionReviewMode({})).toBe('default')
    expect(actionReviewMode({ [ACTION_REVIEW_MODE_ENV]: '  ' })).toBe('default')
    expect(actionReviewMode({ [ACTION_REVIEW_MODE_ENV]: ' Default ' })).toBe('default')
    expect(actionReviewMode({ [ACTION_REVIEW_MODE_ENV]: 'blocking' })).toBe('blocking')
    expect(actionReviewMode({ [ACTION_REVIEW_MODE_ENV]: ' Shadow ' })).toBe('shadow')
  })

  it('any other value is blocking, with a warning (a typo never opens the gate)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const value of ['shdow', 'off', 'enforce', 'defualt']) expect(actionReviewMode({ [ACTION_REVIEW_MODE_ENV]: value }), value).toBe('blocking')
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('env_unknown_value')
  })

  it('says its mode once per value, never a line per call', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    for (let i = 0; i < 5; i++) actionReviewMode({ [ACTION_REVIEW_MODE_ENV]: 'blocking' })
    expect(info.mock.calls.filter((c) => String(c[0]).includes('[action-review] mode'))).toHaveLength(1)
  })

  it('who it blocks: the default blocks the Mac body alone; blocking everyone; shadow no one', () => {
    const table: Array<[Parameters<typeof reviewerBlocks>[1], boolean, boolean, boolean]> = [
      // who,                                              default, blocking, shadow
      [{ caller: 'person' }, false, true, false],
      [{ caller: 'person_remote' }, false, true, false],
      [{ caller: 'agent_unattended' }, false, true, false],
      [{ caller: 'other_person' }, false, true, false],
      [{ caller: 'unknown' }, false, true, false],
      [{}, false, true, false],
      [{ caller: 'person', mustEnforce: true }, true, true, false],
      [{ caller: 'person_remote', mustEnforce: true }, true, true, false],
      [{ caller: 'agent_unattended', mustEnforce: true }, true, true, false],
    ]
    for (const [who, byDefault, blocking, shadow] of table) {
      expect(reviewerBlocks('default', who), `default ${JSON.stringify(who)}`).toBe(byDefault)
      expect(reviewerBlocks('blocking', who), `blocking ${JSON.stringify(who)}`).toBe(blocking)
      expect(reviewerBlocks('shadow', who), `shadow ${JSON.stringify(who)}`).toBe(shadow)
    }
  })

  it('the default: everything that runs today stays shadow (a typed turn, a relayed turn, a loop that doesn’t use the Mac)', async () => {
    mocks.decide.mockResolvedValue(deny)
    for (const request of [
      { ...base, caller: 'person' as const },
      { ...base, caller: 'agent_unattended' as const },
      { ...base, door: 'skill_run' as const, caller: 'agent_unattended' as const, source: 'loop_instructions' as const },
    ]) {
      const deferred: Array<() => Promise<void>> = []
      const run = vi.fn(async () => 'ran')
      expect(await gateRiskyCall({ ...request, defer: (task) => { deferred.push(task) } }, run), `${request.door} ${request.caller}`).toEqual({ held: false, value: 'ran' })
      expect(deferred).toHaveLength(1)
    }
    expect(mocks.approve).not.toHaveBeenCalled()
  })

  it('the default: every Mac call (mustEnforce) is held, whoever the caller', async () => {
    mocks.decide.mockResolvedValue(deny)
    for (const caller of ['person', 'person_remote', 'agent_unattended'] as const) {
      const run = vi.fn(async () => 'ran')
      expect(await gateRiskyCall({ ...base, caller, mustEnforce: true }, run), caller).toMatchObject({ held: true })
      expect(run).not.toHaveBeenCalled()
    }
    expect(mocks.decide.mock.calls.every((c) => c[2].mode === 'enforce')).toBe(true)
  })

  it('a call whose approval names a Mac job is a Mac call, even when the door forgot mustEnforce (S6)', async () => {
    mocks.decide.mockResolvedValue(deny)
    const run = vi.fn(async () => 'ran')
    const gated = await gateRiskyCall({ ...base, caller: 'person', approval: { ...base.approval, context: { localAgent: { sessionId: 's-1' } } } }, run)
    expect(gated).toMatchObject({ held: true })
    expect(run).not.toHaveBeenCalled()
  })

  it('the test seam can switch the reviewer on, never off for a Mac call: only the kill switch does (N1)', async () => {
    mocks.decide.mockResolvedValue(deny)
    const run = vi.fn(async () => 'ran')
    expect(await gateRiskyCall({ ...base, mustEnforce: true }, run, false)).toMatchObject({ held: true })
    expect(await gateRiskyCall({ ...base, approval: { ...base.approval, context: { localAgent: { sessionId: 's-1' } } } }, run, false)).toMatchObject({ held: true })
    expect(await gateRiskyCall({ ...base, caller: 'person' }, run, true)).toMatchObject({ held: true })
    expect(run).not.toHaveBeenCalled()
    vi.stubEnv(ACTION_REVIEW_MODE_ENV, 'shadow')
    expect(await gateRiskyCall({ ...base, mustEnforce: true, defer: () => {} }, run, false)).toEqual({ held: false, value: 'ran' })
  })

  it('blocking: the person’s own typed call is held too', async () => {
    vi.stubEnv(ACTION_REVIEW_MODE_ENV, 'blocking')
    mocks.decide.mockResolvedValue(deny)
    const run = vi.fn(async () => 'ran')
    expect(await gateRiskyCall({ ...base, caller: 'person' }, run)).toMatchObject({ held: true })
    expect(run).not.toHaveBeenCalled()
  })

  it('shadow (the kill switch): everyone’s call runs, a Mac call’s included, and the review is deferred', async () => {
    vi.stubEnv(ACTION_REVIEW_MODE_ENV, 'shadow')
    mocks.decide.mockResolvedValue(deny)
    for (const request of [{ ...base, caller: 'agent_unattended' as const }, { ...base, caller: 'person' as const, mustEnforce: true as const }]) {
      const deferred: Array<() => Promise<void>> = []
      const run = vi.fn(async () => 'ran')
      expect(await gateRiskyCall({ ...request, defer: (task) => { deferred.push(task) } }, run)).toEqual({ held: false, value: 'ran' })
      expect(deferred).toHaveLength(1)
    }
    expect(mocks.approve).not.toHaveBeenCalled()
  })
})

describe('blocking: allow, deny, the reviewer unavailable, attended or not', () => {
  beforeEach(() => {
    vi.stubEnv(ACTION_REVIEW_MODE_ENV, 'blocking')
  })
  const unattended = {
    ...base, caller: 'agent_unattended' as const, source: 'loop_instructions' as const, personMessages: ['Every morning, tidy the triage board.'],
  }

  it('allow: the call runs, attended or unattended', async () => {
    for (const request of [{ ...base, caller: 'person' as const }, unattended]) {
      const run = vi.fn(async () => 'ran')
      expect(await gateRiskyCall(request, run)).toEqual({ held: false, value: 'ran' })
      expect(run).toHaveBeenCalledTimes(1)
    }
  })

  it('deny: nothing runs; the person gets a card that says why, and the model reads APPROVAL_REQUIRED', async () => {
    mocks.decide.mockResolvedValue(deny)
    const run = vi.fn(async () => 'ran')
    const gated = await gateRiskyCall({ ...base, caller: 'person' }, run)
    expect(run).not.toHaveBeenCalled()
    expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED', approval_id: 'appr-1', message: expect.stringContaining('right under your message') } })
    expect(mocks.approve).toHaveBeenCalledWith(base.approval.supabase, expect.objectContaining({
      reason: 'not_asked', card: expect.objectContaining({ why: expect.stringContaining("you didn't ask for that") }),
    }))
  })

  it('attended, the reviewer unavailable: fails closed to the person\'s card (one tap), never a run', async () => {
    for (const failure of [() => mocks.decide.mockRejectedValueOnce(new Error('gateway down')),
      () => mocks.decide.mockResolvedValueOnce({ status: 'escalate', reason: 'deadline_exceeded' })]) {
      mocks.approve.mockClear()
      failure()
      const run = vi.fn(async () => 'ran')
      const gated = await gateRiskyCall({ ...base, caller: 'person' }, run)
      expect(run).not.toHaveBeenCalled()
      expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED' } })
      expect(mocks.approve).toHaveBeenCalledWith(base.approval.supabase, expect.objectContaining({
        card: expect.objectContaining({ why: expect.stringContaining("Native Intelligence's safety check couldn't run just now") }),
      }))
    }
  })

  it('unattended, the reviewer unavailable: fails closed; the run is told to carry on without it', async () => {
    mocks.decide.mockRejectedValue(new Error('gateway down'))
    const run = vi.fn(async () => 'ran')
    const gated = await gateRiskyCall(unattended, run)
    expect(run).not.toHaveBeenCalled()
    expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED' } })
    const message = (gated as { output: { message: string } }).output.message
    expect(message).toContain('carry on without it')
    expect(message).not.toContain('right under your message')
  })

  it('unattended with no saved words: held without asking Jev', async () => {
    const run = vi.fn(async () => 'ran')
    expect(await gateRiskyCall({ ...unattended, personMessages: async () => [] }, run)).toMatchObject({ held: true })
    expect(run).not.toHaveBeenCalled()
    expect(mocks.decide).not.toHaveBeenCalled()
    expect(mocks.approve).toHaveBeenCalledWith(base.approval.supabase, expect.objectContaining({ reason: 'no_request' }))
  })

  it('a chat-native refusal says honestly when the check could not run', async () => {
    mocks.decide.mockResolvedValue({ status: 'escalate', reason: 'temporarily_unavailable' })
    const gated = await gateRiskyCall({ ...base, toolName: 'start_helper', sideEffect: 'automation-write', holdAs: 'refusal' }, async () => 'ran')
    expect(gated).toMatchObject({ held: true, output: { code: 'NEEDS_PERSON', message: expect.stringContaining("couldn't run just now") } })
  })
})

describe('cards from the Native Intelligence agent on the Mac (C1: approval.context.localAgent)', () => {
  const localAgent = { sessionId: 'sess-1', deviceName: 'Liam’s MacBook', folderLabel: 'dial8-website' }
  const mac = { ...base, caller: 'person_remote' as const, mustEnforce: true as const, approval: { ...base.approval, conversationId: null, context: { localAgent } } }

  it('the card names Native Intelligence on the Mac and the job, and why, against the job’s own request', async () => {
    mocks.decide.mockResolvedValue(deny)
    const gated = await gateRiskyCall(mac, async () => 'ran')
    expect(mocks.approve).toHaveBeenCalledWith(base.approval.supabase, expect.objectContaining({
      conversationId: null, context: { localAgent },
      card: {
        title: 'Approve delete_action from Native Intelligence on Liam’s MacBook?',
        why: "Native Intelligence on Liam’s MacBook wants this for its job in dial8-website: it deletes something (delete_action), once, with exactly the inputs below; you didn't ask the job for that.",
      },
    }))
    const message = (gated as { output: { message: string } }).output.message
    expect(message).toContain('home thread')
    expect(message).not.toContain('right under your message')
  })

  it('a loop’s job, an unsure answer, no words, the check down: each says so', () => {
    const copy = (reason: string, source: 'person' | 'loop_instructions' = 'person') => approvalCardCopy({ toolName: 'delete_action', sideEffect: 'delete', source, localAgent }, reason).why
    expect(copy('not_asked', 'loop_instructions')).toContain("the loop's request for the job doesn't ask for that")
    expect(copy('uncertain')).toContain("Native Intelligence couldn't tell whether you asked the job for that")
    expect(copy('no_request')).toContain('the job has no request of yours to check it against')
    expect(copy('no_request', 'loop_instructions')).toContain('the loop that started the job has no saved request')
    expect(copy('unavailable')).toContain("Native Intelligence's safety check couldn't run just now")
    expect(copy('not_asked')).not.toContain('this conversation')
  })

  it('an outward hold (a connected app’s write) names the Mac and the job too', async () => {
    const gated = await gateRiskyCall({ ...mac, toolName: 'mcp__linear__create_issue', sideEffect: 'unclassified', input: { title: 'x' }, externalTool: { serverName: 'Linear', requiresApproval: true } }, async () => 'ran')
    expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED' } })
    expect(mocks.approve).toHaveBeenCalledWith(base.approval.supabase, expect.objectContaining({
      card: expect.objectContaining({ why: expect.stringMatching(/^Native Intelligence on Liam’s MacBook, for its job in dial8-website: This runs a tool on Linear/) }),
    }))
  })
})

describe('the outward gate’s card offers Always allow (mcp-client/always-allow.ts)', () => {
  const write = { ...base, caller: 'person' as const, toolName: 'mcp__linear__create_issue', sideEffect: 'unclassified' as const, input: { title: 'x' } }
  const policy = { serverName: 'Linear', requiresApproval: true, serverId: 'srv-1', toolName: 'create_issue', alwaysAsks: false }
  const offerOf = () => (mocks.approve.mock.calls.at(-1) as unknown[] | undefined)?.[1] as Record<string, unknown> | undefined

  it('a connected app’s write its permission held, in the person’s own chat: offered with the server and the tool’s own name', async () => {
    await gateRiskyCall({ ...write, externalTool: policy }, async () => 'ran')
    expect(offerOf()).toMatchObject({ reason: 'mcp_write', alwaysAllow: { serverId: 'srv-1', tool: 'create_issue' } })
  })

  it('none for a tool that always asks, a policy that doesn’t name its server, or a job on the Mac', async () => {
    const onMac = { ...write, approval: { ...base.approval, context: { localAgent: { sessionId: 's-1' } } } }
    for (const request of [
      { ...write, externalTool: { ...policy, alwaysAsks: true } },
      { ...write, externalTool: { serverName: 'Linear', requiresApproval: true } },
      { ...onMac, externalTool: policy },
    ]) {
      mocks.approve.mockClear()
      await gateRiskyCall(request, async () => 'ran')
      expect(mocks.approve).toHaveBeenCalledTimes(1)
      expect(offerOf()).not.toHaveProperty('alwaysAllow')
    }
  })
})

describe('doors with no reviewer: their ceilings cannot reach a risky tool', () => {
  const risky = (name: string) => {
    const cls = getToolSideEffect(name)
    return cls === 'external-write' || cls === 'delete' || cls === 'automation-write'
  }

  it('a work run holds no external-write, delete or automation-write tool', () => {
    expect([...computeWorkRunCeiling()].filter(risky)).toEqual([])
  })

  it('the live agent holds none on any turn type', () => {
    for (const turnType of LIVE_AGENT_TURN_TYPES) {
      for (const assistOnly of [false, true]) {
        const { ceiling } = computeLiveAgentCeiling({ turnType, assistOnly, agentConfig: null })
        expect([...ceiling].filter(risky), `${turnType} assistOnly=${assistOnly}`).toEqual([])
      }
    }
  })
})
