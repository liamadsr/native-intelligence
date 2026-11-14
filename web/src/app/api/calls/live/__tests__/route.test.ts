import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  afters: [] as Array<() => Promise<unknown>>,
  caller: null as null | { userId: string; workspaceId: string; via: 'verified_phone' | 'dev_mapping' },
  accepts: [] as Array<{ sessionId: string; session: { instructions: string; delegation: { type: string } } }>,
  rejects: [] as Array<{ sessionId: string; statusCode: number }>,
  hangups: [] as string[],
  lookups: 0,
  acceptResult: { ok: true } as { ok: true } | { ok: false; status: number; code: string | null },
  bridges: [] as Array<{ sessionId: string }>,
}))

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => {
    h.afters.push(task)
  },
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }))
vi.mock('@/lib/calls/caller', async (orig) => ({
  ...(await orig<typeof import('@/lib/calls/caller')>()),
  resolveCallCaller: async () => {
    h.lookups++
    return h.caller
  },
  callerDisplayName: async () => 'Liam Alizadeh',
}))
vi.mock('@/lib/calls/live-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/calls/live-api')>()),
  acceptLiveCall: async (sessionId: string, session: never) => {
    h.accepts.push({ sessionId, session })
    return h.acceptResult
  },
  rejectLiveCall: async (sessionId: string, statusCode: number) => {
    h.rejects.push({ sessionId, statusCode })
    return { ok: true }
  },
  hangUpLiveCall: async (sessionId: string) => {
    h.hangups.push(sessionId)
    return { ok: true }
  },
}))
vi.mock('@/lib/calls/live-bridge', () => ({
  runLiveCall: async (args: { sessionId: string }) => {
    if (args.sessionId === 'live_attach_fails') throw new Error('attach refused (403)')
    h.bridges.push({ sessionId: args.sessionId })
  },
}))

import { POST } from '../route'

const KEY = Buffer.from('route test signing key')
const SECRET = `whsec_${KEY.toString('base64')}`

