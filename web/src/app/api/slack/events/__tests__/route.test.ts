/**
 * The Slack events route's own boundaries: Slack's signature over the raw
 * body and nothing else, our app only, the url_verification challenge only
 * after a good signature, dedupe before any work, the work after the response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SLACK_TEST_APP_ID, slackSignatureHeaders, stubSlackEnv } from '@/test/slack'

const m = vi.hoisted(() => ({
  firstDelivery: vi.fn(),
  handle: vi.fn(),
  afterFns: [] as Array<() => Promise<void>>,
}))

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (fn: () => Promise<void>) => m.afterFns.push(fn),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/slack/deps', () => ({ slackInboundDeps: (extra: object) => extra, slackTurnSlack: () => ({}) }))
vi.mock('@/lib/slack/person-dm', () => ({ handlePersonDm: vi.fn(async () => 'queued') }))
vi.mock('@/lib/slack/turn', () => ({ SLACK_TURN_NOTICES: { failed: () => 'failed' }, deliverSlackMention: vi.fn(async () => 'queued') }))
vi.mock('@/lib/slack/inbound', () => ({ handleSlackInbound: m.handle }))
vi.mock('@/lib/slack/store', () => ({ firstDelivery: m.firstDelivery, purgeOldEvents: vi.fn(async () => {}) }))

import { POST } from '../route'

const APP = SLACK_TEST_APP_ID
const dmEvent = {
  type: 'event_callback',
  api_app_id: APP,
  team_id: 'T111',
  event_id: 'Ev1',
  event: { type: 'message', channel_type: 'im', user: 'U222', channel: 'D333', ts: '1700000000.000100', text: 'hi' },
}

/** A request as Slack sends it: signed over the exact body, unless `headers` says otherwise. */
const req = (body: unknown, headers?: Record<string, string>) => {
  const raw = JSON.stringify(body)
  return new Request('https://nativeintelligence.dev/api/slack/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers ?? slackSignatureHeaders(raw)) },
    body: raw,
  })
}

beforeEach(() => {
  stubSlackEnv()
  m.firstDelivery.mockReset().mockResolvedValue(true)
  m.handle.mockReset().mockResolvedValue('person_dm')
  m.afterFns.length = 0
})
afterEach(() => vi.unstubAllEnvs())

describe('POST /api/slack/events', () => {
  it('takes a request signed by Slack: records the event, acks, and does the work after the response', async () => {
    const res = await POST(req(dmEvent))
    expect(res.status).toBe(200)
    expect(m.firstDelivery).toHaveBeenCalledWith(expect.anything(), 'Ev1', 'T111')
    expect(m.handle).not.toHaveBeenCalled()
    expect(m.afterFns).toHaveLength(1)
    await m.afterFns[0]()
    expect(m.handle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'dm', slackUserId: 'U222' }), expect.anything())
  })

  it('refuses a request with no signature, a wrong one, or a stale one, before reading anything', async () => {
    const raw = JSON.stringify(dmEvent)
    const cases: Array<Record<string, string>> = [
      {},
      slackSignatureHeaders(raw, { secret: '00000000000000000000000000000000' }),
      slackSignatureHeaders(raw, { at: Date.now() - 6 * 60_000 }),
      // Signed over another body.
      slackSignatureHeaders(JSON.stringify({ ...dmEvent, event_id: 'Ev2' })),
    ]
    for (const headers of cases) {
      const res = await POST(req(dmEvent, headers))
      expect(res.status).toBe(401)
    }
    expect(m.firstDelivery).not.toHaveBeenCalled()
    expect(m.afterFns).toHaveLength(0)
  })

  it('refuses the old forwarded bearer on its own', async () => {
    const res = await POST(req(dmEvent, { authorization: 'Bearer made-up-oidc-token' }))
    expect(res.status).toBe(401)
    expect(m.firstDelivery).not.toHaveBeenCalled()
  })

  it('answers url_verification only under a good signature', async () => {
    const challenge = { type: 'url_verification', challenge: 'xyz' }
    expect(await (await POST(req(challenge))).json()).toEqual({ challenge: 'xyz' })
    const unsigned = await POST(req(challenge, {}))
    expect(unsigned.status).toBe(401)
    expect(await unsigned.text()).not.toContain('xyz')
  })

  it('is off (503) when any of the four Slack settings is missing or malformed', async () => {
    for (const over of [{ SLACK_APP_ID: '' }, { SLACK_CLIENT_ID: '' }, { SLACK_CLIENT_SECRET: 'short' }, { SLACK_SIGNING_SECRET: '' }]) {
      stubSlackEnv(over)
      const res = await POST(req(dmEvent))
      expect(res.status).toBe(503)
    }
    expect(m.firstDelivery).not.toHaveBeenCalled()
  })

  it("acks another app's event without doing anything", async () => {
    const res = await POST(req({ ...dmEvent, api_app_id: 'A999' }))
    expect(res.status).toBe(200)
    expect(m.firstDelivery).not.toHaveBeenCalled()
    expect(m.afterFns).toHaveLength(0)
  })

  it('does nothing for a retried event', async () => {
    m.firstDelivery.mockResolvedValue(false)
    const res = await POST(req(dmEvent))
    expect(res.status).toBe(200)
    expect(m.afterFns).toHaveLength(0)
  })

  it('answers 500 when the dedupe write fails, so the event is sent again', async () => {
    m.firstDelivery.mockRejectedValue(new Error('db down'))
    const res = await POST(req(dmEvent))
    expect(res.status).toBe(500)
    expect(m.afterFns).toHaveLength(0)
  })
})
