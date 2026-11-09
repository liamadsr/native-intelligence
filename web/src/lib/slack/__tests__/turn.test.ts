/**
 * A Slack DM as a home-thread turn (src/lib/slack/turn.ts): what the intake
 * writes and requests, and how the reply goes back (once, from the stored
 * reply, never twice).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  ensureHomeThread: vi.fn(),
  persistEveMessage: vi.fn(),
  memberRole: vi.fn(),
  getInstallation: vi.fn(),
  linksForUser: vi.fn(),
  ensureSlackThread: vi.fn(),
  noteThreadMention: vi.fn(),
  threadForConversation: vi.fn(),
  finish: vi.fn(),
  guestSlackTarget: vi.fn(),
  approvalsRaisedSince: vi.fn(),
}))
vi.mock('@/lib/guests/slack', () => ({ guestSlackTarget: m.guestSlackTarget }))
vi.mock('../approvals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../approvals')>()),
  approvalsRaisedSince: m.approvalsRaisedSince,
}))
vi.mock('@/lib/reach/notice', () => ({ claimReachNotice: vi.fn(async () => 'claimed') }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/chat/home-thread', () => ({ ensureHomeThread: m.ensureHomeThread }))
vi.mock('@/lib/chat/eve-message-writer', () => ({ persistEveMessage: m.persistEveMessage }))
vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  memberRole: m.memberRole,
  getInstallation: m.getInstallation,
  linksForUser: m.linksForUser,
  ensureSlackThread: m.ensureSlackThread,
  noteThreadMention: m.noteThreadMention,
  threadForConversation: m.threadForConversation,
}))

import {
  GUEST_SLACK_TURN_NOTICES,
  SLACK_TURN_NOTICES,
  WORKING_REACTION,
  guestSlackTurnSkipNotice,
  deliverSlackDm,
  deliverSlackMention,
  noticeToPerson,
  hydrateChannelPlan,
  postSlackTurnReply,
  redactChannelPlan,
  replyOrigin,
  settleSlackTurn,
  type SlackOrigin,
  type SlackTurnSlack,
} from '../turn'
import type { HomeTurnPlan, HomeTurnReadResult } from '@/lib/chat/home-turn-server'

const TEAM = 'T111'
const WS = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const CONV = '33333333-3333-4333-8333-333333333333'

const installation = {
  slack_team_id: TEAM,
  team_name: 'Acme',
  team_domain: 'acme',
  enterprise_id: null,
  workspace_id: WS,
  installed_by_user_id: USER,
  connect_installation_id: TEAM,
  bot_user_id: 'UBOT',
  status: 'active' as const,
  created_at: 'x',
}
const link = { slack_team_id: TEAM, slack_user_id: 'U222', user_id: USER, slack_user_name: 'liam', linked_at: 'x' }
const dm = {
  kind: 'dm' as const,
  eventId: 'Ev1',
  teamId: TEAM,
  userTeamId: TEAM,
  slackUserId: 'U222',
  channel: 'D333',
  ts: '1700000000.000100',
  text: '<@UBOT> what is on my calendar &amp; tomorrow?',
}
const origin: SlackOrigin = { team_id: TEAM, channel_id: 'D333', ts: '1700000000.000100', installation_id: TEAM }

function fakeSlack() {
  const calls: Array<[string, ...unknown[]]> = []
  const slack: SlackTurnSlack = {
    post: vi.fn(async (message) => (calls.push(['post', message.channel, message.text, ...(message.thread_ts ? [message.thread_ts] : [])]), { ok: true as const, ts: '9.9' })),
    ephemeral: vi.fn(async (message) => (calls.push(['ephemeral', message.channel, message.user, message.text]), { ok: true as const })),
    react: vi.fn(async (channel, ts, name) => (calls.push(['react', channel, ts, name]), { ok: true as const })),
    unreact: vi.fn(async (channel, ts, name) => (calls.push(['unreact', channel, ts, name]), { ok: true as const })),
  }
  return { slack, calls }
}

/** A tiny database: chat_messages rows by ui_message id, and home_turn rows by id. */
function fakeDb(seed: { messages?: Array<{ id: string; parts?: unknown[]; metadata?: unknown }>; turns?: Array<{ id: string; reply_sent_at: string | null }> }) {
  const messages = (seed.messages ?? []).map((x) => ({ conversation_id: CONV, user_id: USER, ui_message: { id: x.id, parts: x.parts ?? [], metadata: x.metadata ?? {} } }))
  const turns = (seed.turns ?? []).map((t) => ({ ...t }))
  const from = (table: string) => {
    const filters: Array<(r: Record<string, unknown>) => boolean> = []
    let patch: Record<string, unknown> | null = null
    const field = (r: Record<string, unknown>, col: string) => (col === 'ui_message->>id' ? (r.ui_message as { id: string }).id : r[col])
    const rows = () => (table === 'home_turn' ? turns : messages) as Array<Record<string, unknown>>
    const run = async () => {
      const hit = rows().filter((r) => filters.every((f) => f(r)))
      if (patch) for (const r of hit) Object.assign(r, patch)
      return { data: hit, error: null }
    }
    const q: Record<string, unknown> = {
      select: () => q,
      update: (p: Record<string, unknown>) => ((patch = p), q),
      eq: (col: string, v: unknown) => (filters.push((r) => field(r, col) === v), q),
      in: (col: string, vs: unknown[]) => (filters.push((r) => vs.includes(field(r, col))), q),
      is: (col: string, v: unknown) => (filters.push((r) => (r[col] ?? null) === v), q),
      maybeSingle: async () => ({ data: (await run()).data[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
    }
    return q
  }
  return { client: { from } as never, turns }
}

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset()
  m.ensureHomeThread.mockResolvedValue({ id: CONV, eveSessionId: null, created: false })
  m.persistEveMessage.mockResolvedValue({ written: true })
  m.memberRole.mockResolvedValue('member')
  m.threadForConversation.mockResolvedValue(null)
  m.noteThreadMention.mockResolvedValue(undefined)
})

describe('deliverSlackDm', () => {
  it('writes the person’s words into their home thread as their message, marks it, and requests one turn', async () => {
    const { slack, calls } = fakeSlack()
    const send = vi.fn(async () => undefined)
    expect(await deliverSlackDm({} as never, { dm, installation, link }, slack, { send })).toBe('queued')

    expect(m.ensureHomeThread).toHaveBeenCalledWith(expect.anything(), { userId: USER, workspaceId: WS })
    expect(m.persistEveMessage).toHaveBeenCalledWith(expect.anything(), {
      conversationId: CONV,
      userId: USER,
      workspaceId: WS,
      role: 'user',
      parts: [{ type: 'text', text: 'what is on my calendar & tomorrow?' }],
      messageId: 'slack-in:T111:D333:1700000000.000100',
      metadata: { kind: 'channel_message', channel: 'slack', slack: { team_id: TEAM, ts: '1700000000.000100' } },
    })
    expect(calls).toEqual([['react', 'D333', '1700000000.000100', WORKING_REACTION]])
    expect(send).toHaveBeenCalledWith({
      name: 'slack/turn.requested',
      id: 'slack-turn-slack-in:T111:D333:1700000000.000100',
      data: { conversationId: CONV, userId: USER, workspaceId: WS, workItemIds: [], reason: 'slack' },
    })
  })

  it('writes nothing and starts nothing for someone no longer a member (or a guest): one notice', async () => {
    for (const role of [null, 'guest']) {
      m.memberRole.mockResolvedValueOnce(role)
      const { slack, calls } = fakeSlack()
      const send = vi.fn()
      expect(await deliverSlackDm({} as never, { dm, installation, link }, slack, { send })).toBe('not_member')
      expect(calls).toEqual([['post', 'D333', SLACK_TURN_NOTICES.not_member()]])
      expect(send).not.toHaveBeenCalled()
    }
    expect(m.persistEveMessage).not.toHaveBeenCalled()
  })

  it('requests no turn when the message could not be written', async () => {
    m.persistEveMessage.mockResolvedValue({ written: false, reason: 'owner_mismatch' })
    const send = vi.fn()
    await expect(deliverSlackDm({} as never, { dm, installation, link }, fakeSlack().slack, { send })).rejects.toThrow('owner_mismatch')
    expect(send).not.toHaveBeenCalled()
  })

  it('a replay (already written) still requests the turn; the event id dedupes it', async () => {
    m.persistEveMessage.mockResolvedValue({ written: false })
    const send = vi.fn(async () => undefined)
    expect(await deliverSlackDm({} as never, { dm, installation, link }, fakeSlack().slack, { send })).toBe('queued')
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('the words stay out of step outputs', () => {
  const DATA = { conversationId: CONV, userId: USER, workspaceId: WS, workItemIds: [], reason: 'slack' as const }

  it('redacts a plan to ids (its primer too), and reads the words back in the plan’s order', async () => {
    const plan = { ok: true, primer: '<conversation-so-far>\nUser: first\n</conversation-so-far>', channelMessages: [{ messageId: 'a', text: 'first' }, { messageId: 'b', text: 'second' }] } as unknown as HomeTurnPlan
    const redacted = redactChannelPlan(plan) as HomeTurnPlan
    expect(redacted.channelMessages).toEqual([{ messageId: 'a', text: '' }, { messageId: 'b', text: '' }])
    expect(redacted.primer).toBeUndefined()
    expect(JSON.stringify(redacted)).not.toContain('first')
    expect(redacted.primerPending).toBe(true)
    const db = fakeDb({ messages: [{ id: 'b', parts: [{ type: 'text', text: 'second' }] }, { id: 'a', parts: [{ type: 'text', text: 'first' }] }] })
    const renderPrimer = vi.fn(async () => '<conversation-so-far>\nUser: earlier\n</conversation-so-far>')
    const hydrated = await hydrateChannelPlan(db.client, DATA, redacted, { renderPrimer })
    expect(hydrated.channelMessages).toEqual([{ messageId: 'a', text: 'first' }, { messageId: 'b', text: 'second' }])
    // The primer comes back inside the send step, without the turn's own messages.
    expect(renderPrimer).toHaveBeenCalledWith(db.client, DATA, new Set(['a', 'b']))
    expect(hydrated.primer).toContain('earlier')
    expect(hydrated.primerPending).toBeUndefined()
  })

  describe('where the reply goes (replyOrigin)', () => {
    const installation = { slack_team_id: TEAM, workspace_id: WS, status: 'active', connect_installation_id: 'inst-T111' }
    const openDm = vi.fn(async () => 'D999')
    const rows = fakeDb({ messages: [{ id: 'a', metadata: { slack: { team_id: TEAM, ts: '1700000001.000100' } } }] })

    beforeEach(() => {
      openDm.mockClear()
      m.getInstallation.mockResolvedValue(installation)
      m.linksForUser.mockResolvedValue([{ slack_team_id: TEAM, slack_user_id: 'U222', user_id: USER }])
    })

    it('is the person’s own DM, opened from their link, with the installation row’s id', async () => {
      expect(await replyOrigin(rows.client, DATA, ['a'], { openDm })).toEqual({
        team_id: TEAM,
        channel_id: 'D999',
        dm_channel_id: 'D999',
        ts: '1700000001.000100',
        reaction_ts: [],
        slack_user_id: 'U222',
        installation_id: 'inst-T111',
      })
      expect(openDm).toHaveBeenCalledWith('inst-T111', 'U222')
      expect(m.linksForUser).toHaveBeenCalledWith(rows.client, USER, [TEAM])
    })

    it('never another workspace’s team, a disconnected one, or one the person isn’t linked in (a forged row goes nowhere)', async () => {
      m.getInstallation.mockResolvedValueOnce({ ...installation, workspace_id: '99999999-9999-4999-8999-999999999999' })
      expect(await replyOrigin(rows.client, DATA, ['a'], { openDm })).toBeNull()
      m.getInstallation.mockResolvedValueOnce({ ...installation, status: 'revoked' })
      expect(await replyOrigin(rows.client, DATA, ['a'], { openDm })).toBeNull()
      m.linksForUser.mockResolvedValueOnce([])
      expect(await replyOrigin(rows.client, DATA, ['a'], { openDm })).toBeNull()
      expect(openDm).not.toHaveBeenCalled()
      // A row whose metadata names no valid team.
      const odd = fakeDb({ messages: [{ id: 'c', metadata: { slack: { team_id: 'nope', ts: '1.1' } } }] })
      expect(await replyOrigin(odd.client, DATA, ['c'], { openDm })).toBeNull()
    })

    it('nowhere when the DM can’t be opened', async () => {
      expect(await replyOrigin(rows.client, DATA, ['a'], { openDm: async () => null })).toBeNull()
      expect(await replyOrigin(rows.client, DATA, ['a'], { openDm: async () => 'C123' })).toBeNull()
    })
  })
})

describe('the reply', () => {
  const reply = { id: 'home-turn:row-1', parts: [{ type: 'text', text: 'You have **standup** at 9.' }] }

  it('is posted once, in Slack’s formatting, from what the thread stored', async () => {
    const db = fakeDb({ messages: [reply], turns: [{ id: 'row-1', reply_sent_at: null }] })
    const { slack, calls } = fakeSlack()
    const args = { userId: USER, conversationId: CONV, rowId: 'row-1' }
    expect(await postSlackTurnReply(db.client, args, origin, slack)).toEqual({ posted: true })
    expect(calls).toEqual([['post', 'D333', 'You have *standup* at 9.']])
    expect(db.turns[0].reply_sent_at).not.toBeNull()
    // A retried step never posts twice.
    expect(await postSlackTurnReply(db.client, args, origin, slack)).toEqual({ posted: false, reason: 'already_sent' })
    expect(calls).toHaveLength(1)
  })

  it('posts nothing for an empty reply, and claims nothing', async () => {
    const db = fakeDb({ messages: [], turns: [{ id: 'row-1', reply_sent_at: null }] })
    const { slack, calls } = fakeSlack()
    expect(await postSlackTurnReply(db.client, { userId: USER, conversationId: CONV, rowId: 'row-1' }, origin, slack)).toEqual({ posted: false, reason: 'quiet' })
    expect(calls).toEqual([])
    expect(db.turns[0].reply_sent_at).toBeNull()
  })

  it('posts nothing for a reply that was only an HTML comment, and claims nothing', async () => {
    const onlyComment = { id: 'home-turn:row-1', parts: [{ type: 'text', text: '<!-- card:4 -->' }] }
    const db = fakeDb({ messages: [onlyComment], turns: [{ id: 'row-1', reply_sent_at: null }] })
    const { slack, calls } = fakeSlack()
    expect(await postSlackTurnReply(db.client, { userId: USER, conversationId: CONV, rowId: 'row-1' }, origin, slack)).toEqual({ posted: false, reason: 'quiet' })
    expect(calls).toEqual([])
    expect(db.turns[0].reply_sent_at).toBeNull()
  })

  it('settling takes the 👀 off, and says so when the turn failed or ran long', async () => {
    m.finish.mockResolvedValue({ outcome: 'quiet', written: false })
    const data = { conversationId: CONV, userId: USER, workspaceId: WS, workItemIds: [], reason: 'slack' as const }
    const failed = { done: true, end: 'failed', state: {} } as unknown as HomeTurnReadResult
    let fx = fakeSlack()
    const db = fakeDb({ messages: [], turns: [{ id: 'row-1', reply_sent_at: null }] })
    expect(await settleSlackTurn(db.client, data, { id: 'row-1' }, failed, { origin, slack: fx.slack }, { finish: m.finish })).toMatchObject({ notice: 'failed' })
    expect(fx.calls).toEqual([['unreact', 'D333', origin.ts, WORKING_REACTION], ['post', 'D333', SLACK_TURN_NOTICES.failed()]])

    const long = { done: false, state: {} } as unknown as HomeTurnReadResult
    fx = fakeSlack()
    expect(await settleSlackTurn(db.client, data, { id: 'row-1' }, long, { origin, slack: fx.slack }, { finish: m.finish })).toMatchObject({ notice: 'unfinished' })
    expect(fx.calls.at(-1)).toEqual(['post', 'D333', SLACK_TURN_NOTICES.unfinished()])
  })

  it('with nowhere to answer, the turn still finishes and nothing is posted', async () => {
    m.finish.mockResolvedValue({ outcome: 'written', written: true })
    const data = { conversationId: CONV, userId: USER, workspaceId: WS, workItemIds: [], reason: 'slack' as const }
    const done = { done: true, end: 'completed', state: {} } as unknown as HomeTurnReadResult
    expect(await settleSlackTurn({} as never, data, { id: 'row-1' }, done, null, { finish: m.finish })).toMatchObject({ written: true, posted: false, postReason: 'no_origin' })
    expect(m.finish).toHaveBeenCalledTimes(1)
  })
})

describe('a channel thread (piece d): each person’s own conversation, answered in the thread', () => {
  const mention = {
    kind: 'mention' as const,
    eventId: 'Ev9',
    teamId: TEAM,
    userTeamId: TEAM,
    slackUserId: 'U222',
    channel: 'C444',
    ts: '1700000005.000100',
    threadTs: '1700000000.000001',
    text: '<@UBOT> what did we decide?',
    sharedExternally: false,
  }
  const THREAD_CONV = '77777777-7777-4777-8777-777777777777'
  const thread = { slack_team_id: TEAM, channel_id: 'C444', thread_ts: '1700000000.000001', user_id: USER, conversation_id: THREAD_CONV, last_mention_ts: '1700000005.000100' }

  it('writes the mention into THEIR conversation for that thread (never the home thread) and requests its turn', async () => {
    m.ensureSlackThread.mockResolvedValue(thread)
    const { slack, calls } = fakeSlack()
    const send = vi.fn(async () => undefined)
    expect(await deliverSlackMention({} as never, { mention, installation, link }, slack, { send })).toBe('queued')
    expect(m.ensureSlackThread).toHaveBeenCalledWith(expect.anything(), {
      teamId: TEAM,
      channelId: 'C444',
      threadTs: '1700000000.000001',
      userId: USER,
      workspaceId: WS,
      title: 'Slack: what did we decide?',
    })
    expect(m.ensureHomeThread).not.toHaveBeenCalled()
    expect(m.persistEveMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ conversationId: THREAD_CONV, role: 'user', parts: [{ type: 'text', text: 'what did we decide?' }] }))
    expect(m.noteThreadMention).toHaveBeenCalledWith(expect.anything(), THREAD_CONV, '1700000005.000100')
    expect(calls).toEqual([['react', 'C444', '1700000005.000100', WORKING_REACTION]])
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ conversationId: THREAD_CONV, reason: 'slack' }) }))
  })

  it('tells someone no longer a member only them (ephemeral), and starts nothing', async () => {
    m.memberRole.mockResolvedValueOnce(null)
    const { slack, calls } = fakeSlack()
    const send = vi.fn()
    expect(await deliverSlackMention({} as never, { mention, installation, link }, slack, { send })).toBe('not_member')
    expect(calls).toEqual([['ephemeral', 'C444', 'U222', SLACK_TURN_NOTICES.not_member()]])
    expect(m.ensureSlackThread).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('answers in the thread the server’s row names, with approval cards going to the person’s DM', async () => {
    m.threadForConversation.mockResolvedValue(thread)
    m.getInstallation.mockResolvedValue({ slack_team_id: TEAM, workspace_id: WS, status: 'active', connect_installation_id: 'inst-T111' })
    m.linksForUser.mockResolvedValue([{ slack_team_id: TEAM, slack_user_id: 'U222', user_id: USER }])
    const data = { conversationId: THREAD_CONV, userId: USER, workspaceId: WS }
    const carried = ['slack-in:T111:C444:1700000003.000100', 'slack-in:T111:C444:1700000005.000100', 'slack-in:T111:C999:1700000006.000100']
    const origin = await replyOrigin({} as never, data, carried, { openDm: async () => 'D999' })
    expect(origin).toEqual({
      team_id: TEAM,
      channel_id: 'C444',
      thread_ts: '1700000000.000001',
      dm_channel_id: 'D999',
      ts: '1700000005.000100',
      // Every carried mention in this channel (another channel's id is not this thread's).
      reaction_ts: ['1700000003.000100', '1700000005.000100'],
      slack_user_id: 'U222',
      installation_id: 'inst-T111',
    })
    // Never a thread of a team bound elsewhere.
    m.getInstallation.mockResolvedValueOnce({ slack_team_id: TEAM, workspace_id: 'elsewhere', status: 'active', connect_installation_id: 'inst-T111' })
    expect(await replyOrigin({} as never, data, ['slack-in:x'], { openDm: async () => 'D999' })).toBeNull()
  })

  it('the reply is posted in the thread', async () => {
    const db = fakeDb({ messages: [{ id: 'home-turn:row-1', parts: [{ type: 'text', text: 'We picked Tuesday.' }] }], turns: [{ id: 'row-1', reply_sent_at: null }] })
    const { slack, calls } = fakeSlack()
    const at = { team_id: TEAM, channel_id: 'C444', thread_ts: '1700000000.000001', dm_channel_id: 'D999', ts: '1700000005.000100', installation_id: TEAM }
    expect(await postSlackTurnReply(db.client, { userId: USER, conversationId: CONV, rowId: 'row-1' }, at, slack)).toEqual({ posted: true })
    expect(calls).toEqual([['post', 'C444', 'We picked Tuesday.', '1700000000.000001']])
  })
})

