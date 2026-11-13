/**
 * Slack's OAuth v2 install, ours (install.ts): the authorize link and its
 * signed state, and the finish: who may finish it, what Slack's answer must
 * be, the token stored encrypted, and the team bound under the link code's
 * rules. Every id and token here is made up.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SLACK_TEST_APP_ID, SLACK_TEST_CLIENT_ID, stubSlackEnv } from '@/test/slack'

const store = vi.hoisted(() => ({
  memberRole: vi.fn(),
  getInstallation: vi.fn(),
  bindInstallation: vi.fn(),
  linkSlackUser: vi.fn(),
}))
vi.mock('../store', async (importOriginal) => ({ ...(await importOriginal<typeof import('../store')>()), ...store }))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    throw new Error('tests pass their own client')
  },
}))

import { SLACK_INSTALL_CAPABILITY, buildSlackInstall, completeSlackInstall, safeSlackReturnTo, type SlackInstallDeps } from '../install'
import { readSlackGrant, saveSlackBotToken } from '../bot-token'
import { verifyOAuthState } from '@/lib/oauth/state'
import { decryptCredential } from '@/lib/crypto/credentials'

const TEAM = 'T0MADEUP1'
const WS = '11111111-1111-4111-8111-111111111111'
const OTHER_WS = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'
const svc = {} as never

const answer = (over: Record<string, unknown> = {}) => ({
  ok: true,
  app_id: SLACK_TEST_APP_ID,
  token_type: 'bot',
  access_token: 'xoxb-made-up-install',
  scope: 'app_mentions:read,chat:write',
  bot_user_id: 'U0BOT0001',
  team: { id: TEAM, name: 'Acme' },
  enterprise: null,
  authed_user: { id: 'U0ADMIN01' },
  is_enterprise_install: false,
  ...over,
})

function makeDeps(body: unknown = answer(), over: Partial<SlackInstallDeps> = {}) {
  const deps: SlackInstallDeps = {
    exchange: vi.fn(async () => readSlackGrant(body)),
    saveToken: vi.fn(async () => true),
    slack: {
      authTest: vi.fn(async () => ({ ok: true as const, team_id: TEAM, team: 'Acme', user_id: 'U0BOT0001' })),
      teamInfo: vi.fn(async () => ({ ok: true as const, team: { id: TEAM, name: 'Acme', domain: 'acme' } })),
      userInfo: vi.fn(async () => ({ ok: true as const, user: { id: 'U0ADMIN01', team_id: TEAM, is_admin: true, profile: { display_name: 'sam' } } })),
    },
    now: () => Date.UTC(2026, 10, 13, 12, 0, 0),
    ...over,
  }
  return deps
}

beforeAll(() => vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 9).toString('base64')))
afterAll(() => vi.unstubAllEnvs())

beforeEach(() => {
  stubSlackEnv()
  vi.stubEnv('OAUTH_STATE_SECRET', 'made-up-state-secret')
  for (const fn of Object.values(store)) fn.mockReset()
  store.memberRole.mockResolvedValue('admin')
  store.getInstallation.mockResolvedValue(null)
  store.bindInstallation.mockResolvedValue({ ok: true, rebound: false })
  store.linkSlackUser.mockResolvedValue(true)
})

describe('the authorize link', () => {
  it("is Slack's, with our client id, exactly the bot scopes, our redirect URI and a signed state naming who started it", () => {
    const { url, state, nonce } = buildSlackInstall({ userId: USER, workspaceId: WS, returnTo: '/account/agents', pageOrigin: 'https://nativeintelligence.dev' })
    const u = new URL(url)
    expect(`${u.origin}${u.pathname}`).toBe('https://slack.com/oauth/v2/authorize')
    expect(u.searchParams.get('client_id')).toBe(SLACK_TEST_CLIENT_ID)
    expect(u.searchParams.get('scope')).toBe('app_mentions:read,chat:write,im:history,im:read,im:write,reactions:write,team:read,users:read')
    expect(u.searchParams.get('redirect_uri')).toMatch(/^https?:\/\/[^/]+\/api\/slack\/oauth\/callback$/)
    expect(u.searchParams.get('user_scope')).toBeNull()
    expect(u.searchParams.get('state')).toBe(state)
    const verified = verifyOAuthState(state)
    expect(verified.ok && verified.data).toMatchObject({
      nonce,
      userId: USER,
      workspaceId: WS,
      capability: SLACK_INSTALL_CAPABILITY,
      source: 'web',
      returnTo: '/account/agents',
      origin: 'https://nativeintelligence.dev',
    })
  })

  it('returns only to a page in the account area', () => {
    expect(safeSlackReturnTo('/account/settings/connectors/slack')).toBe('/account/settings/connectors/slack')
    for (const bad of ['https://evil.example/x', '//evil.example', '/account//evil', '/api/x', '/account/x?y=1', null, 3]) {
      expect(safeSlackReturnTo(bad)).toBe('/account/settings/connectors/slack')
    }
  })

  it('a tampered state does not verify', () => {
    const { state } = buildSlackInstall({ userId: USER, workspaceId: WS })
    expect(verifyOAuthState(`x${state}`).ok).toBe(false)
  })
})

describe('finishing the install', () => {
  it('stores the token encrypted, binds the team to the starter’s workspace and links the Slack admin who ran it', async () => {
    const rows: Record<string, unknown>[] = []
    const fakeDb = {
      from: () => {
        const b = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({ data: null, error: null }),
          upsert: async (row: Record<string, unknown>) => (rows.push(row), { error: null }),
        }
        return b
      },
    } as never
    const deps = makeDeps(answer(), { saveToken: (input) => saveSlackBotToken(fakeDb, input) })

    expect(await completeSlackInstall(svc, { code: 'made-up-code', userId: USER, workspaceId: WS }, deps)).toBe('installed')

    expect(deps.exchange).toHaveBeenCalledWith('made-up-code')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ slack_team_id: TEAM, app_id: SLACK_TEST_APP_ID, bot_user_id: 'U0BOT0001', version: 1, refresh_token_enc: null, expires_at: null })
    expect(JSON.stringify(rows[0])).not.toContain('xoxb-made-up-install')
    expect(decryptCredential(rows[0].bot_token_enc as string)).toBe('xoxb-made-up-install')
    expect(store.bindInstallation).toHaveBeenCalledWith(svc, {
      teamId: TEAM,
      teamName: 'Acme',
      teamDomain: 'acme',
      enterpriseId: null,
      workspaceId: WS,
      userId: USER,
      botUserId: 'U0BOT0001',
    })
    expect(store.linkSlackUser).toHaveBeenCalledWith(svc, { teamId: TEAM, slackUserId: 'U0ADMIN01', userId: USER, slackUserName: 'sam' })
  })

  it('keeps a rotating token’s refresh token and expiry', async () => {
    const deps = makeDeps(answer({ access_token: 'xoxe.xoxb-made-up', refresh_token: 'xoxe-1-made-up', expires_in: 43_200 }))
    expect(await completeSlackInstall(svc, { code: 'c', userId: USER, workspaceId: WS }, deps)).toBe('installed')
    expect(deps.saveToken).toHaveBeenCalledWith(
      expect.objectContaining({ botToken: 'xoxe.xoxb-made-up', refreshToken: 'xoxe-1-made-up', expiresAt: Date.UTC(2026, 10, 13, 12, 0, 0) + 43_200_000 }),
    )
  })

  it('refuses an organization-wide install, and stores nothing', async () => {
    const deps = makeDeps(answer({ is_enterprise_install: true, team: null, enterprise: { id: 'E0MADEUP1' } }))
    expect(await completeSlackInstall(svc, { code: 'c', userId: USER, workspaceId: WS }, deps)).toBe('enterprise')
    expect(deps.saveToken).not.toHaveBeenCalled()
    expect(store.bindInstallation).not.toHaveBeenCalled()
  })

  it("refuses another app's install, a user token, and an answer with no team; stores nothing", async () => {
    for (const body of [answer({ app_id: 'A0OTHER01' }), answer({ token_type: 'user' }), answer({ access_token: undefined }), answer({ team: {} })]) {
      const deps = makeDeps(body)
      expect(await completeSlackInstall(svc, { code: 'c', userId: USER, workspaceId: WS }, deps)).toBe('failed')
      expect(deps.saveToken).not.toHaveBeenCalled()
    }
    expect(store.bindInstallation).not.toHaveBeenCalled()
  })

  it("an error from Slack is 'failed', with nothing stored", async () => {
    const deps = makeDeps({ ok: false, error: 'invalid_code' })
    expect(await completeSlackInstall(svc, { code: 'c', userId: USER, workspaceId: WS }, deps)).toBe('failed')
    expect(deps.saveToken).not.toHaveBeenCalled()
  })

  it('the starter must still be an admin of the workspace; nothing is exchanged otherwise', async () => {
    for (const role of ['member', 'guest', null]) {
      store.memberRole.mockResolvedValueOnce(role)
      const deps = makeDeps()
      expect(await completeSlackInstall(svc, { code: 'c', userId: USER, workspaceId: WS }, deps)).toBe('not_admin')
      expect(deps.exchange).not.toHaveBeenCalled()
    }
  })

  it('a team live in another workspace stays there (the token is still the team’s)', async () => {
    store.getInstallation.mockResolvedValue({ slack_team_id: TEAM, workspace_id: OTHER_WS, status: 'active' })
    const deps = makeDeps()
    expect(await completeSlackInstall(svc, { code: 'c', userId: USER, workspaceId: WS }, deps)).toBe('other_workspace')
    expect(store.bindInstallation).not.toHaveBeenCalled()
    expect(store.linkSlackUser).not.toHaveBeenCalled()
  })

  it('a bind that loses a race to another workspace is other_workspace', async () => {
    store.bindInstallation.mockResolvedValue({ ok: false, reason: 'other_workspace' })
    expect(await completeSlackInstall(svc, { code: 'c', userId: USER, workspaceId: WS }, makeDeps())).toBe('other_workspace')
  })

  it('a new team is bound only when a Slack admin or owner ran the install', async () => {
    const deps = makeDeps(answer(), {})
    deps.slack.userInfo = vi.fn(async () => ({ ok: true as const, user: { id: 'U0ADMIN01', team_id: TEAM, profile: { display_name: 'pat' } } }))
    expect(await completeSlackInstall(svc, { code: 'c', userId: USER, workspaceId: WS }, deps)).toBe('added')
    expect(deps.saveToken).toHaveBeenCalled()
    expect(store.bindInstallation).not.toHaveBeenCalled()
    expect(store.linkSlackUser).not.toHaveBeenCalled()
  })

  it('a team already live here is re-bound by any member of it, who is linked', async () => {
    store.getInstallation.mockResolvedValue({ slack_team_id: TEAM, workspace_id: WS, status: 'active' })
    const deps = makeDeps()
    deps.slack.userInfo = vi.fn(async () => ({ ok: true as const, user: { id: 'U0ADMIN01', team_id: TEAM, real_name: 'Pat Example' } }))
    expect(await completeSlackInstall(svc, { code: 'c', userId: USER, workspaceId: WS }, deps)).toBe('installed')
    expect(store.bindInstallation).toHaveBeenCalled()
    expect(store.linkSlackUser).toHaveBeenCalledWith(svc, expect.objectContaining({ slackUserId: 'U0ADMIN01', slackUserName: 'Pat Example' }))
  })

  it('a stranger, a bot or another team’s user never counts as the admin nor is linked', async () => {
    for (const user of [
      { id: 'U0ADMIN01', team_id: TEAM, is_admin: true, is_stranger: true },
      { id: 'U0ADMIN01', team_id: TEAM, is_admin: true, is_bot: true },
      { id: 'U0ADMIN01', team_id: 'T0OTHER01', is_admin: true },
    ]) {
      store.bindInstallation.mockClear()
      const deps = makeDeps()
      deps.slack.userInfo = vi.fn(async () => ({ ok: true as const, user }))
      expect(await completeSlackInstall(svc, { code: 'c', userId: USER, workspaceId: WS }, deps)).toBe('added')
      expect(store.bindInstallation).not.toHaveBeenCalled()
    }
    expect(store.linkSlackUser).not.toHaveBeenCalled()
  })

  it("never binds when the token's auth.test names another team", async () => {
    const deps = makeDeps()
    deps.slack.authTest = vi.fn(async () => ({ ok: true as const, team_id: 'T0OTHER01' }))
    expect(await completeSlackInstall(svc, { code: 'c', userId: USER, workspaceId: WS }, deps)).toBe('failed')
    expect(store.bindInstallation).not.toHaveBeenCalled()
  })

  it('a token that could not be stored binds nothing', async () => {
    const deps = makeDeps(answer(), { saveToken: vi.fn(async () => false) })
    expect(await completeSlackInstall(svc, { code: 'c', userId: USER, workspaceId: WS }, deps)).toBe('failed')
    expect(store.bindInstallation).not.toHaveBeenCalled()
  })

  it('never throws: a failed read is failed', async () => {
    store.memberRole.mockRejectedValue(new Error('db down'))
    expect(await completeSlackInstall(svc, { code: 'c', userId: USER, workspaceId: WS }, makeDeps())).toBe('failed')
  })
})
