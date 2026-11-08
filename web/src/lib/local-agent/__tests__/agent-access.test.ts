/**
 * The Mac body's server access (docs/plans/teammate-agent.md C1): the checks
 * every call passes, its ceiling, its spec and the local-model gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  createToolApproval: vi.fn(async (): Promise<unknown> => ({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })),
  checkUsageLimits: vi.fn(async (): Promise<unknown> => undefined),
}))
vi.mock('@/lib/safety/approvals', async (orig) => ({
  ...(await orig<typeof import('@/lib/safety/approvals')>()),
  createToolApproval: m.createToolApproval,
}))
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: m.checkUsageLimits, logUsage: vi.fn() }))

import type { SupabaseClient } from '@supabase/supabase-js'
import { ALL_TOOL_NAMES, ATTENDED_ONLY_TOOL_NAMES, CHAT_NATIVE_TOOL_NAMES } from '@/lib/ai/tool-registry'
import { BROWSER_TOOL_NAMES } from '@/lib/ai/tool-discovery'
import { gateRiskyCall, type GateRequest } from '@/lib/safety/action-review'
import type { ChatSpec } from '@/lib/chat/chat-run-rebuild'
import {
  MAC_EXCLUDED_TOOLS,
  authorizeMacBody,
  localModelFromClaimBody,
  localModelGate,
  macCallerClass,
  macCeiling,
  macChatClaims,
  macSpec,
  macApprovalContext,
  macCreateToolsOptions,
  macDispatchContext,
  macGate,
  macPersonWords,
  withMacConfirmWording,
  usageRefusal,
  type MacBody,
} from '../agent-access'
import { signModelToken } from '../tokens'
import { CONV, DEVICE, FOLDER, OTHER, USER, WS, seeded, type FakeDb } from './fake-db'

const SID = '77777777-7777-4777-8777-777777777777'
const LOCAL_AGENT_TOOLS = ['local_agents', 'start_local_agent', 'message_local_agent', 'read_local_agent', 'stop_local_agent']

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    id: SID,
    user_id: USER,
    workspace_id: WS,
    device_id: DEVICE,
    folder_id: FOLDER,
    conversation_id: CONV,
    started_by: 'agent',
    // The chat tool's start key: started from the person's typed turn.
    idempotency_key: `local-agent:${CONV}:session:eve-1:turn:t1:call:c1`,
    mode: 'read',
    request: 'fix the login redirect',
    created_at: '2026-10-21T20:00:00.000Z',
    start_words: null,
    stop_requested_at: null,
    status: 'running',
    local_model: false,
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...over,
  }
}

function db(session: Record<string, unknown> = {}, members = [{ id: 'mem-1', workspace_id: WS, user_id: USER }]): FakeDb {
  return seeded({ local_agent_session: [sessionRow(session)], member: members })
}

function request(token: string | null = signModelToken({ sid: SID, uid: USER, wid: WS }).token): Request {
  return new Request('http://localhost/api/local-agent/agent/spec', { headers: token ? { authorization: `Bearer ${token}` } : {} })
}

function macBody(over: Partial<MacBody['session']> = {}, caller: MacBody['caller'] = 'person_remote'): MacBody {
  return {
    claims: { sid: SID, uid: USER, wid: WS, exp: Math.floor(Date.now() / 1000) + 3600 },
    session: {
      id: SID, userId: USER, workspaceId: WS, conversationId: CONV, startedBy: 'agent', mode: 'read', request: 'look at the repo',
      createdAt: '2026-10-21T20:00:00.000Z', startWords: [], localModel: false, deviceName: 'Liam’s MacBook', folderLabel: 'dial8-website', ...over,
    },
    caller,
  }
}

const env = { ...process.env }
beforeEach(() => {
  process.env.LOCAL_AGENT_TOKEN_SECRET = 'agent-access-test-secret'
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  m.createToolApproval.mockClear()
  m.checkUsageLimits.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  process.env = { ...env }
  vi.restoreAllMocks()
})

describe('authorizeMacBody: every call proves the token, the session, the workspace and the conversation', () => {
  it('accepts a live session of the token’s user, and reads its job from the row', async () => {
    const body = await authorizeMacBody(request(), db() as unknown as SupabaseClient)
    expect(body).not.toBeInstanceOf(Response)
    expect(body).toEqual({
      claims: expect.objectContaining({ sid: SID, uid: USER, wid: WS }),
      session: expect.objectContaining({ id: SID, userId: USER, workspaceId: WS, conversationId: CONV, startedBy: 'agent', mode: 'read', localModel: false }),
      caller: 'person_remote',
    })
  })

  it('refuses a missing, malformed or forged token (401)', async () => {
    for (const token of [null, 'nope', 'la1.e30.AAAA', `${signModelToken({ sid: SID, uid: USER, wid: WS }).token}x`]) {
      const res = (await authorizeMacBody(request(token), db() as unknown as SupabaseClient)) as Response
      expect(res.status).toBe(401)
    }
  })

  it('refuses an expired token (401, says so)', async () => {
    const expired = signModelToken({ sid: SID, uid: USER, wid: WS }, { now: Date.now() - 3 * 3600_000 }).token
    const res = (await authorizeMacBody(request(expired), db() as unknown as SupabaseClient)) as Response
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/expired/)
  })

  it('answers 503 when no signing key is configured', async () => {
    const token = signModelToken({ sid: SID, uid: USER, wid: WS }).token
    delete process.env.LOCAL_AGENT_TOKEN_SECRET
    delete process.env.RUN_SKILL_INTERNAL_SECRET
    const res = (await authorizeMacBody(request(token), db() as unknown as SupabaseClient)) as Response
    expect(res.status).toBe(503)
  })

  it('refuses a session owned by someone else (403)', async () => {
    const res = (await authorizeMacBody(request(), db({ user_id: OTHER }) as unknown as SupabaseClient)) as Response
    expect(res.status).toBe(403)
  })

  it('refuses a token minted for another user, even on a live session (403)', async () => {
    const theirs = signModelToken({ sid: SID, uid: OTHER, wid: WS }).token
    const res = (await authorizeMacBody(request(theirs), db() as unknown as SupabaseClient)) as Response
    expect(res.status).toBe(403)
  })

  it('refuses a dead session: queued, cancelled, failed, expired (403)', async () => {
    for (const status of ['queued', 'cancelled', 'failed', 'expired']) {
      const res = (await authorizeMacBody(request(), db({ status }) as unknown as SupabaseClient)) as Response
      expect(res.status).toBe(403)
    }
  })

  it('refuses a session idle for 24 h (403)', async () => {
    const idle = db({ status: 'waiting', lease_expires_at: null })
    idle.tables.local_agent_session[0].updated_at = new Date(Date.now() - 25 * 3600_000).toISOString()
    const res = (await authorizeMacBody(request(), idle as unknown as SupabaseClient)) as Response
    expect(res.status).toBe(403)
  })

  it('refuses when the session moved out of the token’s workspace (403)', async () => {
    const res = (await authorizeMacBody(request(), db({ workspace_id: 'another-workspace' }) as unknown as SupabaseClient)) as Response
    expect(res.status).toBe(403)
  })

  it('refuses a person who is no longer a member of the workspace (403)', async () => {
    const res = (await authorizeMacBody(request(), db({}, []) as unknown as SupabaseClient)) as Response
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/member/)
  })

  it('refuses a session with no conversation to work in (409 NO_CONVERSATION)', async () => {
    const res = (await authorizeMacBody(request(), db({ conversation_id: null }) as unknown as SupabaseClient)) as Response
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('NO_CONVERSATION')
  })

  it('fails closed (503) when the local-model flag can’t be read (418 is a hard prerequisite)', async () => {
    for (const flag of [undefined, null, 'true']) {
      const before = db({ local_model: flag })
      if (flag === undefined) delete before.tables.local_agent_session[0].local_model
      const res = (await authorizeMacBody(request(), before as unknown as SupabaseClient)) as Response
      expect(res.status).toBe(503)
    }
  })

  it('refuses a session asked to stop at once (403), before the Mac reports cancelled', async () => {
    const res = (await authorizeMacBody(request(), db({ stop_requested_at: new Date().toISOString() }) as unknown as SupabaseClient)) as Response
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/stopped/)
  })

  it('names the job for its cards: the Mac and the folder', async () => {
    const body = (await authorizeMacBody(request(), db() as unknown as SupabaseClient)) as MacBody
    expect(body.session).toMatchObject({ deviceName: 'Liam’s MacBook', folderLabel: 'dial8-website', request: 'fix the login redirect', startWords: [] })
  })

  it('a job a loop started (WS-D’s key prefix) is unattended', async () => {
    const body = (await authorizeMacBody(request(), db({ idempotency_key: 'local-agent-loop:flow-1:run-2' }) as unknown as SupabaseClient)) as MacBody
    expect(body.caller).toBe('agent_unattended')
  })

  it('reads the local-model flag and the starter’s class from the row', async () => {
    const local = (await authorizeMacBody(request(), db({ local_model: true, started_by: 'person' }) as unknown as SupabaseClient)) as MacBody
    expect(local.session.localModel).toBe(true)
    expect(local.caller).toBe('person_remote')
  })
})

describe('the caller class and the claim field', () => {
  it('person_remote only on a positive marker: the person’s own start, or the chat tool’s start key; everything else is unattended', () => {
    expect(macCallerClass('person')).toBe('person_remote')
    expect(macCallerClass('person', null)).toBe('person_remote')
    expect(macCallerClass('agent', 'local-agent:conv:session:s:turn:t:call:c')).toBe('person_remote')
    expect(macCallerClass('agent')).toBe('agent_unattended')
    expect(macCallerClass('agent', null)).toBe('agent_unattended')
    expect(macCallerClass('agent', 'local-agent-loop:flow:step:a:fire:f')).toBe('agent_unattended')
    expect(macCallerClass('agent', 'someone-else:local-agent:conv:session:')).toBe('agent_unattended')
    expect(macCallerClass('')).toBe('agent_unattended')
  })

  it('a job the cloud agent started with no chat start key is unattended', async () => {
    const body = (await authorizeMacBody(request(), db({ idempotency_key: null }) as unknown as SupabaseClient)) as MacBody
    expect(body.caller).toBe('agent_unattended')
  })

  it('only `localModel: true` in a claim body counts', () => {
    expect(localModelFromClaimBody({ localModel: true })).toBe(true)
    for (const v of [false, 'true', 1, null, undefined]) expect(localModelFromClaimBody({ localModel: v })).toBe(false)
  })

  it('the usage limit’s refusal comes back as is; anything else it throws is a 503, never a bare 500', async () => {
    expect(await usageRefusal(USER)).toBeNull()
    m.checkUsageLimits.mockRejectedValueOnce(new Response('{}', { status: 429 }))
    expect((await usageRefusal(USER))?.status).toBe(429)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    m.checkUsageLimits.mockRejectedValueOnce(new Error('rpc down'))
    const res = await usageRefusal(USER)
    expect(res?.status).toBe(503)
    expect((await res!.json()).code).toBe('BILLING_UNAVAILABLE')
  })
})

describe('macCeiling: the main chat’s, narrowed for the Mac', () => {
  const external = ['mcp__notion__search', 'mcp__notion__create_page', 'mcp_confirm_call']

  it('inherit-all is every registry tool ∪ the person’s MCP tools, plus the web tools', () => {
    const ceiling = macCeiling(null, external, { caller: 'person_remote', localModel: false })
    expect(ceiling.has('list_actions')).toBe(true)
    expect(ceiling.has('delete_action')).toBe(true)
    for (const name of external) expect(ceiling.has(name)).toBe(true)
    expect(ceiling.has('web_fetch')).toBe(true)
    expect(ceiling.has('web_search')).toBe(true)
  })

  it('never holds the local-agent, relay, helper or browser tools, the screen’s tools, or the JWT tools', () => {
    const ceiling = macCeiling(new Set(ALL_TOOL_NAMES), [], { caller: 'person_remote', localModel: false })
    for (const name of [...LOCAL_AGENT_TOOLS, ...CHAT_NATIVE_TOOL_NAMES, ...BROWSER_TOOL_NAMES, 'show', 'read_card', 'tell_note_taker', 'generate_email_drafts', 'draft_followup_email', 'helpers']) {
      expect(ceiling.has(name), name).toBe(false)
    }
    for (const name of LOCAL_AGENT_TOOLS) expect(MAC_EXCLUDED_TOOLS.has(name)).toBe(true)
  })

  it('never holds an attended-only tool its caller class is denied (remember, create_flow, settle_card…)', () => {
    const ceiling = macCeiling(null, [], { caller: 'person_remote', localModel: false })
    for (const name of ATTENDED_ONLY_TOOL_NAMES) expect(ceiling.has(name), name).toBe(false)
    expect(ceiling.has('remember')).toBe(false)
  })

  it('keeps the chat ceiling’s own limits: a tool the edition hides stays out', () => {
    const ceiling = macCeiling(['list_actions', 'mcp__notion__search'], external, { caller: 'person_remote', localModel: false })
    expect(ceiling.has('list_actions')).toBe(true)
    expect(ceiling.has('delete_action')).toBe(false)
    expect(ceiling.has('mcp__notion__create_page')).toBe(false)
  })

  it('a local model gets no web tools', () => {
    const ceiling = macCeiling(null, [], { caller: 'person_remote', localModel: true })
    expect(ceiling.has('web_fetch')).toBe(false)
    expect(ceiling.has('web_search')).toBe(false)
    expect(ceiling.has('list_actions')).toBe(true)
  })

  it('search_tools stays beside the set, not in it', () => {
    expect(macCeiling(null, [], { caller: 'person_remote', localModel: false }).has('search_tools')).toBe(false)
  })
})

describe('the spec: the main chat’s, for the session’s conversation', () => {
  it('rebuilds as the main chat: no agent, no teammate, no surface, the session’s conversation', () => {
    expect(macChatClaims(macBody())).toEqual({ conversationId: CONV, workspaceId: WS, userId: USER, exp: expect.any(Number) })
  })

  const base: ChatSpec = {
    systemPrompt: 'prompt',
    model: 'google/gemini-3-flash',
    ceiling: ['list_actions', 'delete_action', 'start_local_agent', 'open_browser', 'remember', 'mcp__notion__search'],
    ceilingTools: [
      { name: 'list_actions', description: 'List' },
      { name: 'delete_action', description: 'Delete' },
      { name: 'start_local_agent', description: 'Start' },
      { name: 'open_browser', description: 'Browser' },
      { name: 'remember', description: 'Remember' },
      { name: 'mcp__notion__search', description: 'Notion' },
      { name: 'search_tools', description: 'Discover' },
    ],
    coreToolNames: ['list_actions', 'start_local_agent', 'remember'],
    gatewayTelemetry: { user: USER } as never,
    modelPolicy: { contextWindowTokens: 1 },
    modelRoute: { tier: 'fast' } as never,
    cards: [{ n: 1 }] as never,
    timeZone: 'Europe/London',
    turnContext: [{ key: 'clock', markdown: 'now' }, { key: 'environment', markdown: 'your environment' }, { key: 'now', markdown: '## Focus\n1. the person’s notes' }],
    turnContextHeld: ['environment', 'now'],
  }

  it('advertises the Mac’s ceiling, the web tools, the relay’s model and host mac; drops metering, cards, the environment, the Now file and helpers', () => {
    const spec = macSpec(base, macBody(), { includeSchemas: true })
    // The Mac body's teammate tools (C4, wired through agent-seams.ts) everywhere; the rest as the ceiling allows.
    const teammate = ['message_teammate', 'report_to_person']
    const own = (names: string[]) => names.filter((n) => !teammate.includes(n))
    for (const list of [spec.ceiling, spec.ceilingTools.map((t) => t.name), spec.coreToolNames]) expect(list).toEqual(expect.arrayContaining(teammate))
    expect(spec.ceilingTools.find((t) => t.name === 'message_teammate')?.inputSchema).toMatchObject({ type: 'object', properties: { text: expect.any(Object) } })
    expect(own(spec.ceiling).sort()).toEqual(['delete_action', 'list_actions', 'mcp__notion__search', 'web_fetch', 'web_search'])
    expect(own(spec.ceilingTools.map((t) => t.name))).toEqual(['list_actions', 'delete_action', 'mcp__notion__search', 'search_tools', 'web_fetch', 'web_search'])
    const fetchTool = spec.ceilingTools.find((t) => t.name === 'web_fetch')
    expect(fetchTool?.inputSchema).toMatchObject({ type: 'object', properties: { url: expect.any(Object) } })
    expect(fetchTool?.description).toMatch(/NEVER for workspace data/)
    expect(own(spec.coreToolNames)).toEqual(['list_actions', 'web_fetch', 'web_search'])
    expect(spec.model).toBe('anthropic/claude-sonnet-5.5')
    expect(spec.modelPolicy).toEqual({ contextWindowTokens: 1_000_000 })
    expect(spec).not.toHaveProperty('gatewayTelemetry')
    expect(spec).not.toHaveProperty('modelRoute')
    expect(spec).not.toHaveProperty('cards')
    expect(spec.turnContext).toEqual([{ key: 'clock', markdown: 'now' }])
    expect(spec).not.toHaveProperty('turnContextHeld')
    expect(spec.helpersAllowed).toBe(false)
    expect(spec.helperToolNames).toEqual([])
    expect(spec.host).toBe('mac')
    expect(spec.localModel).toBe(false)
    expect(spec.session).toEqual({ id: SID, conversationId: CONV })
    expect(spec.timeZone).toBe('Europe/London')
    expect(spec.systemPrompt).toBe('prompt')
  })

  it('schemas ride only when asked for', () => {
    const spec = macSpec(base, macBody())
    expect(spec.ceilingTools.find((t) => t.name === 'web_search')).not.toHaveProperty('inputSchema')
  })

  it('a local model advertises no web tools', () => {
    const spec = macSpec(base, macBody({ localModel: true }))
    expect(spec.ceiling).not.toContain('web_fetch')
    expect(spec.ceilingTools.map((t) => t.name)).not.toContain('web_search')
    expect(spec.coreToolNames.filter((n) => n !== 'message_teammate' && n !== 'report_to_person')).toEqual(['list_actions'])
    expect(spec.localModel).toBe(true)
  })

  it('inherit-all (a null chat ceiling) narrows the enumerated tools', () => {
    const spec = macSpec({ ...base, ceiling: null }, macBody())
    expect(spec.ceiling).not.toContain('start_local_agent')
    expect(spec.ceiling).toContain('list_actions')
  })
})

describe('localModelGate: on a model on the Mac, every risky call is the person’s card', () => {
  const supabase = {} as SupabaseClient
  const gateRequest = (over: Partial<GateRequest> = {}): GateRequest => ({
    door: 'chat',
    userId: USER,
    workspaceId: WS,
    toolName: 'delete_action',
    input: { id: 'a1' },
    sideEffect: 'delete',
    personMessages: ['delete it'],
    source: 'person',
    approval: { supabase, conversationId: CONV, context: { tools: { strictWorkspace: true } } },
    ...over,
  })

  it('is the usual gate when the Mac runs on the relay', () => {
    expect(localModelGate(macBody())).toBe(gateRiskyCall)
  })

  it('holds a risky call as the person’s card, naming the Mac and the job, without running it', async () => {
    const run = vi.fn(async () => 'ran')
    const gated = await localModelGate(macBody({ localModel: true }))(gateRequest(), run)
    expect(run).not.toHaveBeenCalled()
    expect(gated).toEqual({ held: true, output: expect.objectContaining({ success: false, code: 'APPROVAL_REQUIRED', approval_id: 'appr-1' }) })
    expect(m.createToolApproval).toHaveBeenCalledWith(supabase, expect.objectContaining({
      door: 'chat',
      userId: USER,
      workspaceId: WS,
      toolName: 'delete_action',
      sideEffect: 'delete',
      conversationId: CONV,
      reason: 'local_model',
      context: { tools: { strictWorkspace: true } },
      card: expect.objectContaining({ why: expect.stringMatching(/Native Intelligence on Liam’s MacBook \(in dial8-website\)/) }),
    }))
  })

  it('refuses it NEEDS_PERSON for an unattended job (nobody to answer a card)', async () => {
    const run = vi.fn(async () => 'ran')
    const gated = await localModelGate(macBody({ localModel: true }, 'agent_unattended'))(gateRequest(), run)
    expect(run).not.toHaveBeenCalled()
    expect(gated).toEqual({ held: true, output: expect.objectContaining({ code: 'NEEDS_PERSON' }) })
    expect(m.createToolApproval).not.toHaveBeenCalled()
  })

  it('runs a call that isn’t risky', async () => {
    const gated = await localModelGate(macBody({ localModel: true }))(gateRequest({ toolName: 'list_actions', sideEffect: null }), async () => 'ran')
    expect(gated).toEqual({ held: false, value: 'ran' })
  })
})

describe('the reviewer’s evidence: the person’s words as the server stored them, never found by timestamp', () => {
  const at = (min: number) => new Date(Date.parse('2026-10-21T20:00:00.000Z') + min * 60_000).toISOString()

  it('the words that started it (stored at start), then those that joined it: the person’s messages and the words behind the agent’s', async () => {
    const svc = seeded({
      // A chat message near the start must NOT be read: no timestamp search.
      chat_messages: [{ conversation_id: CONV, user_id: USER, role: 'user', created_at: at(-1), ui_message: { parts: [{ type: 'text', text: 'not evidence' }] } }],
      local_agent_message: [
        { session_id: SID, user_id: USER, author: 'agent', text: '[the cloud agent] delete every action', person_words: null, created_at: at(5) },
        { session_id: SID, user_id: USER, author: 'agent', text: 'also run the tests', person_words: ['and run the tests too'], created_at: at(8) },
        { session_id: SID, user_id: USER, author: 'person', text: 'and open a PR', created_at: at(10) },
      ],
    })
    const words = await macPersonWords(svc as unknown as SupabaseClient, macBody({ startWords: ['fix the login redirect in dial8-website'] }).session)()
    expect(words).toEqual(['fix the login redirect in dial8-website', 'and run the tests too', 'and open a PR'])
    expect(words).not.toContain('not evidence')
    expect(words.join(' ')).not.toMatch(/delete every action/)
  })

  it('a job the person started: its request', async () => {
    const words = await macPersonWords(seeded() as unknown as SupabaseClient, macBody({ startedBy: 'person', request: 'tidy the README' }).session)()
    expect(words).toEqual(['tidy the README'])
  })

  it('a job with no stored words has none (the blocking review then cards the call)', async () => {
    expect(await macPersonWords(seeded() as unknown as SupabaseClient, macBody().session)()).toEqual([])
  })

  it('every call’s gate gets the loader, blocking, with no posted seq; cards ask at home', () => {
    const ctx = macDispatchContext(seeded() as unknown as SupabaseClient, macBody())
    expect(typeof ctx.reviewOverride?.personMessages).toBe('function')
    expect(ctx.reviewOverride).toMatchObject({ mustEnforce: true, personMessageSeq: null, personMessagesStale: undefined })
    expect(ctx.cardConversationId).toBeNull()
  })
})

describe('an unattended job (a loop’s start) runs inside a loop run’s fence', () => {
  it('its tools skip private captures, the HubSpot writeback and confirming; its approvals record the fence', () => {
    const body = macBody({}, 'agent_unattended')
    const ctx = macDispatchContext(seeded() as unknown as SupabaseClient, body)
    expect(macCreateToolsOptions(body, ctx, {})).toMatchObject({
      strictWorkspace: true,
      omitPrivateCaptures: true,
      unattended: true,
      automaticDrafts: true,
      actionRules: { unattended: true, fileActionsAsSuggested: true },
    })
    expect(macApprovalContext(body).tools).toMatchObject({ omitPrivateCaptures: true, unattended: true, strictWorkspace: true })
  })

  it('a job for the person keeps the person’s reach', () => {
    const body = macBody()
    const options = macCreateToolsOptions(body, macDispatchContext(seeded() as unknown as SupabaseClient, body), {})
    expect(options).not.toHaveProperty('omitPrivateCaptures')
    expect(options).not.toHaveProperty('unattended')
    expect(macApprovalContext(body).tools).toEqual({ origin: { actor: 'agent', depth: 1 }, strictWorkspace: true })
  })

  it('every approval names the job, for the per-job cap and the card’s words', () => {
    expect(macApprovalContext(macBody())).toMatchObject({ localAgent: { sessionId: SID, deviceName: 'Liam’s MacBook', folderLabel: 'dial8-website' } })
  })
})

describe('the model on the Mac is told where a card really is (the per-job cap is createToolApproval’s)', () => {
  const request = (over: Partial<GateRequest> = {}): GateRequest => ({
    door: 'chat', userId: USER, workspaceId: WS, toolName: 'delete_action', input: {}, sideEffect: 'delete',
    personMessages: [], source: 'person', approval: { supabase: {} as SupabaseClient, conversationId: null }, ...over,
  })
  const pending = (n: number, sessionId = SID) =>
    Array.from({ length: n }, (_, i) => ({ id: `appr-${sessionId}-${i}`, user_id: USER, status: 'pending', context: { localAgent: { sessionId } } }))

  it('a held card’s message points at the home chat', async () => {
    const gated = await macGate(macBody({ localModel: true }), seeded() as unknown as SupabaseClient)(request(), async () => 'ran')
    expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED', message: expect.stringMatching(/home chat/) } })
    expect((gated as { output: { message: string } }).output.message).not.toMatch(/right under your message/)
  })

  it('the gate itself counts no cards: the per-job cap is createToolApproval’s (src/lib/safety/approvals.ts)', async () => {
    const svc = seeded({ tool_approval: [...pending(5), ...pending(4, 'another-job')] })
    const gated = await macGate(macBody(), svc as unknown as SupabaseClient)(request(), async () => 'ran')
    expect(gated).toEqual({ held: false, value: 'ran' })
  })

  it('another job’s cards, settled cards and reads don’t count', async () => {
    const settled = pending(3).map((r) => ({ ...r, status: 'approved' }))
    const svc = seeded({ tool_approval: [...pending(4), ...settled, ...pending(9, 'another-job')] })
    const gated = await macGate(macBody(), svc as unknown as SupabaseClient)(request({ sideEffect: null, toolName: 'list_actions' }), async () => 'ran')
    expect(gated).toEqual({ held: false, value: 'ran' })
    const risky = await macGate(macBody(), svc as unknown as SupabaseClient)(request(), async () => 'ran')
    expect(risky).toEqual({ held: false, value: 'ran' })
  })

  it('mcp_confirm_call’s answer points at the home chat (its card keeps to createToolApproval’s per-job cap)', async () => {
    const execute = vi.fn(async () => ({ status: 'approval_requested', tool: 'mcp__linear__create_issue', message: 'shows in the chat right under your message' }))
    const tools = withMacConfirmWording({ mcp_confirm_call: { execute } as never }, seeded() as unknown as SupabaseClient, macBody())
    const out = (await tools.mcp_confirm_call.execute!({} as never, {} as never)) as { message: string }
    expect(out.message).toMatch(/home chat/)
  })
})