describe('notices and the 👀 (part d review)', () => {
  const thread = { team_id: TEAM, channel_id: 'C444', thread_ts: '1700000000.000001', dm_channel_id: 'D999', ts: '1700000005.000100', reaction_ts: ['1700000003.000100', '1700000005.000100'], slack_user_id: 'U222', installation_id: TEAM }

  it('in a channel thread, a notice goes to the person alone, and the 👀 comes off every carried mention', async () => {
    const { slack, calls } = fakeSlack()
    await noticeToPerson(thread, slack, SLACK_TURN_NOTICES.failed())
    expect(calls).toEqual([
      ['unreact', 'C444', '1700000003.000100', WORKING_REACTION],
      ['unreact', 'C444', '1700000005.000100', WORKING_REACTION],
      ['ephemeral', 'C444', 'U222', SLACK_TURN_NOTICES.failed()],
    ])
  })

  it('in a DM, a notice is an ordinary message', async () => {
    const { slack, calls } = fakeSlack()
    await noticeToPerson({ team_id: TEAM, channel_id: 'D333', dm_channel_id: 'D333', ts: '1.1', installation_id: TEAM }, slack, 'hi')
    expect(calls).toEqual([['unreact', 'D333', '1.1', WORKING_REACTION], ['post', 'D333', 'hi']])
  })

  it('a thread turn that ran long says so only to the person', async () => {
    m.finish.mockResolvedValue({ outcome: 'watch_exhausted', written: false })
    const { slack, calls } = fakeSlack()
    const data = { conversationId: CONV, userId: USER, workspaceId: WS, workItemIds: [], reason: 'slack' as const }
    await settleSlackTurn({} as never, data, { id: 'row-1' }, { done: false, state: {} } as unknown as HomeTurnReadResult, { origin: thread, slack }, { finish: m.finish })
    expect(calls.filter((c) => c[0] === 'post')).toEqual([])
    expect(calls.at(-1)).toEqual(['ephemeral', 'C444', 'U222', SLACK_TURN_NOTICES.unfinished()])
  })
})

