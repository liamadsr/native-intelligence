/**
 * The Slack events route's own boundaries: the Connect OIDC token, our app
 * only, dedupe before any work, the work after the response.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  verify: vi.fn(),
  firstDelivery: vi.fn(),
  handle: vi.fn(),
  afterFns: [] as Array<() => Promise<void>>,
}))

vi.mock('@vercel/connect/chat', () => ({ createConnectWebhookVerifier: () => m.verify }))
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

const APP = 'A0C9N6VPYLF'
const dmEvent = {
  type: 'event_callback',
  api_app_id: APP,
  team_id: 'T111',
  event_id: 'Ev1',
  event: { type: 'message', channel_type: 'im', user: 'U222', channel: 'D333', ts: '1700000000.000100', text: 'hi' },
}

const req = (body: unknown, auth = 'Bearer oidc') =>
  new Request('https://nativeintelligence.dev/api/slack/events', { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.stubEnv('SLACK_CONNECTOR', 'slack/ni-public')
  vi.stubEnv('SLACK_APP_ID', APP)
  m.verify.mockReset().mockResolvedValue(true)
  m.firstDelivery.mockReset().mockResolvedValue(true)
  m.handle.mockReset().mockResolvedValue('person_dm')
  m.afterFns.length = 0
})

describe('POST /api/slack/events', () => {
  it('refuses a request whose Connect OIDC token does not verify, before reading anything', async () => {
    m.verify.mockRejectedValue(new Error('bad token'))
    const res = await POST(req(dmEvent))
    expect(res.status).toBe(401)
    expect(m.firstDelivery).not.toHaveBeenCalled()
    expect(m.afterFns).toHaveLength(0)
  })

  it('is off (503) when the deployment has no Slack app configured', async () => {
    vi.stubEnv('SLACK_APP_ID', '')
    const res = await POST(req(dmEvent))
    expect(res.status).toBe(503)
    expect(m.verify).not.toHaveBeenCalled()
  })

  it('answers url_verification', async () => {
    const res = await POST(req({ type: 'url_verification', challenge: 'xyz' }))
    expect(await res.json()).toEqual({ challenge: 'xyz' })
  })

  it("acks another app's event without doing anything", async () => {
    const res = await POST(req({ ...dmEvent, api_app_id: 'A999' }))
    expect(res.status).toBe(200)
    expect(m.firstDelivery).not.toHaveBeenCalled()
    expect(m.afterFns).toHaveLength(0)
  })

  it('records the event, acks, and does the work after the response', async () => {
    const res = await POST(req(dmEvent))
    expect(res.status).toBe(200)
    expect(m.firstDelivery).toHaveBeenCalledWith(expect.anything(), 'Ev1', 'T111')
    expect(m.handle).not.toHaveBeenCalled()
    expect(m.afterFns).toHaveLength(1)
    await m.afterFns[0]()
    expect(m.handle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'dm', slackUserId: 'U222' }), expect.anything())
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
