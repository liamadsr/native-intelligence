/**
 * POST /api/account/activity/[id]/steer — the person steers a running helper
 * from the chat's Agents widget (A4 slice 6).
 *
 * Locked in: auth comes first (its response passes through, nothing sent);
 * the body is checked before the relay; the relay gets the caller, the
 * resolved workspace and the row, on the service client; each relay refusal
 * maps to its status and keeps the relay's code; eve not taking it is a 502;
 * a steer that went is a 200 with the relay id.
 *
 * A local agent's turn (kind local_agent, local-agents contract G) never
 * reaches the relay: its message goes to the session (addMessage, author
 * person, the policy asked for, steer by default), read from the row in the
 * caller's workspace; the library's refusals map to the widget's codes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => {
  /** The tracked_job row the route reads first (null: none, so the relay answers). */
  const state = { row: null as Record<string, unknown> | null, rowError: null as { message: string } | null, filters: [] as Array<[string, unknown]> }
  const query = {
    select: () => query,
    eq: (col: string, val: unknown) => {
      state.filters.push([col, val])
      return query
    },
    maybeSingle: async () => ({ data: state.row, error: state.rowError }),
  }
  return {
    auth: null as unknown,
    state,
    service: { tag: 'service', from: vi.fn((_table: string) => query) },
    steer: vi.fn(async (..._a: unknown[]): Promise<Record<string, unknown>> => ({ status: 'steered', relay_id: 'relay-1' })),
    addMessage: vi.fn(async (..._a: unknown[]): Promise<{ messageId: string; requeued: boolean; duplicate?: true }> => ({ messageId: 'msg-1', requeued: false })),
  }
})

vi.mock('@/lib/api-auth', () => ({ requireWorkspace: vi.fn(async () => hoisted.auth) }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => hoisted.service }))
vi.mock('@/lib/bots/bot-relay', () => ({ steerItemAsPerson: (...a: unknown[]) => hoisted.steer(...a) }))
vi.mock('@/lib/local-agent/store', () => {
  class LocalAgentError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  }
  return {
    LocalAgentError,
    isUuid: (v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v),
    addMessage: (...a: unknown[]) => hoisted.addMessage(...a),
  }
})

const { POST } = await import('@/app/api/account/activity/[id]/steer/route')
const { LocalAgentError } = (await import('@/lib/local-agent/store')) as unknown as {
  LocalAgentError: new (code: string, message: string) => Error
}

const ITEM = '11111111-1111-4111-8111-111111111111'
const ctx = (id = ITEM) => ({ params: Promise.resolve({ id }) })
const req = (body: unknown) => ({ json: async () => body }) as unknown as NextRequest

const SESSION = '22222222-3333-4444-8555-666666666666'

beforeEach(() => {
  hoisted.auth = { supabase: {}, user: { id: 'user-1' }, workspaceId: 'ws-1' }
  hoisted.steer.mockReset()
  hoisted.steer.mockImplementation(async () => ({ status: 'steered', relay_id: 'relay-1' }))
  hoisted.addMessage.mockReset()
  hoisted.addMessage.mockImplementation(async () => ({ messageId: 'msg-1', requeued: false }))
  hoisted.state.row = null
  hoisted.state.rowError = null
  hoisted.state.filters = []
})