describe('a guest on Slack (guest access, migration 434)', () => {
  const GUEST = '44444444-4444-4444-8444-444444444444'
  const data = { conversationId: CONV, userId: USER, workspaceId: WS, workItemIds: [], reason: 'slack' as const, guestId: GUEST }
  const target = { teamId: TEAM, slackUserId: 'U777', installationId: TEAM }

  it('is answered in their own DM, opened from the Slack account bound to them, with no DM for cards', async () => {
    m.guestSlackTarget.mockResolvedValue(target)
    const db = fakeDb({ messages: [{ id: 'slack-in:T111:D777:1700000000.000100', metadata: { slack: { team_id: TEAM, ts: '1700000000.000100' } } }] })
    const openDm = vi.fn(async () => 'D777')
    const got = await replyOrigin(db.client, data, ['slack-in:T111:D777:1700000000.000100'], { openDm })
    expect(m.guestSlackTarget).toHaveBeenCalledWith(db.client, { guestId: GUEST, ownerUserId: USER, workspaceId: WS })
    expect(openDm).toHaveBeenCalledWith(TEAM, 'U777')
    expect(got).toEqual({ team_id: TEAM, channel_id: 'D777', ts: '1700000000.000100', reaction_ts: ['1700000000.000100'], slack_user_id: 'U777', installation_id: TEAM })
    expect(got).not.toHaveProperty('dm_channel_id')
    // Never the person's link: a guest isn't linked.
    expect(m.linksForUser).not.toHaveBeenCalled()
  })

  it('a guest who can no longer be answered on Slack gets nothing', async () => {
    m.guestSlackTarget.mockResolvedValue(null)
    expect(await replyOrigin(fakeDb({}).client, data, ['slack-in:x'], { openDm: async () => 'D777' })).toBeNull()
    m.guestSlackTarget.mockResolvedValue(target)
    expect(await replyOrigin(fakeDb({}).client, data, ['slack-in:x'], { openDm: async () => 'C123' })).toBeNull()
  })

  it("never posts the owner's approval cards to a guest, and tells them in their own words", async () => {
    m.approvalsRaisedSince.mockResolvedValue([{ approvalId: 'ap-1', tool: 'create_calendar_event', summary: 'x' }])
    m.finish.mockResolvedValue({ outcome: 'written', written: true })
    const reply = { id: 'home-turn:row-1', parts: [{ type: 'text', text: 'Asked Liam for that.' }] }
    const db = fakeDb({ messages: [reply], turns: [{ id: 'row-1', reply_sent_at: null }] })
    const guestOrigin: SlackOrigin = { ...origin, channel_id: 'D777', dm_channel_id: 'D777' }
    const fx = fakeSlack()
    const done = { done: true, end: 'completed', state: {} } as unknown as HomeTurnReadResult
    const settled = await settleSlackTurn(db.client, data, { id: 'row-1', created_at: '2026-10-25T00:00:00Z' }, done, { origin: guestOrigin, slack: fx.slack }, { finish: m.finish })
    expect(settled).toMatchObject({ posted: true })
    expect(settled).not.toHaveProperty('approvals')
    expect(m.approvalsRaisedSince).not.toHaveBeenCalled()
    expect(fx.calls).toEqual([['unreact', 'D777', origin.ts, WORKING_REACTION], ['post', 'D777', 'Asked Liam for that.']])

    const long = { done: false, state: {} } as unknown as HomeTurnReadResult
    const fx2 = fakeSlack()
    await settleSlackTurn(db.client, data, { id: 'row-1' }, long, { origin: guestOrigin, slack: fx2.slack }, { finish: m.finish })
    expect(fx2.calls.at(-1)).toEqual(['post', 'D777', GUEST_SLACK_TURN_NOTICES.unfinished()])
  })

  it("a guest's notices never point at Settings, Billing or Dial8", () => {
    for (const reason of ['usage_limited', 'not_member', 'busy', 'unfinished', 'failed', 'question_pending'] as const) {
      const notice = guestSlackTurnSkipNotice(reason)
      expect(notice, reason).toBeTruthy()
      expect(notice, reason).not.toMatch(/Settings|Billing|Dial8/i)
    }
  })
})
