/**
 * The Slack interactivity route: Slack's own signature over the raw body and
 * nothing else, our app only, the clicker mapped through their link, and the
 * card settled as theirs after the response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SLACK_TEST_APP_ID, slackSignatureHeaders, stubSlackEnv } from '@/test/slack'

const m = vi.hoisted(() => ({
  getInstallation: vi.fn(),
  linkForSlackUser: vi.fn(),
  memberIdOf: vi.fn(),
  settle: vi.fn(),
  afterFns: [] as Array<() => Promise<void>>,
}))

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (fn: () => Promise<void>) => m.afterFns.push(fn),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/slack/store', () => ({ getInstallation: m.getInstallation, linkForSlackUser: m.linkForSlackUser, memberIdOf: m.memberIdOf }))
vi.mock('@/lib/slack/approvals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/slack/approvals')>()),
  settleApprovalFromSlack: m.settle,
}))

import { POST } from '../route'

const APP = SLACK_TEST_APP_ID
const CARD = '44444444-4444-4444-8444-444444444444'
const USER = '22222222-2222-4222-8222-222222222222'

const click = (over: Record<string, unknown> = {}) => ({
  type: 'block_actions',
  api_app_id: APP,
  team: { id: 'T111' },
  user: { id: 'U222', team_id: 'T111' },
  actions: [{ action_id: 'ni_approve', value: CARD }],
  response_url: 'https://hooks.slack.com/actions/x',
  ...over,
})

/** A click as Slack sends it: signed over the exact form body, unless `headers` says otherwise. */
const req = (payload: unknown, headers?: Record<string, string>) => {
  const raw = new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
  return new Request('https://nativeintelligence.dev/api/slack/interactivity', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(headers ?? slackSignatureHeaders(raw)) },
    body: raw,
  })
}

const fetchMock = vi.fn(async () => new Response('ok'))

beforeEach(() => {
  stubSlackEnv()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockClear()
  for (const fn of [m.getInstallation, m.linkForSlackUser, m.memberIdOf, m.settle]) fn.mockReset()
  m.afterFns.length = 0
  m.getInstallation.mockResolvedValue({ slack_team_id: 'T111', workspace_id: 'ws', status: 'active' })
  m.linkForSlackUser.mockResolvedValue({ user_id: USER })
  m.memberIdOf.mockResolvedValue('m1')
  m.settle.mockResolvedValue({ ok: true, decision: 'approve', ran: true, success: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('POST /api/slack/interactivity', () => {
  it('takes a click signed by Slack; no signature, a wrong or stale one, or the old bearer alone is 401 and reads nothing', async () => {
    expect((await POST(req(click()))).status).toBe(200)
    expect(m.afterFns).toHaveLength(1)

    m.afterFns.length = 0
    const raw = new URLSearchParams({ payload: JSON.stringify(click()) }).toString()
    const cases: Array<Record<string, string>> = [
      {},
      { authorization: 'Bearer made-up-oidc-token' },
      slackSignatureHeaders(raw, { secret: '00000000000000000000000000000000' }),
      slackSignatureHeaders(raw, { at: Date.now() - 6 * 60_000 }),
      slackSignatureHeaders(new URLSearchParams({ payload: JSON.stringify(click({ api_app_id: 'A999' })) }).toString()),
    ]
    for (const headers of cases) {
      expect((await POST(req(click(), headers))).status).toBe(401)
    }
    expect(m.afterFns).toHaveLength(0)
  })

  it('is off (503) when Slack is not fully configured', async () => {
    stubSlackEnv({ SLACK_CLIENT_SECRET: '' })
    expect((await POST(req(click()))).status).toBe(503)
    expect(m.afterFns).toHaveLength(0)
  })

  it('settles the card as the linked person, then updates the message through Slack’s response_url', async () => {
    await POST(req(click()))
    await m.afterFns[0]()
    expect(m.linkForSlackUser).toHaveBeenCalledWith({}, 'T111', 'U222')
    expect(m.settle).toHaveBeenCalledWith({}, { userId: USER, memberId: 'm1', cardId: CARD, decision: 'approve' })
    expect(fetchMock).toHaveBeenCalledWith('https://hooks.slack.com/actions/x', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toMatchObject({ replace_original: true, text: 'Approved. It ran.' })
  })

  it('an unlinked clicker, an outsider, or a disconnected team settles nothing', async () => {
    m.linkForSlackUser.mockResolvedValueOnce(null)
    await POST(req(click()))
    await POST(req(click({ user: { id: 'U222', team_id: 'T999' } })))
    m.getInstallation.mockResolvedValueOnce({ slack_team_id: 'T111', workspace_id: 'ws', status: 'revoked' })
    await POST(req(click()))
    for (const fn of m.afterFns) await fn()
    expect(m.settle).not.toHaveBeenCalled()
  })

  it("acks another app's click without doing anything", async () => {
    expect((await POST(req(click({ api_app_id: 'A999' })))).status).toBe(200)
    expect(m.afterFns).toHaveLength(0)
  })
})