describe('POST /api/account/activity/[id]/steer', () => {
  it('auth first: its response passes through and nothing is sent', async () => {
    hoisted.auth = NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const res = await POST(req({ message: 'x' }), ctx())
    expect(res.status).toBe(401)
    expect(hoisted.steer).not.toHaveBeenCalled()
  })

  it('a steer that went: the caller, the workspace and the row go to the relay on the service client', async () => {
    const res = await POST(req({ message: 'stick to fintech', request_id: 'req-1' }), ctx())
    expect(res.status).toBe(200)
    expect(await readJson(res)).toMatchObject({ ok: true, relay_id: 'relay-1' })
    expect(hoisted.steer).toHaveBeenCalledWith(hoisted.service, {
      userId: 'user-1',
      workspaceId: 'ws-1',
      itemId: ITEM,
      message: 'stick to fintech',
      requestId: 'req-1',
    })
  })

  it.each<[Record<string, unknown>, string]>([
    [{}, 'no message'],
    [{ message: '   ' }, 'a blank message'],
    [{ message: 'x'.repeat(4001) }, 'a message over the limit'],
    [{ message: 'x', request_id: 7 }, 'a bad request id'],
    [{ message: 'x', request_id: 'a:b' }, 'a request id with a colon'],
    [{ message: 'x', request_id: '' }, 'an empty request id'],
    [{ message: 'x', request_id: 'r'.repeat(201) }, 'a request id over 200 characters'],
  ])('%#: %s is a 400 and nothing is sent', async (body) => {
    const res = await POST(req(body), ctx())
    expect(res.status).toBe(400)
    expect(hoisted.steer).not.toHaveBeenCalled()
  })

  it.each([
    ['NOT_FOUND', 404],
    ['NOT_STARTER', 403],
    ['STILL_RUNNING', 409],
    ['WAITING_ON_ANSWER', 409],
    ['DELEGATION_PARKED', 409],
    ['NO_RUN_CHAT', 409],
    ['NOT_RUNNING', 409],
    ['STEER_IN_FLIGHT', 409],
    ['USAGE_LIMIT', 429],
  ])('refused %s: %i, with the relay’s code', async (code, status) => {
    hoisted.steer.mockImplementation(async () => ({ status: 'refused', code, reason: 'for the agent' }))
    const res = await POST(req({ message: 'x' }), ctx())
    expect(res.status).toBe(status)
    const body = (await readJson(res)) as { error: string; code: string }
    expect(body.code).toBe(code)
    // The person's words, never the relay's main-agent copy.
    expect(body.error).not.toBe('for the agent')
  })

  it('eve not taking it is a 502 NOT_DELIVERED', async () => {
    hoisted.steer.mockImplementation(async () => ({ status: 'failed', reason: 'x' }))
    const res = await POST(req({ message: 'x' }), ctx())
    expect(res.status).toBe(502)
    expect(await readJson(res)).toMatchObject({ code: 'NOT_DELIVERED' })
  })

  it('a relay that throws before sending is a 500', async () => {
    hoisted.steer.mockImplementation(async () => {
      throw new Error('read failed')
    })
    const res = await POST(req({ message: 'x' }), ctx())
    expect(res.status).toBe(500)
  })

  describe('a local agent’s turn', () => {
    const localRow = () => ({ id: ITEM, kind: 'local_agent', workspace_id: 'ws-1', source: { local_agent_session_id: SESSION } })

    it('goes to its session as the person, steer by default, keyed on the request id, never to the relay', async () => {
      hoisted.state.row = localRow()
      const res = await POST(req({ message: '  also check the auth routes ', request_id: 'req-1' }), ctx())
      expect(res.status).toBe(200)
      const body = (await readJson(res)) as Record<string, unknown>
      expect(body).toMatchObject({ ok: true, status: 'steered', message_id: 'msg-1', requeued: false })
      expect(body).not.toHaveProperty('duplicate')
      expect(hoisted.addMessage).toHaveBeenCalledWith(hoisted.service, {
        userId: 'user-1',
        sessionId: SESSION,
        author: 'person',
        text: 'also check the auth routes',
        policy: 'steer',
        idempotencyKey: 'steer:req-1',
      })
      expect(hoisted.steer).not.toHaveBeenCalled()
      // The row is read in the caller's workspace.
      expect(hoisted.service.from).toHaveBeenCalledWith('tracked_job')
      expect(hoisted.state.filters).toEqual([
        ['id', ITEM],
        ['workspace_id', 'ws-1'],
      ])
    })

    it('a retried request id sends once: the library answers duplicate, and so does the route', async () => {
      hoisted.state.row = localRow()
      hoisted.addMessage.mockImplementation(async () => ({ messageId: 'msg-1', requeued: false, duplicate: true }))
      const res = await POST(req({ message: 'x', request_id: 'req-1' }), ctx())
      expect(res.status).toBe(200)
      expect(await readJson(res)).toMatchObject({ ok: true, message_id: 'msg-1', duplicate: true })
      // Without a request id: no key.
      hoisted.addMessage.mockClear()
      await POST(req({ message: 'x' }), ctx())
      expect(hoisted.addMessage.mock.calls[0][1]).not.toHaveProperty('idempotencyKey')
    })

    it('Queue is passed on; a bad policy is a 400 and nothing is sent', async () => {
      hoisted.state.row = localRow()
      await POST(req({ message: 'next: the tests', policy: 'queue' }), ctx())
      expect(hoisted.addMessage.mock.calls[0][1]).toMatchObject({ policy: 'queue' })
      hoisted.addMessage.mockClear()
      const res = await POST(req({ message: 'x', policy: 'now' }), ctx())
      expect(res.status).toBe(400)
      expect(hoisted.addMessage).not.toHaveBeenCalled()
    })

    it('a row naming no session is a 409 NO_RUN_CHAT', async () => {
      hoisted.state.row = { ...localRow(), source: {} }
      const res = await POST(req({ message: 'x' }), ctx())
      expect(res.status).toBe(409)
      expect(await readJson(res)).toMatchObject({ code: 'NO_RUN_CHAT' })
      expect(hoisted.addMessage).not.toHaveBeenCalled()
    })

    it.each<[string, number, string]>([
      ['not_found', 404, 'NOT_FOUND'],
      ['conflict', 409, 'NOT_RUNNING'],
      ['bad_request', 400, 'INPUT_INVALID'],
    ])('the library refusing (%s) is a %i %s', async (code, status, apiCode) => {
      hoisted.state.row = localRow()
      hoisted.addMessage.mockImplementation(async () => {
        throw new LocalAgentError(code, 'This local agent has been stopped; start a new one')
      })
      const res = await POST(req({ message: 'x' }), ctx())
      expect(res.status).toBe(status)
      expect(await readJson(res)).toMatchObject({ code: apiCode })
    })

    it('a failure sending, or reading the row, is a 500', async () => {
      hoisted.state.row = localRow()
      hoisted.addMessage.mockImplementation(async () => {
        throw new Error('insert failed')
      })
      expect((await POST(req({ message: 'x' }), ctx())).status).toBe(500)
      hoisted.state.rowError = { message: 'timeout' }
      expect((await POST(req({ message: 'x' }), ctx())).status).toBe(500)
      expect(hoisted.steer).not.toHaveBeenCalled()
    })

    it('any other row goes to the relay as before', async () => {
      hoisted.state.row = { id: ITEM, kind: 'work_run', workspace_id: 'ws-1', source: {} }
      const res = await POST(req({ message: 'x' }), ctx())
      expect(res.status).toBe(200)
      expect(hoisted.steer).toHaveBeenCalledTimes(1)
      expect(hoisted.addMessage).not.toHaveBeenCalled()
    })
  })
})