function delivery(event: unknown, opts: { secret?: Buffer; ts?: number } = {}): Request {
  const body = JSON.stringify(event)
  const ts = opts.ts ?? Math.floor(Date.now() / 1000)
  const sig = createHmac('sha256', new Uint8Array(opts.secret ?? KEY)).update(`wh_1.${ts}.${body}`).digest('base64')
  return new Request('https://nativeintelligence.test/api/calls/live', {
    method: 'POST',
    headers: { 'webhook-id': 'wh_1', 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${sig}` },
    body,
  })
}

const TRUNK = 'trunk-secret-for-tests'
const incoming = (from = '<sip:+14155550100@sip.twilio.com>;tag=1', verstat: string | null = 'TN-Validation-Passed-A', sessionId = 'live_abc', trunk: string | null = TRUNK) => ({
  id: 'evt_1',
  type: 'live.transport.incoming',
  created_at: 1,
  data: {
    type: 'sip',
    session_id: sessionId,
    sip_media_security: 'srtp',
    sip_headers: [
      { name: 'From', value: from },
      ...(verstat ? [{ name: 'X-Twilio-VerStat', value: verstat }] : []),
      ...(trunk ? [{ name: 'X-NI-Trunk', value: trunk }] : []),
    ],
  },
})

beforeEach(() => {
  h.afters = []
  h.caller = { userId: 'u1', workspaceId: 'w1', via: 'verified_phone' }
  h.accepts = []
  h.rejects = []
  h.hangups = []
  h.lookups = 0
  h.acceptResult = { ok: true }
  h.bridges = []
  vi.stubEnv('GPT_LIVE_WEBHOOK_SECRET', SECRET)
  vi.stubEnv('GPT_LIVE_API_KEY', 'sk-live-test')
  vi.stubEnv('GPT_LIVE_TRUNK_SECRET', TRUNK)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /api/calls/live', () => {
  it('accepts the person’s call in client delegation mode, then bridges it after the answer', async () => {
    const res = await POST(delivery(incoming()))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, outcome: 'accepted' })
    expect(h.accepts).toHaveLength(1)
    expect(h.accepts[0].sessionId).toBe('live_abc')
    expect(h.accepts[0].session.delegation).toEqual({ type: 'client' })
    expect(h.accepts[0].session.instructions).toContain("Liam's own AI agent")
    expect(h.bridges).toEqual([])
    await h.afters[0]()
    expect(h.bridges).toEqual([{ sessionId: 'live_abc' }])
  })

  it('refuses a delivery that is not signed with the secret, reading nothing', async () => {
    const res = await POST(delivery(incoming(), { secret: Buffer.from('someone else') }))
    expect(res.status).toBe(401)
    expect(h.accepts).toEqual([])
    vi.stubEnv('GPT_LIVE_WEBHOOK_SECRET', '')
    expect((await POST(delivery(incoming()))).status).toBe(503)
  })

  it('ignores every other event (the same call’s realtime.call.incoming among them)', async () => {
    const res = await POST(delivery({ ...incoming(), type: 'realtime.call.incoming' }))
    expect(await res.json()).toEqual({ ok: true, ignored: true })
    expect(h.accepts).toEqual([])
    expect(h.rejects).toEqual([])
  })

  it('declines a call from a number nobody linked, or with no caller ID', async () => {
    h.caller = null
    expect(await (await POST(delivery(incoming()))).json()).toEqual({ ok: true, outcome: 'declined' })
    expect(await (await POST(delivery(incoming('<sip:anonymous@anonymous.invalid>')))).json()).toEqual({ ok: true, outcome: 'declined' })
    expect(h.rejects).toEqual([
      { sessionId: 'live_abc', statusCode: 603 },
      { sessionId: 'live_abc', statusCode: 603 },
    ])
    expect(h.accepts).toEqual([])
  })

  it("declines a call that didn't come through our trunk (no secret header, or a wrong one), before any lookup", async () => {
    for (const trunk of [null, 'guessed', `${TRUNK}x`]) {
      expect(await (await POST(delivery(incoming(undefined, undefined, undefined, trunk)))).json()).toEqual({ ok: true, outcome: 'declined' })
    }
    expect(h.rejects).toHaveLength(3)
    expect(h.accepts).toEqual([])
    expect(h.lookups).toBe(0)
    expect((console.warn as unknown as { mock: { calls: string[][] } }).mock.calls.at(-1)?.[0]).toContain('outcome=untrusted_trunk:mismatch')
  })

  it('declines every call without GPT_LIVE_TRUNK_SECRET, on a deployment or a dev box', async () => {
    vi.stubEnv('GPT_LIVE_TRUNK_SECRET', '')
    vi.stubEnv('NODE_ENV', 'development')
    expect(await (await POST(delivery(incoming()))).json()).toEqual({ ok: true, outcome: 'declined' })
    expect((console.warn as unknown as { mock: { calls: string[][] } }).mock.calls.at(-1)?.[0]).toContain('outcome=untrusted_trunk:not_configured')
    expect(h.accepts).toEqual([])
  })

  it('declines a call whose caller ID the carrier did not fully attest (an answer is spoken to whoever calls)', async () => {
    for (const verstat of [null, 'TN-Validation-Passed-B', 'TN-Validation-Failed-A', 'No-TN-Validation']) {
      expect(await (await POST(delivery(incoming(undefined, verstat)))).json()).toEqual({ ok: true, outcome: 'declined' })
    }
    expect(h.accepts).toEqual([])
    expect(h.rejects).toHaveLength(4)
    expect((console.info as unknown as { mock: { calls: string[][] } }).mock.calls.at(-1)?.[0]).toContain('outcome=unattested headers=from,x-ni-trunk,x-twilio-verstat')
  })

  it('in local dev only, GPT_LIVE_DEV_SKIP_ATTESTATION answers an unattested call', async () => {
    vi.stubEnv('GPT_LIVE_DEV_SKIP_ATTESTATION', '1')
    vi.stubEnv('NODE_ENV', 'development')
    expect(await (await POST(delivery(incoming(undefined, null)))).json()).toEqual({ ok: true, outcome: 'accepted' })
    vi.stubEnv('NODE_ENV', 'production')
    expect(await (await POST(delivery(incoming(undefined, null)))).json()).toEqual({ ok: true, outcome: 'declined' })
  })

  it('hangs the call up when the bridge cannot attach', async () => {
    expect(await (await POST(delivery(incoming(undefined, undefined, 'live_attach_fails')))).json()).toEqual({ ok: true, outcome: 'accepted' })
    await h.afters[0]()
    expect(h.hangups).toEqual(['live_attach_fails'])
  })

  it('a retried delivery for a call already answered starts no second bridge', async () => {
    h.acceptResult = { ok: false, status: 409, code: 'decision_already_made' }
    expect(await (await POST(delivery(incoming()))).json()).toEqual({ ok: true, outcome: 'already_answered' })
    expect(h.afters).toEqual([])
  })

  it('answers 200 without a key, so OpenAI does not retry a call long gone', async () => {
    vi.stubEnv('GPT_LIVE_API_KEY', '')
    expect(await (await POST(delivery(incoming()))).json()).toEqual({ ok: true, outcome: 'not_configured' })
    expect(h.accepts).toEqual([])
  })
})
