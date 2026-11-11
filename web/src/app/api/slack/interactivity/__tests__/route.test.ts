/**
 * The Slack interactivity route: either Connect's OIDC token or Slack's own
 * signature, our app only, the clicker mapped through their link, and the
 * card settled as theirs after the response.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  verifyConnect: vi.fn(),
  verifierOptions: [] as unknown[],
  verifySignature: vi.fn(),
  getInstallation: vi.fn(),
  linkForSlackUser: vi.fn(),
  memberIdOf: vi.fn(),
  settle: vi.fn(),
  afterFns: [] as Array<() => Promise<void>>,
}))

vi.mock('@vercel/connect/chat', () => ({
  createConnectWebhookVerifier: (options: unknown) => {
    m.verifierOptions.push(options)
    return m.verifyConnect
  },
}))
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (fn: () => Promise<void>) => m.afterFns.push(fn),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/slack/signature', () => ({ verifySlackSignature: m.verifySignature }))
vi.mock('@/lib/slack/store', () => ({ getInstallation: m.getInstallation, linkForSlackUser: m.linkForSlackUser, memberIdOf: m.memberIdOf }))
vi.mock('@/lib/slack/approvals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/slack/approvals')>()),
  settleApprovalFromSlack: m.settle,
}))

import { POST } from '../route'

const APP = 'A0C9N6VPYLF'
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

const req = (payload: unknown, headers: Record<string, string> = {}) =>
  new Request('https://nativeintelligence.dev/api/slack/interactivity', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
  })

const fetchMock = vi.fn(async () => new Response('ok'))

beforeEach(() => {
  vi.stubEnv('SLACK_CONNECTOR', 'slack/ni-public')
  vi.stubEnv('SLACK_APP_ID', APP)
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockClear()
  for (const fn of [m.verifyConnect, m.verifySignature, m.getInstallation, m.linkForSlackUser, m.memberIdOf, m.settle]) fn.mockReset()
  m.afterFns.length = 0
  m.verifierOptions.length = 0
  m.verifyConnect.mockResolvedValue(true)
  m.verifySignature.mockReturnValue(true)
  m.getInstallation.mockResolvedValue({ slack_team_id: 'T111', workspace_id: 'ws', status: 'active' })
  m.linkForSlackUser.mockResolvedValue({ user_id: USER })
  m.memberIdOf.mockResolvedValue('m1')
  m.settle.mockResolvedValue({ ok: true, decision: 'approve', ran: true, success: true })
})

describe('POST /api/slack/interactivity', () => {
  it('a Connect-forwarded click verifies by OIDC; a direct one by Slack’s signature; neither, 401', async () => {
    expect((await POST(req(click(), { authorization: 'Bearer oidc' }))).status).toBe(200)
    expect(m.verifyConnect).toHaveBeenCalled()
    expect(m.verifySignature).not.toHaveBeenCalled()

    expect((await POST(req(click()))).status).toBe(200)
    expect(m.verifySignature).toHaveBeenCalled()

    m.verifyConnect.mockRejectedValue(new Error('bad'))
    m.verifySignature.mockReturnValue(false)
    m.afterFns.length = 0
    expect((await POST(req(click(), { authorization: 'Bearer forged' }))).status).toBe(401)
    expect((await POST(req(click()))).status).toBe(401)
    expect(m.afterFns).toHaveLength(0)
  })

  it('checks a forwarded click against CONNECT_PROJECT_ID and CONNECT_ENVIRONMENT when they are set', async () => {
    vi.stubEnv('CONNECT_PROJECT_ID', 'prj_madeup0001')
    vi.stubEnv('CONNECT_ENVIRONMENT', 'preview')
    await POST(req(click(), { authorization: 'Bearer oidc' }))
    vi.stubEnv('CONNECT_PROJECT_ID', '')
    vi.stubEnv('CONNECT_ENVIRONMENT', '')
    expect(m.verifierOptions).toEqual([{ projectId: 'prj_madeup0001', environment: 'preview' }])
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
