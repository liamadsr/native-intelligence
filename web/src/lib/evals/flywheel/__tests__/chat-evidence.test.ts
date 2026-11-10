/**
 * Stored chat turns as evidence (chat-evidence.ts), against parts shaped the
 * way src/lib/chat/eve-turn-parts.ts stores them: `dynamic-tool` parts with
 * an output-error and the spec client's `"<tool>: <error> [<CODE>] — …"`
 * errorText, the repeat breaker's `{ success: false, code:
 * 'REPEATED_FAILURE' }` output, the chat-agent's `load_skill` with input `{
 * skill }`, and text parts. A turn that touched mail keeps no reply; a turn
 * nobody typed (a home turn) says what started it instead of a request. Plus
 * the loader: scoped to the conversation and its owner, the request from the
 * closest earlier user row (never for a home turn), null until the message is
 * persisted.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { buildChatTurnEvidence, errorCodeOf, failureCodesOf, loadChatTurnEvidence, messageText, nudgePointers, serverStartedRequest, stepOf } from '../chat-evidence'
import { FLYWHEEL_LIMITS } from '../types'
import { assistantMessage, nudgeMessage, userMessage } from './fixtures'

const CONV = 'c1000000-0000-4000-8000-000000000001'
const USER = 'b1000000-0000-4000-8000-000000000001'


describe('stepOf', () => {
  it('an output-error part: not ok, the [CODE] from errorText, the error clipped', () => {
    const step = stepOf(assistantMessage().parts[2] as Record<string, unknown> & { type: string })!
    expect(step).toMatchObject({ name: 'list_actions', ok: false, code: 'INPUT_INVALID', input: '{"status":"finished"}' })
    expect(step.error!.length).toBeLessThanOrEqual(FLYWHEEL_LIMITS.stepError)
  })

  it('an output with success:false: not ok, the code from output.code', () => {
    const step = stepOf(assistantMessage().parts[3] as Record<string, unknown> & { type: string })!
    expect(step).toMatchObject({ name: 'update_action', ok: false, code: 'REPEATED_FAILURE', error: 'This exact call failed 3 times. Stop retrying it.' })
  })

  it('a success keeps no code or error', () => {
    const step = stepOf({ type: 'dynamic-tool', toolName: 'list_actions', state: 'output-available', input: {}, output: { success: true, code: 'OK' } })!
    expect(step).toEqual({ name: 'list_actions', ok: true })
  })

  it('a static AI SDK tool part (tool-<name>) reads the same', () => {
    expect(stepOf({ type: 'tool-get_contact', state: 'output-error', input: { id: 'x' }, errorText: 'get_contact: not found [NOT_FOUND]' })).toMatchObject({
      name: 'get_contact',
      ok: false,
      code: 'NOT_FOUND',
    })
  })

  it('a mail tool keeps no mail text from its input', () => {
    const step = stepOf(assistantMessage().parts[4] as Record<string, unknown> & { type: string })!
    expect(step.input).not.toContain('Pricing for Acme')
    expect(step.input).not.toContain('Hi Dana')
    expect(step.input).toContain('thr-1')
  })

  it('a non-tool part is no step', () => {
    expect(stepOf({ type: 'text', text: 'hi' })).toBeNull()
  })

  it('errorCodeOf reads the first [CODE] only', () => {
    expect(errorCodeOf('x: y [INPUT_INVALID] — z [OTHER]')).toBe('INPUT_INVALID')
    expect(errorCodeOf('no code here [x]')).toBeUndefined()
  })
})

describe('buildChatTurnEvidence', () => {
  it('builds the request, the steps in order, the loads, the columns', () => {
    const build = buildChatTurnEvidence(
      { role: 'assistant', ui_message: assistantMessage(), ui_message_id: 'msg-a1', created_at: '2026-10-16T10:00:00.000Z' },
      { role: 'user', ui_message: userMessage('Move ENG-1 to done please') },
    )
    expect(build.evidence).toMatchObject({
      kind: 'chat_turn',
      request: 'Move ENG-1 to done please',
      loads: ['triage'],
      messageId: 'msg-a1',
      at: '2026-10-16T10:00:00.000Z',
    })
    // The fixture's turn drafted an email: no reply is kept (the next test keeps one).
    expect(build.evidence.reply).toBeUndefined()
    expect(build.evidence.steps.map((s) => [s.name, s.ok, s.code])).toEqual([
      ['load_skill', true, undefined],
      ['list_actions', false, 'INPUT_INVALID'],
      ['update_action', false, 'REPEATED_FAILURE'],
      ['create_email_draft', true, undefined],
    ])
    expect(build.skillSlugs).toEqual(['triage'])
    expect(build.tools).toEqual(['load_skill', 'list_actions', 'update_action', 'create_email_draft'])
    // The reasoning part is never evidence.
    expect(JSON.stringify(build.evidence)).not.toContain('wants ENG-1')
  })

  it('keeps the reply opening of a turn that touched no mail', () => {
    const message = assistantMessage()
    message.parts = message.parts.filter((p) => !('toolName' in p) || p.toolName !== 'create_email_draft')
    const build = buildChatTurnEvidence({ role: 'assistant', ui_message: message }, { role: 'user', ui_message: userMessage('Move ENG-1 to done please') })
    expect(build.evidence.reply).toBe('I could not move ENG-1 to Done.\n\nWant me to try another way?')
  })

  it('a turn that touched mail keeps the request and the tool path, never the reply', () => {
    const reply = { type: 'text', text: 'Dana says the renewal slips to March and pricing is too high.' }
    const turn = (tool: Record<string, unknown>) =>
      buildChatTurnEvidence({ role: 'assistant', ui_message: { id: 'm', parts: [tool, reply] } }, { role: 'user', ui_message: userMessage('What did Dana say?') })
    const cases = [
      // A mail tool, however it is named (an MCP prefix too).
      { type: 'dynamic-tool', toolName: 'read_email', state: 'output-available', input: { thread_id: 'thr-1' }, output: { scrubbed: 'mail', thread_id: 'thr-1' } },
      { type: 'dynamic-tool', toolName: 'ni_list_emails', state: 'output-available', input: {}, output: { scrubbed: 'mail', count: 3 } },
      { type: 'tool-get_email_drafts', state: 'output-available', input: {}, output: { scrubbed: 'mail' } },
      { type: 'dynamic-tool', toolName: 'revise_email_draft', state: 'output-error', input: { draft_id: 'd-1' }, errorText: 'boom' },
      // Any other tool whose output carried mail rows (the scrub marked them).
      { type: 'dynamic-tool', toolName: 'search', state: 'output-available', input: { query: 'Dana' }, output: { results: [{ result_type: 'email', result_id: 'e-1', title: 'Email', scrubbed: 'mail' }] } },
      { type: 'dynamic-tool', toolName: 'get_contact_details', state: 'output-available', input: { id: 'c-1' }, output: { contact: { recent_email_threads: [{ thread_id: 'thr-1', scrubbed: 'mail' }] } } },
    ]
    for (const tool of cases) {
      const build = turn(tool)
      expect(build.evidence.reply).toBeUndefined()
      expect(JSON.stringify(build.evidence)).not.toContain('renewal')
      expect(build.evidence.request).toBe('What did Dana say?')
      expect(build.evidence.steps).toHaveLength(1)
    }
    // A tool that touched no mail keeps it.
    expect(turn({ type: 'dynamic-tool', toolName: 'search', state: 'output-available', input: { query: 'Dana' }, output: { results: [{ result_type: 'capture', result_id: 'k-1' }] } }).evidence.reply).toBe(reply.text)
  })

  it('a home turn the server started: what started it is the request, whatever came before', () => {
    const home = { id: 'home-turn:h1', role: 'assistant', metadata: { kind: 'home_turn', home_turn_id: 'h1', reason: 'helper_report' }, parts: [{ type: 'text', text: 'Your triage helper finished: 3 actions need you.' }] }
    expect(serverStartedRequest(home)).toMatch(/home turn.*helper_report/)
    const build = buildChatTurnEvidence({ role: 'assistant', ui_message: home, ui_message_id: 'home-turn:h1' }, { role: 'user', ui_message: userMessage('an unrelated earlier ask') })
    expect(build.evidence.request).toMatch(/nobody typed this.*helper_report/)
    expect(build.evidence.reply).toBe('Your triage helper finished: 3 actions need you.')
    expect(build.evidence.messageId).toBe('home-turn:h1')
    // An ordinary reply, and a notice row, are not server-started turns.
    expect(serverStartedRequest(assistantMessage())).toBeNull()
    expect(serverStartedRequest({ role: 'assistant', metadata: { kind: 'teammate_report' } })).toBeNull()
    expect(serverStartedRequest({ role: 'assistant', metadata: { kind: 'say_to_user' } })).toMatch(/live agent/)
  })

  it('a failed load_skill counts the skill it asked for', () => {
    const build = buildChatTurnEvidence(
      { role: 'assistant', ui_message: { id: 'm', parts: [{ type: 'dynamic-tool', toolName: 'load_skill', state: 'output-error', input: { skill: 'groom' }, errorText: 'boom' }] } },
      null,
    )
    expect(build.evidence.loads).toEqual(['groom'])
    expect(build.evidence.request).toBe('')
    expect(build.evidence.messageId).toBe('m')
    expect(build.evidence.reply).toBeUndefined()
  })

  it('caps the steps and clips the texts', () => {
    const parts = Array.from({ length: 45 }, (_, i) => ({ type: 'dynamic-tool', toolName: `t${i}`, state: 'output-available', input: { q: 'x'.repeat(2000) }, output: {} }))
    const build = buildChatTurnEvidence({ role: 'assistant', ui_message: { id: 'm', parts: [...parts, { type: 'text', text: 'y'.repeat(5000) }] } }, { role: 'user', ui_message: userMessage('z'.repeat(5000)) })
    expect(build.evidence.steps).toHaveLength(FLYWHEEL_LIMITS.steps)
    expect(build.tools).toHaveLength(FLYWHEEL_LIMITS.tools)
    expect(build.evidence.steps[0].input!.length).toBeLessThanOrEqual(FLYWHEEL_LIMITS.stepInput)
    expect(build.evidence.reply!.length).toBeLessThanOrEqual(FLYWHEEL_LIMITS.reply)
    expect(build.evidence.request.length).toBeLessThanOrEqual(FLYWHEEL_LIMITS.request)
  })

  it('tolerates junk ui_message shapes', () => {
    expect(buildChatTurnEvidence({ role: 'assistant', ui_message: null }, null).evidence.steps).toEqual([])
    expect(messageText({ parts: 'nope' })).toBe('')
  })
})

describe('failureCodesOf', () => {
  it('the sweep codes present, each once, in a fixed order', () => {
    const build = buildChatTurnEvidence({ role: 'assistant', ui_message: assistantMessage() }, null)
    expect(failureCodesOf(build.evidence)).toEqual(['REPEATED_FAILURE', 'INPUT_INVALID'])
  })

  it('other codes and successes are not sweep codes', () => {
    expect(failureCodesOf({ steps: [{ name: 'a', ok: false, code: 'NOT_FOUND' }, { name: 'b', ok: true }] })).toEqual([])
  })
})

describe('loadChatTurnEvidence', () => {
  function seeded() {
    const fake = makeFakeSupabase()
    fake.seed('chat_messages', [
      { id: 'r0', conversation_id: CONV, user_id: USER, role: 'user', ui_message: userMessage('an older ask', 'msg-u0'), ui_message_id: 'msg-u0', created_at: '2026-10-16T09:00:00.000Z' },
      { id: 'r1', conversation_id: CONV, user_id: USER, role: 'user', ui_message: userMessage('Move ENG-1 to done'), ui_message_id: 'msg-u1', created_at: '2026-10-16T09:59:00.000Z' },
      { id: 'r2', conversation_id: CONV, user_id: USER, role: 'assistant', ui_message: assistantMessage(), ui_message_id: 'msg-a1', created_at: '2026-10-16T10:00:00.000Z' },
      { id: 'r3', conversation_id: CONV, user_id: USER, role: 'user', ui_message: userMessage('a later ask', 'msg-u2'), ui_message_id: 'msg-u2', created_at: '2026-10-16T10:05:00.000Z' },
    ])
    return fake
  }

  it('the assistant message and the closest earlier user message', async () => {
    const fake = seeded()
    const build = await loadChatTurnEvidence(fake as unknown as SupabaseClient, { conversationId: CONV, userId: USER, messageId: 'msg-a1' })
    expect(build?.evidence.request).toBe('Move ENG-1 to done')
    expect(build?.evidence.messageId).toBe('msg-a1')
  })

  it('a home turn records with no earlier user message read (none may exist)', async () => {
    const fake = makeFakeSupabase()
    const home = { id: 'home-turn:h1', role: 'assistant', metadata: { kind: 'home_turn', home_turn_id: 'h1', reason: 'digest' }, parts: [{ type: 'text', text: 'Your morning digest.' }] }
    fake.seed('chat_messages', [
      { id: 'r9', conversation_id: CONV, user_id: USER, role: 'assistant', ui_message: home, ui_message_id: 'home-turn:h1', created_at: '2026-10-16T08:00:00.000Z' },
    ])
    const build = await loadChatTurnEvidence(fake as unknown as SupabaseClient, { conversationId: CONV, userId: USER, messageId: 'home-turn:h1' })
    expect(build?.evidence).toMatchObject({ messageId: 'home-turn:h1', reply: 'Your morning digest.' })
    expect(build?.evidence.request).toMatch(/digest/)
    // Seeded with an earlier user message, the home turn still never takes it as its request.
    const withAsk = seeded()
    withAsk.seed('chat_messages', [{ id: 'r9', conversation_id: CONV, user_id: USER, role: 'assistant', ui_message: home, ui_message_id: 'home-turn:h1', created_at: '2026-10-16T11:00:00.000Z' }])
    const again = await loadChatTurnEvidence(withAsk as unknown as SupabaseClient, { conversationId: CONV, userId: USER, messageId: 'home-turn:h1' })
    expect(again?.evidence.request).not.toContain('later ask')
  })

  it('null for a message not persisted yet, a user message, or another person', async () => {
    const fake = seeded()
    const db = fake as unknown as SupabaseClient
    expect(await loadChatTurnEvidence(db, { conversationId: CONV, userId: USER, messageId: 'msg-nope' })).toBeNull()
    expect(await loadChatTurnEvidence(db, { conversationId: CONV, userId: USER, messageId: 'msg-u1' })).toBeNull()
    expect(await loadChatTurnEvidence(db, { conversationId: CONV, userId: 'someone-else', messageId: 'msg-a1' })).toBeNull()
  })
})

describe('a nudge’s evidence: pointers, never the meeting’s words', () => {
  const WS = 'a1000000-0000-4000-8000-000000000001'
  const CAPTURE = 'd1000000-0000-4000-8000-000000000001'
  const NUDGE_ID = 'e1000000-0000-4000-8000-000000000001'
  const AT = '2026-10-16T10:03:00.000Z'
  const TRANSCRIPT = 'Dana: our budget is forty thousand and the board meets Friday'
  const GOAL_TEXT = 'Get Dana to agree to a pilot'

  function nudgeDb(opts: { goal?: boolean } = {}) {
    const fake = makeFakeSupabase()
    fake.seed('chat_conversations', [{ id: CONV, user_id: USER, workspace_id: WS, capture_id: CAPTURE }])
    // The capture's words live elsewhere; none of them may reach the evidence.
    fake.seed('captures', [{ id: CAPTURE, user_id: USER, workspace_id: WS, transcript: TRANSCRIPT, calendar_event_id: null }])
    fake.seed('capture_transcripts', [{ capture_id: CAPTURE, text: TRANSCRIPT }])
    fake.seed('chat_messages', [
      { id: 'r1', conversation_id: CONV, user_id: USER, role: 'user', ui_message: userMessage('an earlier ask'), ui_message_id: 'msg-u1', created_at: '2026-10-16T10:00:00.000Z' },
      { id: 'r2', conversation_id: CONV, user_id: USER, role: 'assistant', ui_message: nudgeMessage(NUDGE_ID, 'Ask whether Friday’s board meeting decides it.', 'suggestion', CAPTURE), ui_message_id: NUDGE_ID, created_at: AT },
    ])
    if (opts.goal) {
      fake.seed('meeting_goal', [
        { id: 'f1000000-0000-4000-8000-000000000001', workspace_id: WS, user_id: USER, capture_id: CAPTURE, calendar_event_id: `capture:${CAPTURE}`, starts_at: '2026-10-16T10:00:00.000Z', goal: GOAL_TEXT, source: 'hud', updated_at: AT },
      ])
    }
    return fake
  }

  it('carries nudge_kind, capture_id, nudge_at and the goal id; no transcript, no goal text', async () => {
    const fake = nudgeDb({ goal: true })
    const build = await loadChatTurnEvidence(fake as unknown as SupabaseClient, { conversationId: CONV, userId: USER, messageId: NUDGE_ID })
    expect(build?.evidence).toMatchObject({
      kind: 'chat_turn',
      messageId: NUDGE_ID,
      nudge_kind: 'suggestion',
      capture_id: CAPTURE,
      nudge_at: AT,
      meeting_goal_id: 'f1000000-0000-4000-8000-000000000001',
    })
    // Nobody typed it: never the earlier ask.
    expect(build?.evidence.request).toMatch(/nudge the live agent sent/)
    // The rated nudge itself is the reply (the agent's own words, clipped as before).
    expect(build?.evidence.reply).toBe('Ask whether Friday’s board meeting decides it.')
    expect(Object.keys(build!.evidence).sort()).toEqual(
      ['at', 'capture_id', 'kind', 'loads', 'meeting_goal_id', 'messageId', 'nudge_at', 'nudge_kind', 'reply', 'request', 'steps'].sort(),
    )
    const json = JSON.stringify(build)
    expect(json).not.toContain('forty thousand')
    expect(json).not.toContain(GOAL_TEXT)
    // Never read the capture's words, only the goal's id.
    expect(fake.calls.some((c) => c.table === 'capture_transcripts')).toBe(false)
  })

  it('no goal set: the other pointers, no goal id', async () => {
    const build = await loadChatTurnEvidence(nudgeDb() as unknown as SupabaseClient, { conversationId: CONV, userId: USER, messageId: NUDGE_ID })
    expect(build?.evidence).toMatchObject({ nudge_kind: 'suggestion', capture_id: CAPTURE, nudge_at: AT })
    expect(build?.evidence).not.toHaveProperty('meeting_goal_id')
  })

  it('an ordinary turn has no nudge pointers and reads no conversation for them', async () => {
    const fake = nudgeDb({ goal: true })
    fake.seed('chat_messages', [{ id: 'r3', conversation_id: CONV, user_id: USER, role: 'assistant', ui_message: assistantMessage(), ui_message_id: 'msg-a1', created_at: '2026-10-16T10:04:00.000Z' }])
    const build = await loadChatTurnEvidence(fake as unknown as SupabaseClient, { conversationId: CONV, userId: USER, messageId: 'msg-a1' })
    for (const k of ['nudge_kind', 'capture_id', 'nudge_at', 'meeting_goal_id']) expect(build?.evidence).not.toHaveProperty(k)
    expect(fake.calls.some((c) => c.table === 'chat_conversations' || c.table === 'meeting_goal')).toBe(false)
  })

  it('nudgePointers is pure: the kind defaults to insight, ids clipped, nothing for another kind', () => {
    const row = { role: 'assistant', ui_message: { id: 'n', metadata: { kind: 'say_to_user' }, parts: [] }, created_at: AT }
    expect(nudgePointers(row, { captureId: CAPTURE })).toEqual({ nudge_kind: 'insight', capture_id: CAPTURE, nudge_at: AT })
    expect(nudgePointers({ role: 'assistant', ui_message: assistantMessage() }, { captureId: CAPTURE })).toEqual({})
  })
})
