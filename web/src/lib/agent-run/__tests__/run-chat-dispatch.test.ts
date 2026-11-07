/**
 * run-chat-dispatch — the run chats' shared dispatch (bots-v4 Phase A3): moved
 * out of /api/account/agent-runs/[id]/chat (and the loop-run chat's copy), so
 * the two run chat routes and the main agent's relay (bot-relay.ts) send a
 * turn one way. The routes' own tests cover them streaming through it; this
 * file pins the module itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mintedSkillTokens: Array<Record<string, unknown>> = []
const skillClientArgs: Array<Record<string, unknown>> = []
const attachSpy = vi.fn()
const workClientOpts: unknown[] = []
const serviceUpdates: Array<{ table: string; patch: Record<string, unknown>; eqs: Array<[string, unknown]> }> = []

vi.mock('eve/client', () => {
  class ClientError extends Error {
    constructor(public status: number) {
      super(`status ${status}`)
    }
  }
  class Client {
    sessions = { attach: (id: string, opts: unknown) => (attachSpy(id, opts), { id }) }
    constructor(opts: unknown) {
      workClientOpts.push(opts)
    }
  }
  return { Client, ClientError }
})
vi.mock('@/lib/flows/skill-run-token', () => ({
  mintRunToken: (claims: Record<string, unknown>) => (mintedSkillTokens.push(claims), 'skill-token'),
}))
vi.mock('@/lib/flows/run-skill-eve', () => ({
  skillRunnerClient: (args: Record<string, unknown>) => (skillClientArgs.push(args), { sessions: { attach: (id: string, opts: unknown) => (attachSpy(id, opts), { id }) } }),
}))
vi.mock('@/lib/eve/dispatch-origin', () => ({ eveDispatchOrigin: () => 'https://app.test', protectionBypassHeaders: () => ({}) }))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => {
        const entry = { table, patch, eqs: [] as Array<[string, unknown]> }
        serviceUpdates.push(entry)
        const chain = {
          eq: (col: string, v: unknown) => (entry.eqs.push([col, v]), chain),
          then: (f: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(f),
        }
        return chain
      },
    }),
  }),
}))

import { ClientError } from 'eve/client'
import {
  attachLoopRunSession,
  dispatchChatTurn,
  extractSessionId,
  isBusyError,
  isRunSessionGoneError,
  reopenedChatSessionOf,
  makeWorkAgentClient,
  parseSessionState,
  persistAdvancedCursor,
  RUN_CHAT_MAX_PREVIOUS_SESSIONS,
  WORK_AGENT_MOUNT,
} from '../run-chat-dispatch'

function fakeSession() {
  return {
    send: vi.fn(async (..._a: unknown[]) => 'sent'),
    respond: vi.fn(async (..._a: unknown[]) => 'responded'),
    state: { sessionId: 's', streamIndex: 0 },
  }
}

beforeEach(() => {
  mintedSkillTokens.length = 0
  skillClientArgs.length = 0
  workClientOpts.length = 0
  serviceUpdates.length = 0
  attachSpy.mockReset()
})

describe('dispatchChatTurn', () => {
  it('a plain message queues (never steers), with no signal unless one is given', async () => {
    const s = fakeSession()
    await dispatchChatTurn(s as never, { message: 'hi' })
    expect(s.send).toHaveBeenCalledWith('hi', { turnPolicy: 'queue' })
    const ac = new AbortController()
    await dispatchChatTurn(s as never, { message: 'again' }, null, { signal: ac.signal })
    expect(s.send).toHaveBeenLastCalledWith('again', { turnPolicy: 'queue', signal: ac.signal })
    expect(s.respond).not.toHaveBeenCalled()
  })

  it('a composer turn sends its message and one-turn context', async () => {
    const s = fakeSession()
    await dispatchChatTurn(s as never, { message: 'raw' }, { message: 'built', clientContext: ['skill'], skill: null })
    expect(s.send).toHaveBeenCalledWith('built', { turnPolicy: 'queue', clientContext: ['skill'] })
  })

  it('answers to a park go through respond(), the text riding each answer and clientContext', async () => {
    const s = fakeSession()
    await dispatchChatTurn(s as never, { message: 'Friday', inputResponses: [{ requestId: 'r1', optionId: 'approve' }, { requestId: 'r2', text: 'own' }] })
    expect(s.respond).toHaveBeenCalledWith(
      [{ requestId: 'r1', optionId: 'approve', text: 'Friday' }, { requestId: 'r2', text: 'own' }],
      { clientContext: 'Friday' },
    )
    expect(s.send).not.toHaveBeenCalled()
  })
})

describe('the clients', () => {
  it('the work-agent client is at the absolute mount, with the run token headers, never following redirects', () => {
    makeWorkAgentClient({ secret: 'sec', runToken: 'tok', workspaceId: 'ws', userId: 'u' })
    expect(workClientOpts[0]).toMatchObject({
      host: `https://app.test${WORK_AGENT_MOUNT}`,
      auth: { bearer: 'sec' },
      headers: { 'x-agent-run-secret': 'sec', 'x-agent-run-token': 'tok', 'x-agent-run-workspace': 'ws', 'x-agent-run-user': 'u' },
      redirect: 'error',
    })
  })

  it('a loop run’s session: a fresh token with the run’s facts and a chat claim naming the bot, attached at its cursor', () => {
    const record = {
      workItemId: 'wi',
      workspaceId: 'ws',
      state: { sessionId: 'sess', streamIndex: 7, settleStreamIndex: 3 },
      facts: { skillId: 'sk', mode: 'act', hasCapture: false, outputContract: 'verdict', model: 'm', runAsUserId: 'u' },
    }
    attachLoopRunSession('sec', { record: record as never, teammateId: 'tm' })
    expect(mintedSkillTokens[0]).toMatchObject({ workspaceId: 'ws', runAsUserId: 'u', skillId: 'sk', workItemId: 'wi', originDepth: 1, chat: { teammateId: 'tm' } })
    expect(skillClientArgs[0]).toEqual({ secret: 'sec', runToken: 'skill-token', workspaceId: 'ws', userId: 'u' })
    expect(attachSpy).toHaveBeenCalledWith('sess', { streamIndex: 7 })
    // The run's own model, for anyone not on a ChatGPT plan.
    expect(mintedSkillTokens[0]).toMatchObject({ model: 'm' })
  })

  it("hands a person now on their own ChatGPT plan the plan's model, so the turn runs on it; a plan run keeps its own", () => {
    const record = (model: string) => ({
      workspaceId: 'ws',
      workItemId: 'wi',
      state: { sessionId: 'sess', streamIndex: 7 },
      facts: { skillId: 'sk', mode: 'act', hasCapture: false, outputContract: 'verdict', model, runAsUserId: 'u' },
    })
    attachLoopRunSession('sec', { record: record('deepseek-v4-flash') as never, teammateId: 'tm', chatgptPlan: true })
    expect(mintedSkillTokens[0]).toMatchObject({ model: 'chatgpt-plan/gpt-6-luna' })
    attachLoopRunSession('sec', { record: record('chatgpt-plan/gpt-6.1-sol') as never, teammateId: 'tm', chatgptPlan: true })
    expect(mintedSkillTokens[1]).toMatchObject({ model: 'chatgpt-plan/gpt-6.1-sol' })
  })
})

describe('the session cursor', () => {
  it('reads the eve session id off sandbox_id', () => {
    expect(extractSessionId('eve:abc')).toBe('abc')
    expect(extractSessionId('eve:  ')).toBeNull()
    expect(extractSessionId('e2b:abc')).toBeNull()
    expect(extractSessionId(null)).toBeNull()
  })

  it('parses session_state, rejecting a legacy continuation token', () => {
    expect(parseSessionState({ sessionId: 's', streamIndex: 4, settleStreamIndex: 2 }, 'f')).toEqual({ sessionId: 's', streamIndex: 4, settleStreamIndex: 2 })
    expect(parseSessionState({ streamIndex: 4 }, 'fallback')).toEqual({ sessionId: 'fallback', streamIndex: 4 })
    expect(parseSessionState({ continuationToken: 'old', streamIndex: 4 }, 'f')).toBeNull()
    expect(parseSessionState({ sessionId: 's' }, 'f')).toBeNull()
    expect(parseSessionState(null, 'f')).toBeNull()
  })

  it('advances the read cursor past the turn, keeping the settle boundary; a cursor that did not move writes nothing', async () => {
    const prev = { sessionId: 's', streamIndex: 4, settleStreamIndex: 2 }
    await persistAdvancedCursor('run', 'ws', { state: { sessionId: 's', streamIndex: 9 } } as never, prev)
    expect(serviceUpdates).toEqual([
      {
        table: 'agent_run',
        patch: { session_state: { sessionId: 's', streamIndex: 9, settleStreamIndex: 2 } },
        // Only while the run still names this session: never over a reopened chat's new one.
        eqs: [['id', 'run'], ['workspace_id', 'ws'], ['sandbox_id', 'eve:s']],
      },
    ])
    await persistAdvancedCursor('run', 'ws', { state: { sessionId: 's', streamIndex: 4 } } as never, prev)
    expect(serviceUpdates).toHaveLength(1)
  })

  it('only a 409 or 423 from eve is busy', () => {
    const E = ClientError as unknown as new (status: number) => Error
    expect(isBusyError(new E(409))).toBe(true)
    expect(isBusyError(new E(423))).toBe(true)
    expect(isBusyError(new E(500))).toBe(false)
    expect(isBusyError(new Error('409'))).toBe(false)
  })

  it('keeps a reopened chat’s earlier sessions: parsed (well-formed ones, the newest few) and preserved by every cursor advance', async () => {
    const previous = [{ sessionId: 'old-1', startIndex: 3 }]
    expect(parseSessionState({ sessionId: 's', streamIndex: 4, settleStreamIndex: 0, previous }, 'f')).toEqual({
      sessionId: 's',
      streamIndex: 4,
      settleStreamIndex: 0,
      previous,
    })
    // Malformed entries are dropped; an empty list is no list.
    const junk = [{ sessionId: '', startIndex: 1 }, { sessionId: 'x', startIndex: -1 }, { sessionId: 'y' }, 'z', null]
    expect(parseSessionState({ sessionId: 's', streamIndex: 4, previous: junk }, 'f')).toEqual({ sessionId: 's', streamIndex: 4 })
    const many = Array.from({ length: RUN_CHAT_MAX_PREVIOUS_SESSIONS + 2 }, (_, i) => ({ sessionId: `old-${i}`, startIndex: i }))
    expect(parseSessionState({ sessionId: 's', streamIndex: 4, previous: many }, 'f')?.previous).toEqual(many.slice(-RUN_CHAT_MAX_PREVIOUS_SESSIONS))

    await persistAdvancedCursor('run', 'ws', { state: { sessionId: 's', streamIndex: 9 } } as never, { sessionId: 's', streamIndex: 4, settleStreamIndex: 0, previous })
    expect(serviceUpdates.at(-1)?.patch).toEqual({ session_state: { sessionId: 's', streamIndex: 9, settleStreamIndex: 0, previous } })

    // A reopened chat's session bills under its own key; the run's own session doesn't.
    expect(reopenedChatSessionOf({ sessionId: 's', streamIndex: 4, previous })).toBe('s')
    expect(reopenedChatSessionOf({ sessionId: 's', streamIndex: 4 })).toBeUndefined()
  })

  it('a session is GONE only on eve’s own words for it: never busy, never the caller, never a misroute', () => {
    const E = ClientError as unknown as new (status: number) => Error
    const err = (status: number, body: unknown, code?: string) =>
      Object.assign(new E(status), { body: typeof body === 'string' ? body : JSON.stringify(body), ...(code ? { code } : {}) })
    // The 30-day timeout (and a run gone or past retention): the send's 409.
    expect(isRunSessionGoneError(err(409, { ok: false, code: 'session_not_active', error: 'The session is no longer active.' }))).toBe(true)
    // eve's parsed code is read when it has one.
    expect(isRunSessionGoneError(err(409, '', 'session_not_active'))).toBe(true)
    expect(isRunSessionGoneError(err(409, { ok: false, code: 'session_stranded' }))).toBe(true)
    // A stream read: history past retention, or no run for the id.
    expect(isRunSessionGoneError(err(410, { ok: false, code: 'session_expired' }))).toBe(true)
    expect(isRunSessionGoneError(err(404, { ok: false, error: 'Session not found.' }))).toBe(true)

    // Not gone: eve's retryable 409, a locked session, a bare 404 (a mount that
    // isn't there), the caller's credentials, a server error, a plain Error.
    expect(isRunSessionGoneError(err(409, { ok: false, code: 'session_not_ready' }))).toBe(false)
    expect(isRunSessionGoneError(err(409, ''))).toBe(false)
    expect(isRunSessionGoneError(err(423, ''))).toBe(false)
    expect(isRunSessionGoneError(err(404, 'Not Found'))).toBe(false)
    expect(isRunSessionGoneError(err(410, { ok: false, code: 'gone' }))).toBe(false)
    expect(isRunSessionGoneError(err(401, { ok: false, code: 'session_expired' }))).toBe(false)
    expect(isRunSessionGoneError(err(403, { ok: false, code: 'session_expired' }))).toBe(false)
    expect(isRunSessionGoneError(err(500, { ok: false, error: 'Session not found.' }))).toBe(false)
    expect(isRunSessionGoneError(Object.assign(new Error('x'), { status: 409, code: 'session_not_active' }))).toBe(false)
  })
})
