/**
 * The Settings side of Slack: "Add to Slack" hands an admin Slack's own
 * authorize URL and this browser the install's cookie; Disconnect revokes and
 * deletes the team's stored token before marking the row revoked. Every id
 * here is made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubSlackEnv } from '@/test/slack'

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  getInstallation: vi.fn(),
  markInstallationRevoked: vi.fn(),
  revoke: vi.fn(),
  stored: vi.fn(),
  installations: vi.fn(),
  links: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({ requireWorkspaceMember: m.auth }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/slack/bot-token', () => ({ revokeSlackBotToken: m.revoke, teamsWithStoredToken: m.stored }))
vi.mock('@/lib/slack/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/slack/store')>()),
  getInstallation: m.getInstallation,
  markInstallationRevoked: m.markInstallationRevoked,
  installationsForWorkspace: m.installations,
  linksForUser: m.links,
}))

import { DELETE, GET } from '../route'
import { POST as INSTALL } from '../install/route'
import { verifyOAuthState } from '@/lib/oauth/state'

const WS = '11111111-1111-4111-8111-111111111111'
const USER = '33333333-3333-4333-8333-333333333333'
const TEAM = 'T0MADEUP1'

const as = (role: string) => m.auth.mockResolvedValue({ user: { id: USER }, workspaceId: WS, member: { id: 'm1', role } })
const installReq = (body?: unknown) =>
  new Request('https://nativeintelligence.dev/api/account/integrations/slack/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
const disconnectReq = (team = TEAM) => new Request(`https://nativeintelligence.dev/api/account/integrations/slack?team=${team}`, { method: 'DELETE' })

beforeEach(() => {
  stubSlackEnv()
  vi.stubEnv('OAUTH_STATE_SECRET', 'made-up-state-secret')
  for (const fn of Object.values(m)) fn.mockReset()
  as('admin')
  m.getInstallation.mockResolvedValue({ slack_team_id: TEAM, workspace_id: WS, status: 'active' })
  m.markInstallationRevoked.mockResolvedValue(true)
  m.revoke.mockResolvedValue('revoked')
  m.links.mockResolvedValue([])
})
afterEach(() => vi.unstubAllEnvs())

describe('POST …/slack/install', () => {
  it("gives an admin Slack's authorize URL and sets the install's cookie with the state's nonce", async () => {
    const res = await INSTALL(installReq({ returnTo: '/account/agents' }))
    expect(res.status).toBe(200)
    const { url } = (await res.json()) as { url: string }
    expect(url.startsWith('https://slack.com/oauth/v2/authorize?')).toBe(true)
    const state = verifyOAuthState(new URL(url).searchParams.get('state'))
    expect(state.ok && state.data).toMatchObject({ userId: USER, workspaceId: WS, returnTo: '/account/agents', capability: 'slack_install' })
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`slack_install_nonce=${state.ok ? state.data.nonce : 'x'}`)
    expect(cookie.toLowerCase()).toContain('httponly')
  })

  it('works without a body (back to Slack’s settings page)', async () => {
    const { url } = (await (await INSTALL(installReq())).json()) as { url: string }
    const state = verifyOAuthState(new URL(url).searchParams.get('state'))
    expect(state.ok && state.data.returnTo).toBe('/account/settings/connectors/slack')
  })

  it('is for admins only, and only where Slack is set up', async () => {
    as('member')
    expect((await INSTALL(installReq())).status).toBe(403)
    as('admin')
    stubSlackEnv({ SLACK_CLIENT_ID: '' })
    expect((await INSTALL(installReq())).status).toBe(404)
  })
})

describe('DELETE …/slack?team=', () => {
  it('revokes and deletes the stored token, then marks the row revoked', async () => {
    const res = await DELETE(disconnectReq())
    expect(res.status).toBe(200)
    expect(m.revoke).toHaveBeenCalledWith(TEAM)
    expect(m.markInstallationRevoked).toHaveBeenCalledWith(expect.anything(), TEAM, WS)
  })

  it('marks nothing when the token could not be deleted; a token already gone still disconnects', async () => {
    m.revoke.mockResolvedValueOnce('failed')
    expect((await DELETE(disconnectReq())).status).toBe(502)
    expect(m.markInstallationRevoked).not.toHaveBeenCalled()
    m.revoke.mockResolvedValueOnce('gone')
    expect((await DELETE(disconnectReq())).status).toBe(200)
    expect(m.markInstallationRevoked).toHaveBeenCalledTimes(1)
  })

  it('touches nothing for a member, another workspace’s team, or a bad id', async () => {
    as('member')
    expect((await DELETE(disconnectReq())).status).toBe(403)
    as('admin')
    m.getInstallation.mockResolvedValueOnce({ slack_team_id: TEAM, workspace_id: 'elsewhere', status: 'active' })
    expect((await DELETE(disconnectReq())).status).toBe(404)
    expect((await DELETE(disconnectReq('nope'))).status).toBe(400)
    expect(m.revoke).not.toHaveBeenCalled()
  })
})

describe('GET …/slack', () => {
  const installation = (teamId: string, teamName: string) => ({ slack_team_id: teamId, team_name: teamName, team_domain: '', workspace_id: WS, status: 'active', created_at: '2026-11-01T00:00:00Z' })

  it('says, per connected Slack workspace, whether the app holds its token (false: add it again)', async () => {
    m.installations.mockResolvedValue([installation(TEAM, 'Acme'), installation('T0OLDWAY1', 'Beta')])
    m.stored.mockResolvedValue(new Set([TEAM]))
    const res = await GET()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { installations: Array<{ teamId: string; tokenStored: boolean }> }
    expect(m.stored).toHaveBeenCalledWith(expect.anything(), [TEAM, 'T0OLDWAY1'])
    expect(body.installations.map((i) => [i.teamId, i.tokenStored])).toEqual([
      [TEAM, true],
      ['T0OLDWAY1', false],
    ])
    expect(body).not.toHaveProperty('selfInstallOpen')
  })

  it('a failed read of the tokens is an error, not a false "connected"', async () => {
    m.installations.mockResolvedValue([installation(TEAM, 'Acme')])
    m.stored.mockRejectedValue(new Error('down'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await GET()).status).toBe(500)
    err.mockRestore()
  })
})
