/**
 * A guest on Slack (src/lib/guests/slack.ts): a bound guest's DM goes to
 * their own agent (with a daily cap), the right invite code from a real
 * member of the team binds their Slack account, wrong codes count toward the
 * guess cap, and anything else is not a guest's (null). Their Slack turn and
 * the owner's agent's answers go back to their own DM, never anyone else's.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  GUEST_SLACK_DAILY_CAP,
  GUEST_SLACK_REPLIES,
  bindGuestSlack,
  deliverGuestSlackDm,
  findActiveGuestBySlack,
  guestSlackTarget,
  handleGuestSlackDm,
  messageGuest,
  type GuestSlackDeps,
} from '../slack'
import { hashInviteCode, type AgentGuest } from '../store'
import { fakeSupabase, type FakeQuery } from './fake-supabase'

vi.mock('@/lib/chat/eve-message-writer', () => ({ persistEveMessage: vi.fn(async () => ({ written: true })) }))
vi.mock('../activity', () => ({ recordGuestActivity: vi.fn(async () => {}) }))
vi.mock('../texting', async (orig) => {
  const real = await orig<typeof import('../texting')>()
  return { ...real, ensureGuestThread: vi.fn(async () => ({ id: 'conv-g' })) }
})
vi.mock('@/lib/slack/store', () => ({
  getInstallation: vi.fn(async (_s: unknown, teamId: string) =>
    teamId === 'T1' ? { status: 'active', workspace_id: 'ws-1', connect_installation_id: 'inst-1', bot_user_id: 'UBOT' } : null,
  ),
}))

const KEY = 'test-key'
const NOW = Date.parse('2026-10-25T02:00:00.000Z')
const GID = '11111111-1111-4111-8111-111111111111'
const WHO = { teamId: 'T1', slackUserId: 'U1', workspaceId: 'ws-1' }

function guest(over: Partial<AgentGuest> = {}): AgentGuest {
  return {
    id: GID,
    ownerUserId: 'owner-1',
    workspaceId: 'ws-1',
    displayName: 'Sam',
    phone: null,
    channels: ['slack'],
    phoneBoundAt: null,
    slackTeamId: null,
    slackUserId: null,
    peerUserId: null,
    peerBoundAt: null,
    calendarEmails: [],
    businessNumberId: null,
    contactId: null,
    preset: 'colleague',
    tools: ['get_free_busy', 'message_owner', 'ask_owner_agent'],
    askTools: [],
    askBefore: ['payments', 'deletes', 'changes'],
    notes: null,
    state: 'invited',
    inviteExpiresAt: '2026-10-30T00:00:00.000Z',
    requestedAt: null,
    activatedAt: null,
    removedAt: null,
    optedOut: false,
    lastInboundAt: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    ...over,
  }
}

function fakeDeps(over: Partial<GuestSlackDeps> & { active?: AgentGuest | null; invites?: Array<{ guest: AgentGuest; inviteHash: string }>; today?: number } = {}) {
  const replies: string[] = []
  const delivered: AgentGuest[] = []
  const binds: Array<{ target: AgentGuest; binding: { teamId: string; slackUserId: string } }> = []
  let failed = 0
  const deps: GuestSlackDeps = {
    findActive: async () => over.active ?? null,
    findInvites: async () => over.invites ?? [],
    bind: async (target, binding) => {
      binds.push({ target, binding })
      return { ok: true, guest: { ...target, state: 'active', slackTeamId: binding.teamId, slackUserId: binding.slackUserId } }
    },
    sender: async () => ({ ok: true, user: { id: 'U1', team_id: 'T1' } }),
    attemptsBlocked: async () => false,
    recordFailedAttempt: async () => {
      failed++
    },
    countToday: async () => over.today ?? 0,
    ownerName: async () => 'Liam',
    reply: async (text) => {
      replies.push(text)
    },
    deliver: async (g) => {
      delivered.push(g)
    },
    inviteKey: KEY,
    ...over,
  }
  return { deps, replies, delivered, binds, failed: () => failed }
}

const input = (text: string) => ({ ...WHO, text })

describe('a DM from an unlinked member, as a guest’s', () => {
  it('a bound guest’s message goes to their own agent', async () => {
    const active = guest({ state: 'active', slackTeamId: 'T1', slackUserId: 'U1' })
    const f = fakeDeps({ active })
    expect(await handleGuestSlackDm(input('can you find me a time on Tuesday?'), f.deps, NOW)).toBe('guest_queued')
    expect(f.delivered).toEqual([active])
    expect(f.replies).toEqual([])
  })

  it('past their daily cap, a notice and nothing delivered', async () => {
    const f = fakeDeps({ active: guest({ state: 'active' }), today: GUEST_SLACK_DAILY_CAP })
    expect(await handleGuestSlackDm(input('hello again'), f.deps, NOW)).toBe('guest_limited')
    expect(f.delivered).toEqual([])
    expect(f.replies).toEqual([GUEST_SLACK_REPLIES.limited('Liam')])
  })

  it('the right invite code from a member of the team binds them and says who they are talking to', async () => {
    const invited = guest()
    const f = fakeDeps({ invites: [{ guest: invited, inviteHash: hashInviteCode('K7Q4MX', { guestId: GID, phone: '' }, KEY) }] })
    expect(await handleGuestSlackDm(input("Hi, it's Sam · K7Q4MX"), f.deps, NOW)).toBe('guest_welcomed')
    expect(f.binds).toEqual([{ target: invited, binding: { teamId: 'T1', slackUserId: 'U1' } }])
    expect(f.replies).toEqual([GUEST_SLACK_REPLIES.welcome('Liam')])
  })

  it('a guest with a number too checks the code against their number', async () => {
    const invited = guest({ phone: '+15551234567', channels: ['sms', 'slack'] })
    const hash = hashInviteCode('K7Q4MX', { guestId: GID, phone: '+15551234567' }, KEY)
    expect(await handleGuestSlackDm(input('K7Q4MX'), fakeDeps({ invites: [{ guest: invited, inviteHash: hash }] }).deps, NOW)).toBe('guest_welcomed')
    // The same code hashed without the number is someone else's.
    const other = hashInviteCode('K7Q4MX', { guestId: GID, phone: '' }, KEY)
    const f = fakeDeps({ invites: [{ guest: invited, inviteHash: other }] })
    expect(await handleGuestSlackDm(input('K7Q4MX'), f.deps, NOW)).toBeNull()
    expect(f.failed()).toBe(1)
  })

  it('a wrong code counts toward the guess cap and falls through; past the cap, nothing is tried', async () => {
    const f = fakeDeps({ invites: [{ guest: guest(), inviteHash: hashInviteCode('K7Q4MX', { guestId: GID, phone: '' }, KEY) }] })
    expect(await handleGuestSlackDm(input('AAAAAA'), f.deps, NOW)).toBeNull()
    expect(f.failed()).toBe(1)
    expect(f.binds).toEqual([])
    const findInvites = vi.fn(async () => [])
    const blocked = fakeDeps({ attemptsBlocked: async () => true, findInvites })
    expect(await handleGuestSlackDm(input('K7Q4MX'), blocked.deps, NOW)).toBe('guest_code_blocked')
    expect(findInvites).not.toHaveBeenCalled()
    expect(blocked.replies).toEqual([GUEST_SLACK_REPLIES.tooManyCodes()])
  })

  it('a bot, a deactivated account or a stranger never binds', async () => {
    const invites = [{ guest: guest(), inviteHash: hashInviteCode('K7Q4MX', { guestId: GID, phone: '' }, KEY) }]
    for (const user of [{ is_bot: true }, { deleted: true }, { is_stranger: true }, { team_id: 'T9' }]) {
      const f = fakeDeps({ invites, sender: async () => ({ ok: true, user }) })
      expect(await handleGuestSlackDm(input('K7Q4MX'), f.deps, NOW), JSON.stringify(user)).toBe('guest_not_member')
      expect(f.binds).toEqual([])
    }
    const failed = fakeDeps({ invites, sender: async () => ({ ok: false, error: 'user_not_found' }) })
    expect(await handleGuestSlackDm(input('K7Q4MX'), failed.deps, NOW)).toBe('guest_not_member')
  })

  it('a Slack account already bound to another guest is told so', async () => {
    const f = fakeDeps({
      invites: [{ guest: guest(), inviteHash: hashInviteCode('K7Q4MX', { guestId: GID, phone: '' }, KEY) }],
      bind: async () => ({ ok: false, reason: 'conflict' }),
    })
    expect(await handleGuestSlackDm(input('K7Q4MX'), f.deps, NOW)).toBe('guest_conflict')
    expect(f.replies).toEqual([GUEST_SLACK_REPLIES.conflict()])
  })

  it('an ordinary message, or no invite key, is not a guest’s', async () => {
    expect(await handleGuestSlackDm(input('hey, who are you?'), fakeDeps().deps, NOW)).toBeNull()
    const noKey = fakeDeps({ inviteKey: null, invites: [{ guest: guest(), inviteHash: 'x' }] })
    expect(await handleGuestSlackDm(input('K7Q4MX'), noKey.deps, NOW)).toBeNull()
  })
})

describe('the store', () => {
  const row = { id: GID, owner_user_id: 'owner-1', workspace_id: 'ws-1', display_name: 'Sam', phone_e164: null, channels: ['slack'], state: 'active', preset: 'colleague', tools: [], ask_before: [], created_at: 'x' }
  const filters = (q: FakeQuery) => Object.fromEntries(q.filters.map(([k, c, v]) => [`${k}:${c}`, v]))

  it('finds a bound guest only in the installation’s workspace, active, with Slack among their channels', async () => {
    const f = fakeSupabase(() => ({ data: row }))
    expect((await findActiveGuestBySlack(f.supabase as never, WHO))?.id).toBe(GID)
    expect(filters(f.queries[0])).toMatchObject({ 'eq:slack_team_id': 'T1', 'eq:slack_user_id': 'U1', 'eq:workspace_id': 'ws-1', 'eq:state': 'active', 'contains:channels': ['slack'] })
    // A row whose channels no longer hold Slack is not theirs on Slack.
    expect(await findActiveGuestBySlack(fakeSupabase(() => ({ data: { ...row, channels: ['sms'] } })).supabase as never, WHO)).toBeNull()
  })

  it('binding spends the code unless their number is still owed a binding', async () => {
    const f = fakeSupabase(() => ({ data: row }))
    await bindGuestSlack(f.supabase as never, guest(), { teamId: 'T1', slackUserId: 'U1' }, NOW)
    expect(f.queries[0].values).toMatchObject({ slack_team_id: 'T1', slack_user_id: 'U1', state: 'active', activated_at: new Date(NOW).toISOString(), invite_code_hash: null })
    expect(filters(f.queries[0])).toMatchObject({ 'eq:state': 'invited', 'is:slack_user_id': null, 'eq:owner_user_id': 'owner-1' })

    const both = fakeSupabase(() => ({ data: row }))
    await bindGuestSlack(both.supabase as never, guest({ phone: '+15551234567', channels: ['sms', 'slack'] }), { teamId: 'T1', slackUserId: 'U1' }, NOW)
    expect(both.queries[0].values).not.toHaveProperty('invite_code_hash')

    // Already active by text: no new activated_at, and the code is spent.
    const texted = fakeSupabase(() => ({ data: row }))
    await bindGuestSlack(texted.supabase as never, guest({ state: 'active', phone: '+15551234567', channels: ['sms', 'slack'], phoneBoundAt: 'x' }), { teamId: 'T1', slackUserId: 'U1' }, NOW)
    expect(texted.queries[0].values).not.toHaveProperty('activated_at')
    expect(texted.queries[0].values).toMatchObject({ invite_code_hash: null })
  })

  it('a unique clash is a conflict; nothing updated is gone', async () => {
    expect(await bindGuestSlack(fakeSupabase(() => ({ error: { message: 'dup', code: '23505' } })).supabase as never, guest(), { teamId: 'T1', slackUserId: 'U1' })).toEqual({ ok: false, reason: 'conflict' })
    expect(await bindGuestSlack(fakeSupabase(() => ({ data: null })).supabase as never, guest(), { teamId: 'T1', slackUserId: 'U1' })).toEqual({ ok: false, reason: 'gone' })
  })
})

describe('the guest’s Slack turn and answers', () => {
  it('delivers their DM into their thread and requests a Slack turn carrying their guestId', async () => {
    const send = vi.fn(async () => ({}))
    const react = vi.fn(async () => ({ ok: true as const }))
    const dm = { kind: 'dm' as const, eventId: 'Ev1', teamId: 'T1', userTeamId: 'T1', slackUserId: 'U1', channel: 'D1', ts: '1729822800.000100', text: 'hi <@UBOT> can you help?' }
    const g = guest({ state: 'active' })
    expect(await deliverGuestSlackDm({} as never, { guest: g, dm: dm as never, installation: { bot_user_id: 'UBOT' } }, { react }, { send })).toEqual({ conversationId: 'conv-g' })
    expect(react).toHaveBeenCalledWith('D1', dm.ts, 'eyes')
    expect(send).toHaveBeenCalledWith({
      name: 'slack/turn.requested',
      id: `slack-turn-slack-in:T1:D1:${dm.ts}`,
      data: { conversationId: 'conv-g', userId: 'owner-1', workspaceId: 'ws-1', workItemIds: [], reason: 'slack', guestId: GID },
    })
  })

  it('answers only an active guest of this owner, bound in a live team of the same workspace', async () => {
    const bound = { id: GID, owner_user_id: 'owner-1', workspace_id: 'ws-1', display_name: 'Sam', channels: ['slack'], slack_team_id: 'T1', slack_user_id: 'U1', state: 'active', preset: 'colleague', tools: [], ask_before: [], created_at: 'x' }
    const scope = { guestId: GID, ownerUserId: 'owner-1', workspaceId: 'ws-1' }
    expect(await guestSlackTarget(fakeSupabase(() => ({ data: bound })).supabase as never, scope)).toEqual({ teamId: 'T1', slackUserId: 'U1', installationId: 'inst-1' })
    expect(await guestSlackTarget(fakeSupabase(() => ({ data: { ...bound, channels: ['sms'] } })).supabase as never, scope)).toBeNull()
    expect(await guestSlackTarget(fakeSupabase(() => ({ data: { ...bound, slack_team_id: 'T9' } })).supabase as never, scope)).toBeNull()
    expect(await guestSlackTarget(fakeSupabase(() => ({ data: { ...bound, workspace_id: 'ws-2' } })).supabase as never, { ...scope, workspaceId: 'ws-2' })).toBeNull()
  })

  it('an answer goes on the channel they last messaged on', async () => {
    const bound = { id: GID, owner_user_id: 'owner-1', workspace_id: 'ws-1', display_name: 'Sam', channels: ['sms', 'slack'], slack_team_id: 'T1', slack_user_id: 'U1', state: 'active', preset: 'colleague', tools: [], ask_before: [], created_at: 'x' }
    const lastWas = (id: string) =>
      fakeSupabase((q) => (q.table === 'chat_messages' ? { data: { ui_message_id: id } } : { data: bound })).supabase as never
    const args = { guestId: GID, ownerUserId: 'owner-1', workspaceId: 'ws-1', conversationId: 'conv-g', body: 'Tuesday at 3 works.', kind: 'guest_reply' as const }

    const text = vi.fn(async () => ({ sent: true as const, sid: 'SM1' }))
    const slack = vi.fn(async () => ({ sent: true as const }))
    expect(await messageGuest(lastWas('slack-in:T1:D1:1.2'), args, { text, slack })).toEqual({ sent: true, channel: 'slack' })
    expect(slack).toHaveBeenCalledWith({ teamId: 'T1', slackUserId: 'U1', installationId: 'inst-1' }, args.body)
    expect(text).not.toHaveBeenCalled()

    slack.mockClear()
    expect(await messageGuest(lastWas('sms-in:SM9'), args, { text, slack })).toEqual({ sent: true, channel: 'sms' })
    expect(slack).not.toHaveBeenCalled()

    // Last on Slack and Slack fails: told so, never a surprise text.
    const down = vi.fn(async () => ({ sent: false as const, reason: 'no_dm' }))
    text.mockClear()
    expect(await messageGuest(lastWas('slack-in:T1:D1:1.2'), args, { text, slack: down })).toEqual({ sent: false, reason: 'no_dm' })
    expect(text).not.toHaveBeenCalled()

    // An answer that was only an HTML comment: nothing to post, and the DM isn't even opened.
    const openSlackDm = vi.fn(async () => 'D1')
    const post = vi.fn(async () => ({ ok: true as const }))
    vi.doMock('@/lib/slack/deps', () => ({ openSlackDm, slackTurnSlack: () => ({ post }) }))
    try {
      const onlyComment = { ...args, body: '<!-- card:4 -->' }
      expect(await messageGuest(lastWas('slack-in:T1:D1:1.2'), onlyComment, { text })).toEqual({ sent: false, reason: 'empty' })
      expect(openSlackDm).not.toHaveBeenCalled()
      expect(post).not.toHaveBeenCalled()
    } finally {
      vi.doUnmock('@/lib/slack/deps')
    }
  })
})
