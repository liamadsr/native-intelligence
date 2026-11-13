/**
 * The Slack intake's trust decisions:
 * who links, who binds a Slack team, and who gets only a reply.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  getInstallation: vi.fn(),
  linkForSlackUser: vi.fn(),
  redeemLinkCode: vi.fn(),
  memberRole: vi.fn(),
  bindInstallation: vi.fn(),
  linkSlackUser: vi.fn(),
  markInstallationRevoked: vi.fn(),
  linkAttemptsBlocked: vi.fn(),
  recordFailedLinkAttempt: vi.fn(),
}))

vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>()
  return { ...actual, ...store }
})

import { handleSlackInbound, SLACK_REPLIES, type SlackInboundDeps } from '../inbound'
import type { SlackInbound } from '../events'

const svc = {} as never
const TEAM = 'T111'
const WS = '11111111-1111-4111-8111-111111111111'
const OTHER_WS = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'

const dm = (text: string, over: Partial<Extract<SlackInbound, { kind: 'dm' }>> = {}): SlackInbound => ({
  kind: 'dm',
  eventId: 'Ev1',
  teamId: TEAM,
  userTeamId: TEAM,
  slackUserId: 'U222',
  channel: 'D333',
  ts: '1700000000.000100',
  text,
  ...over,
})

const liveInstall = (workspaceId = WS) => ({
  slack_team_id: TEAM,
  team_name: 'Acme',
  team_domain: 'acme',
  enterprise_id: null,
  workspace_id: workspaceId,
  installed_by_user_id: USER,
  bot_user_id: 'UBOT',
  status: 'active' as const,
  created_at: '2026-10-21T00:00:00Z',
})

function makeDeps(over: Partial<SlackInboundDeps> = {}) {
  const posts: Array<{ token: string; channel: string; text: string }> = []
  const whispers: Array<{ channel: string; user: string; text: string; thread_ts?: string }> = []
  const deps: SlackInboundDeps = {
    verifyInstallation: vi.fn(async () => ({ token: 'xoxb-new' })),
    botToken: vi.fn(async () => 'xoxb-live'),
    dropToken: vi.fn(async () => 'deleted' as const),
    slack: {
      authTest: vi.fn(async () => ({ ok: true as const, team_id: TEAM, team: 'Acme', user_id: 'UBOT' })),
      teamInfo: vi.fn(async () => ({ ok: true as const, team: { id: TEAM, name: 'Acme', domain: 'acme' } })),
      userInfo: vi.fn(async () => ({ ok: true as const, user: { id: 'U222', team_id: TEAM, is_admin: true, profile: { display_name: 'liam' } } })),
      post: vi.fn(async (token, message) => {
        posts.push({ token, channel: message.channel, text: message.text })
        return { ok: true as const, ts: '1.2' }
      }),
      ephemeral: vi.fn(async (_token, message) => {
        whispers.push(message)
        return { ok: true as const }
      }),
    },
    ...over,
  }
  return { deps, posts, whispers }
}

beforeEach(() => {
  for (const fn of Object.values(store)) fn.mockReset()
  store.linkSlackUser.mockResolvedValue(true)
  store.bindInstallation.mockResolvedValue({ ok: true, rebound: false })
  store.markInstallationRevoked.mockResolvedValue(true)
  store.linkAttemptsBlocked.mockResolvedValue(false)
  store.recordFailedLinkAttempt.mockResolvedValue(undefined)
})

describe('a link code', () => {
  it("from an admin binds a new Slack team to the code's workspace and links the sender", async () => {
    store.getInstallation.mockResolvedValueOnce(null).mockResolvedValue(liveInstall())
    store.redeemLinkCode.mockResolvedValue({ userId: USER, workspaceId: WS })
    store.memberRole.mockResolvedValue('admin')
    const { deps, posts } = makeDeps()

    expect(await handleSlackInbound(svc, dm('K7Q4-M3PX'), deps)).toBe('bound_and_linked')

    expect(deps.verifyInstallation).toHaveBeenCalledWith(TEAM)
    expect(store.bindInstallation).toHaveBeenCalledWith(svc, expect.objectContaining({ teamId: TEAM, workspaceId: WS, userId: USER, botUserId: 'UBOT', teamName: 'Acme' }))
    expect(store.linkSlackUser).toHaveBeenCalledWith(svc, { teamId: TEAM, slackUserId: 'U222', userId: USER, slackUserName: 'liam' })
    expect(posts).toEqual([{ token: 'xoxb-new', channel: 'D333', text: SLACK_REPLIES.boundAndLinked('Acme') }])
  })

  it('from a member links them in a team already bound to their workspace', async () => {
    store.getInstallation.mockResolvedValue(liveInstall())
    store.redeemLinkCode.mockResolvedValue({ userId: USER, workspaceId: WS })
    store.memberRole.mockResolvedValue('member')
    const { deps, posts } = makeDeps()

    expect(await handleSlackInbound(svc, dm('link k7q4m3px'), deps)).toBe('linked')
    expect(store.bindInstallation).not.toHaveBeenCalled()
    expect(deps.verifyInstallation).not.toHaveBeenCalled()
    expect(posts.at(-1)?.text).toBe(SLACK_REPLIES.linked())
  })

  it('from a member never binds a new team (only an admin connects one)', async () => {
    store.getInstallation.mockResolvedValue(null)
    store.redeemLinkCode.mockResolvedValue({ userId: USER, workspaceId: WS })
    store.memberRole.mockResolvedValue('member')
    const { deps, posts } = makeDeps()

    expect(await handleSlackInbound(svc, dm('K7Q4-M3PX'), deps)).toBe('code_rejected')
    expect(store.bindInstallation).not.toHaveBeenCalled()
    expect(store.linkSlackUser).not.toHaveBeenCalled()
    expect(posts.at(-1)?.text).toBe(SLACK_REPLIES.needsAdmin())
  })

  it('for one workspace never links in a team bound to another', async () => {
    store.getInstallation.mockResolvedValue(liveInstall(OTHER_WS))
    store.redeemLinkCode.mockResolvedValue({ userId: USER, workspaceId: WS })
    store.memberRole.mockResolvedValue('owner')
    const { deps, posts } = makeDeps()

    expect(await handleSlackInbound(svc, dm('K7Q4-M3PX'), deps)).toBe('code_rejected')
    expect(store.linkSlackUser).not.toHaveBeenCalled()
    expect(store.bindInstallation).not.toHaveBeenCalled()
    expect(posts.at(-1)?.text).toBe(SLACK_REPLIES.otherWorkspace())
  })

  it("never binds a team whose stored token is another team's", async () => {
    store.getInstallation.mockResolvedValue(null)
    store.redeemLinkCode.mockResolvedValue({ userId: USER, workspaceId: WS })
    store.memberRole.mockResolvedValue('owner')
    const { deps } = makeDeps()
    deps.slack.authTest = vi.fn(async () => ({ ok: true as const, team_id: 'T999', user_id: 'UBOT' }))

    expect(await handleSlackInbound(svc, dm('K7Q4-M3PX'), deps)).toBe('failed')
    expect(store.bindInstallation).not.toHaveBeenCalled()
    expect(store.linkSlackUser).not.toHaveBeenCalled()
  })

  it('never binds a team the app holds no token for', async () => {
    store.getInstallation.mockResolvedValue(null)
    store.redeemLinkCode.mockResolvedValue({ userId: USER, workspaceId: WS })
    store.memberRole.mockResolvedValue('owner')
    const { deps } = makeDeps({ verifyInstallation: vi.fn(async () => null) })

    expect(await handleSlackInbound(svc, dm('K7Q4-M3PX'), deps)).toBe('code_rejected')
    expect(store.bindInstallation).not.toHaveBeenCalled()
  })

  it('sent from a Slack Connect stranger links nothing and binds nothing', async () => {
    store.getInstallation.mockResolvedValue(null)
    store.redeemLinkCode.mockResolvedValue({ userId: USER, workspaceId: WS })
    store.memberRole.mockResolvedValue('owner')
    const { deps, posts } = makeDeps()
    deps.slack.userInfo = vi.fn(async () => ({ ok: true as const, user: { id: 'U222', team_id: TEAM, is_stranger: true } }))

    expect(await handleSlackInbound(svc, dm('K7Q4-M3PX'), deps)).toBe('outsider')
    expect(store.bindInstallation).not.toHaveBeenCalled()
    expect(store.linkSlackUser).not.toHaveBeenCalled()
    expect(posts.at(-1)?.text).toBe(SLACK_REPLIES.outsider())
  })

  it('that is unknown, used or expired is refused, and counted against the sender', async () => {
    store.getInstallation.mockResolvedValue(liveInstall())
    store.redeemLinkCode.mockResolvedValue(null)
    const { deps, posts } = makeDeps()

    expect(await handleSlackInbound(svc, dm('K7Q4-M3PX'), deps)).toBe('code_rejected')
    expect(store.linkSlackUser).not.toHaveBeenCalled()
    expect(store.recordFailedLinkAttempt).toHaveBeenCalledWith(svc, TEAM, 'U222')
    expect(posts.at(-1)?.text).toBe(SLACK_REPLIES.codeRejected())
  })

  it('past the guess cap is not even tried (nor spent)', async () => {
    store.getInstallation.mockResolvedValue(liveInstall())
    store.linkAttemptsBlocked.mockResolvedValue(true)
    const { deps, posts } = makeDeps()

    expect(await handleSlackInbound(svc, dm('K7Q4-M3PX'), deps)).toBe('code_rejected')
    expect(store.redeemLinkCode).not.toHaveBeenCalled()
    expect(posts.at(-1)?.text).toBe(SLACK_REPLIES.tooManyCodes())
  })

  it('from a Native Intelligence admin binds a new team only when the sender also runs the Slack workspace', async () => {
    store.getInstallation.mockResolvedValue(null)
    store.redeemLinkCode.mockResolvedValue({ userId: USER, workspaceId: WS })
    store.memberRole.mockResolvedValue('owner')
    const { deps, posts } = makeDeps()
    deps.slack.userInfo = vi.fn(async () => ({ ok: true as const, user: { id: 'U222', team_id: TEAM, profile: { display_name: 'sam' } } }))

    expect(await handleSlackInbound(svc, dm('K7Q4-M3PX'), deps)).toBe('code_rejected')
    expect(store.bindInstallation).not.toHaveBeenCalled()
    expect(store.linkSlackUser).not.toHaveBeenCalled()
    expect(posts.at(-1)?.text).toBe(SLACK_REPLIES.needsSlackAdmin())

    // A Slack owner may.
    deps.slack.userInfo = vi.fn(async () => ({ ok: true as const, user: { id: 'U222', team_id: TEAM, is_owner: true } }))
    store.getInstallation.mockResolvedValueOnce(null).mockResolvedValue(liveInstall())
    expect(await handleSlackInbound(svc, dm('K7Q4-M3PX'), deps)).toBe('bound_and_linked')
  })

  it('from a member links a Slack member who is no Slack admin, in a team already bound', async () => {
    store.getInstallation.mockResolvedValue(liveInstall())
    store.redeemLinkCode.mockResolvedValue({ userId: USER, workspaceId: WS })
    store.memberRole.mockResolvedValue('member')
    const { deps } = makeDeps()
    deps.slack.userInfo = vi.fn(async () => ({ ok: true as const, user: { id: 'U222', team_id: TEAM } }))
    expect(await handleSlackInbound(svc, dm('K7Q4-M3PX'), deps)).toBe('linked')
  })

  it("from a guest (or someone no longer a member) links nothing", async () => {
    store.getInstallation.mockResolvedValue(liveInstall())
    store.redeemLinkCode.mockResolvedValue({ userId: USER, workspaceId: WS })
    for (const role of ['guest', null]) {
      store.memberRole.mockResolvedValueOnce(role)
      const { deps } = makeDeps()
      expect(await handleSlackInbound(svc, dm('K7Q4-M3PX'), deps)).toBe('code_rejected')
    }
    expect(store.linkSlackUser).not.toHaveBeenCalled()
  })
})

describe('any other DM', () => {
  it('from a Slack Connect outsider gets one reply and is never looked up', async () => {
    store.getInstallation.mockResolvedValue(liveInstall())
    const { deps, posts } = makeDeps()

    expect(await handleSlackInbound(svc, dm('K7Q4-M3PX', { userTeamId: 'T999' }), deps)).toBe('outsider')
    expect(store.redeemLinkCode).not.toHaveBeenCalled()
    expect(store.linkForSlackUser).not.toHaveBeenCalled()
    expect(posts.map((p) => p.text)).toEqual([SLACK_REPLIES.outsider()])
  })

  it('from an unlinked person gets how to link, and nothing runs', async () => {
    store.getInstallation.mockResolvedValue(liveInstall())
    store.linkForSlackUser.mockResolvedValue(null)
    const onPersonDm = vi.fn()
    const { deps, posts } = makeDeps({ onPersonDm })

    expect(await handleSlackInbound(svc, dm('what is on my calendar'), deps)).toBe('unknown_sender')
    expect(onPersonDm).not.toHaveBeenCalled()
    expect(posts.map((p) => p.text)).toEqual([SLACK_REPLIES.unknownSender()])
  })

  it("from an unlinked member goes to the guests' intake first; only what isn't a guest's gets how to link", async () => {
    store.getInstallation.mockResolvedValue(liveInstall())
    store.linkForSlackUser.mockResolvedValue(null)
    const onUnlinkedDm = vi.fn(async () => true)
    const guest = makeDeps({ onUnlinkedDm })
    expect(await handleSlackInbound(svc, dm('hi, can you find a time on Tuesday?'), guest.deps)).toBe('guest_dm')
    expect(onUnlinkedDm).toHaveBeenCalledWith({ dm: dm('hi, can you find a time on Tuesday?'), installation: liveInstall(), token: 'xoxb-live' })
    expect(guest.posts).toEqual([])

    const notGuest = makeDeps({ onUnlinkedDm: vi.fn(async () => false) })
    expect(await handleSlackInbound(svc, dm('what is on my calendar'), notGuest.deps)).toBe('unknown_sender')
    expect(notGuest.posts.map((p) => p.text)).toEqual([SLACK_REPLIES.unknownSender()])
  })

  it("a linked person, an outsider or an unbound team never reaches the guests' intake", async () => {
    const onUnlinkedDm = vi.fn(async () => true)
    store.getInstallation.mockResolvedValue(liveInstall())
    store.linkForSlackUser.mockResolvedValue({ slack_team_id: TEAM, slack_user_id: 'U222', user_id: USER })
    expect(await handleSlackInbound(svc, dm('hello'), makeDeps({ onUnlinkedDm, onPersonDm: vi.fn() }).deps)).toBe('person_dm')
    expect(await handleSlackInbound(svc, dm('hello', { userTeamId: 'T999' }), makeDeps({ onUnlinkedDm }).deps)).toBe('outsider')
    store.getInstallation.mockResolvedValue(null)
    expect(await handleSlackInbound(svc, dm('hello'), makeDeps({ onUnlinkedDm }).deps)).toBe('unbound_team')
    expect(onUnlinkedDm).not.toHaveBeenCalled()
  })

  it('in a team bound to no workspace says how to connect it', async () => {
    store.getInstallation.mockResolvedValue(null)
    const { deps, posts } = makeDeps()

    expect(await handleSlackInbound(svc, dm('hi'), deps)).toBe('unbound_team')
    expect(posts.map((p) => p.text)).toEqual([SLACK_REPLIES.unboundTeam()])
  })

  it('from a linked person is theirs (handed on with their link)', async () => {
    const installation = liveInstall()
    store.getInstallation.mockResolvedValue(installation)
    const link = { slack_team_id: TEAM, slack_user_id: 'U222', user_id: USER, slack_user_name: 'liam', linked_at: 'x' }
    store.linkForSlackUser.mockResolvedValue(link)
    const onPersonDm = vi.fn(async () => {})
    const { deps, posts } = makeDeps({ onPersonDm })

    expect(await handleSlackInbound(svc, dm('what is on my calendar'), deps)).toBe('person_dm')
    expect(onPersonDm).toHaveBeenCalledWith(expect.objectContaining({ installation, link, token: 'xoxb-live' }))
    expect(posts).toEqual([])
  })

  it("from the bot's own user is skipped", async () => {
    store.getInstallation.mockResolvedValue(liveInstall())
    const { deps, posts } = makeDeps()
    expect(await handleSlackInbound(svc, dm('hi', { slackUserId: 'UBOT' }), deps)).toBe('ignored')
    expect(posts).toEqual([])
  })
})

describe('an uninstall', () => {
  const removal = (reason: 'app_uninstalled' | 'tokens_revoked', eventTime: number | null = null): SlackInbound => ({ kind: 'uninstalled', eventId: 'Ev2', teamId: TEAM, reason, eventTime })

  it('app_uninstalled deletes the stored token and marks the installation revoked', async () => {
    const { deps } = makeDeps()
    expect(await handleSlackInbound(svc, removal('app_uninstalled'), deps)).toBe('uninstalled')
    expect(deps.dropToken).toHaveBeenCalledWith(TEAM, { installedBefore: undefined })
    expect(store.markInstallationRevoked).toHaveBeenCalledWith(svc, TEAM)
    expect(deps.verifyInstallation).not.toHaveBeenCalled()
  })

  it('spares an install made after the event: neither its token nor the installation is touched', async () => {
    const { deps } = makeDeps({ dropToken: vi.fn(async () => 'newer' as const) })
    const at = Date.UTC(2026, 10, 13, 12, 0, 0)
    expect(await handleSlackInbound(svc, removal('app_uninstalled', at), deps)).toBe('still_installed')
    expect(deps.dropToken).toHaveBeenCalledWith(TEAM, { installedBefore: new Date(at).toISOString() })
    expect(store.markInstallationRevoked).not.toHaveBeenCalled()
  })

  it('tokens_revoked with a working token (rotation retiring an old one) is ignored', async () => {
    const { deps } = makeDeps()
    expect(await handleSlackInbound(svc, removal('tokens_revoked'), deps)).toBe('still_installed')
    expect(deps.verifyInstallation).toHaveBeenCalledWith(TEAM)
    expect(deps.dropToken).not.toHaveBeenCalled()
    expect(store.markInstallationRevoked).not.toHaveBeenCalled()
  })

  it('tokens_revoked when the app has no working token removes it', async () => {
    const { deps } = makeDeps({ verifyInstallation: vi.fn(async () => null) })
    expect(await handleSlackInbound(svc, removal('tokens_revoked'), deps)).toBe('uninstalled')
    expect(deps.dropToken).toHaveBeenCalled()
    expect(store.markInstallationRevoked).toHaveBeenCalledWith(svc, TEAM)
  })

  it('tokens_revoked when Slack cannot be asked changes nothing', async () => {
    const { deps } = makeDeps({ verifyInstallation: vi.fn(async () => Promise.reject(new Error('slack down'))) })
    expect(await handleSlackInbound(svc, removal('tokens_revoked'), deps)).toBe('failed')
    expect(deps.dropToken).not.toHaveBeenCalled()
    expect(store.markInstallationRevoked).not.toHaveBeenCalled()
  })

  it('still marks the installation revoked when the token could not be deleted (logged)', async () => {
    const { deps } = makeDeps({ dropToken: vi.fn(async () => 'failed' as const) })
    expect(await handleSlackInbound(svc, removal('app_uninstalled'), deps)).toBe('uninstalled')
    expect(store.markInstallationRevoked).toHaveBeenCalled()
  })
})

describe('an @mention in a channel thread (piece d)', () => {
  const mention = (over: Partial<Extract<SlackInbound, { kind: 'mention' }>> = {}): SlackInbound => ({
    kind: 'mention',
    eventId: 'Ev9',
    teamId: TEAM,
    userTeamId: TEAM,
    slackUserId: 'U222',
    channel: 'C444',
    ts: '1700000005.000100',
    threadTs: '1700000000.000001',
    text: '<@UBOT> what did we decide?',
    sharedExternally: false,
    ...over,
  })

  it('from a linked person is theirs: handed on with their own link, nothing posted', async () => {
    const installation = liveInstall()
    store.getInstallation.mockResolvedValue(installation)
    const link = { slack_team_id: TEAM, slack_user_id: 'U222', user_id: USER, slack_user_name: 'liam', linked_at: 'x' }
    store.linkForSlackUser.mockResolvedValue(link)
    const onPersonMention = vi.fn(async () => {})
    const { deps, posts, whispers } = makeDeps({ onPersonMention })

    expect(await handleSlackInbound(svc, mention(), deps)).toBe('person_mention')
    expect(store.linkForSlackUser).toHaveBeenCalledWith(svc, TEAM, 'U222')
    expect(onPersonMention).toHaveBeenCalledWith({ mention: mention(), installation, link })
    expect(posts).toEqual([])
    expect(whispers).toEqual([])
  })

  it('a teammate’s mention in the same thread is handed on as THEIR own (never the first person’s)', async () => {
    store.getInstallation.mockResolvedValue(liveInstall())
    const other = { slack_team_id: TEAM, slack_user_id: 'U777', user_id: 'other-user', slack_user_name: 'ana', linked_at: 'x' }
    store.linkForSlackUser.mockResolvedValue(other)
    const onPersonMention = vi.fn<NonNullable<SlackInboundDeps['onPersonMention']>>(async () => {})
    const { deps } = makeDeps({ onPersonMention })
    await handleSlackInbound(svc, mention({ slackUserId: 'U777' }), deps)
    expect(onPersonMention.mock.calls[0]?.[0].link).toBe(other)
  })

  it('anyone else gets one line only they see, in the thread, and nothing runs', async () => {
    const onPersonMention = vi.fn()
    // Unlinked.
    store.getInstallation.mockResolvedValue(liveInstall())
    store.linkForSlackUser.mockResolvedValue(null)
    let fx = makeDeps({ onPersonMention })
    expect(await handleSlackInbound(svc, mention(), fx.deps)).toBe('unknown_sender')
    expect(fx.whispers).toEqual([{ channel: 'C444', user: 'U222', text: SLACK_REPLIES.unknownSender(), thread_ts: '1700000000.000001' }])
    expect(fx.posts).toEqual([])
    // A Slack Connect outsider.
    fx = makeDeps({ onPersonMention })
    expect(await handleSlackInbound(svc, mention({ userTeamId: 'T999' }), fx.deps)).toBe('outsider')
    expect(fx.whispers.map((w) => w.text)).toEqual([SLACK_REPLIES.outsider()])
    // A team bound to no workspace.
    store.getInstallation.mockResolvedValue(null)
    fx = makeDeps({ onPersonMention })
    expect(await handleSlackInbound(svc, mention(), fx.deps)).toBe('unbound_team')
    expect(fx.whispers.map((w) => w.text)).toEqual([SLACK_REPLIES.unboundTeam()])
    expect(onPersonMention).not.toHaveBeenCalled()
  })

  it('never answers in a channel shared with another company', async () => {
    store.getInstallation.mockResolvedValue(liveInstall())
    store.linkForSlackUser.mockResolvedValue({ slack_team_id: TEAM, slack_user_id: 'U222', user_id: USER, slack_user_name: 'liam', linked_at: 'x' })
    const onPersonMention = vi.fn()
    const { deps, whispers } = makeDeps({ onPersonMention })
    expect(await handleSlackInbound(svc, mention({ sharedExternally: true }), deps)).toBe('shared_channel')
    expect(onPersonMention).not.toHaveBeenCalled()
    expect(whispers.map((w) => w.text)).toEqual([SLACK_REPLIES.sharedChannel()])
  })

  it('never reads a link code from a channel (it is public)', async () => {
    store.getInstallation.mockResolvedValue(liveInstall())
    store.linkForSlackUser.mockResolvedValue(null)
    const { deps } = makeDeps()
    await handleSlackInbound(svc, mention({ text: '<@UBOT> K7Q4-M3PX' }), deps)
    expect(store.redeemLinkCode).not.toHaveBeenCalled()
  })
})
