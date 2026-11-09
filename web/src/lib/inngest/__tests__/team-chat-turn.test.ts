/**
 * team-chat/turn.requested (src/lib/inngest/team-chat-turn.ts): one turn of
 * the person's agent for a team chat mention, the Slack relay's steps.
 * Refuses a malformed event or a guest's; a skip the person should hear about
 * posts one notice as their agent that says nothing of their own business; a
 * conversation busy with another turn waits for its lease, then gives up with
 * a notice; a turn that runs is sent, read and settled in the same step, so
 * the reply's words never become a step output.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStepMock } from '@/test/inngest-step-mock'

type Handler = (ctx: { event: { data: Record<string, unknown> }; step: ReturnType<typeof createStepMock> }) => Promise<Record<string, unknown>>

const h = vi.hoisted(() => ({
  handler: null as unknown as Handler,
  config: null as unknown as Record<string, unknown>,
  plan: null as unknown as Record<string, unknown>,
  claims: [] as Array<Record<string, unknown>>,
  posted: [] as string[],
  settled: [] as Array<{ target: unknown }>,
  target: { channelId: 'ch', workspaceId: 'ws', memberId: 'm', agentName: 'Juniper', inReplyTo: null } as unknown,
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, fn: Handler) => {
      h.config = config
      h.handler = fn
      return { id: config.id }
    },
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/chat/home-turn-server', () => ({
  HOME_TURN_MAX_READ_STEPS: 2,
  planHomeTurn: async () => h.plan,
  claimHomeTurn: async () => h.claims.shift() ?? { kind: 'busy' },
  recordSkippedHomeTurn: vi.fn(async () => undefined),
  sendHomeTurn: async () => ({ kind: 'ok', result: { done: true, end: 'completed', state: {} } }),
  continueHomeTurn: async () => ({ kind: 'ok', result: { done: true, end: 'completed', state: {} } }),
  homeTurnLogLine: (a: { outcome: string }) => `[home-turn] outcome=${a.outcome}`,
}))
vi.mock('@/lib/chat/channel-turn-server', () => ({
  redactChannelPlan: (p: unknown) => p,
  hydrateChannelPlan: async (_s: unknown, _d: unknown, p: unknown) => p,
  plannedMessageIds: (p: { channelMessages?: Array<{ messageId: string }>; record?: { channelMessages?: Array<{ messageId: string }> } }) =>
    (p.channelMessages ?? p.record?.channelMessages ?? []).map((m) => m.messageId),
}))
vi.mock('@/lib/team-chat/agent-turn', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-chat/agent-turn')>()),
  replyTarget: async () => h.target,
  postAsAgent: async (_s: unknown, _t: unknown, body: string) => {
    h.posted.push(body)
    return true
  },
  settleTeamChatTurn: async (_s: unknown, _d: unknown, _r: unknown, _read: unknown, target: unknown) => {
    h.settled.push({ target })
    return { outcome: 'done', written: true, posted: true }
  },
}))

await import('../team-chat-turn')
const { TEAM_CHAT_TURN_NOTICES } = await import('@/lib/team-chat/agent-turn')

const DATA = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  workItemIds: [],
  reason: 'team_chat',
}
const MESSAGES = [{ messageId: 'team-chat-in:x', text: 'hi' }]

beforeEach(() => {
  h.plan = { ok: true, channelMessages: MESSAGES }
  h.claims = []
  h.posted = []
  h.settled = []
})

describe('teamChatTurn', () => {
  it('rides its own event, one turn at a time per conversation, debounced', () => {
    expect(h.config.triggers).toEqual([{ event: 'team-chat/turn.requested' }])
    expect(h.config.concurrency).toEqual([{ limit: 1, key: 'event.data.conversationId' }])
    expect(h.config.debounce).toMatchObject({ key: 'event.data.conversationId' })
  })

  it('refuses a malformed event, another reason’s, or a guest’s', async () => {
    for (const data of [{}, { ...DATA, reason: 'slack' }, { ...DATA, guestId: '44444444-4444-4444-8444-444444444444' }]) {
      expect(await h.handler({ event: { data }, step: createStepMock() })).toEqual({ status: 'skipped', reason: 'bad_event' })
    }
    expect(h.posted).toEqual([])
  })

  it('a skip over their usage limit says only that it can’t answer here', async () => {
    h.plan = { ok: false, reason: 'usage_limited', record: { channelMessages: MESSAGES } }
    expect(await h.handler({ event: { data: DATA }, step: createStepMock() })).toEqual({ status: 'skipped', reason: 'usage_limited' })
    expect(h.posted).toEqual([TEAM_CHAT_TURN_NOTICES.cannot()])
  })

  it('nothing new is quiet', async () => {
    h.plan = { ok: false, reason: 'nothing_new' }
    await h.handler({ event: { data: DATA }, step: createStepMock() })
    expect(h.posted).toEqual([])
  })

  it('waits for another turn’s lease, then runs', async () => {
    h.claims = [{ kind: 'busy' }, { kind: 'claimed', row: { id: 'row-1', created_at: 'now' } }]
    const step = createStepMock()
    const out = await h.handler({ event: { data: DATA }, step })
    expect(step.sleep).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ status: 'done', rowId: 'row-1', posted: true })
    expect(h.settled).toEqual([{ target: h.target }])
  })

  it('gives up after the lease waits, with a notice', async () => {
    h.claims = Array.from({ length: 40 }, () => ({ kind: 'busy' }))
    const step = createStepMock()
    expect(await h.handler({ event: { data: DATA }, step })).toEqual({ status: 'skipped', reason: 'busy' })
    expect(step.sleep).toHaveBeenCalledTimes(30)
    expect(h.posted).toEqual(["I'm still busy with something else. Mention me again in a few minutes."])
  })

  it('a duplicate does nothing', async () => {
    h.claims = [{ kind: 'duplicate' }]
    expect(await h.handler({ event: { data: DATA }, step: createStepMock() })).toEqual({ status: 'skipped', reason: 'duplicate' })
    expect(h.posted).toEqual([])
    expect(h.settled).toEqual([])
  })

  it('settles inside the send step: the reply’s words are never a step output', async () => {
    h.claims = [{ kind: 'claimed', row: { id: 'row-1', created_at: 'now' } }]
    const step = createStepMock()
    await h.handler({ event: { data: DATA }, step })
    const send = step.run.mock.calls.findIndex((c) => c[0] === 'send')
    expect(send).toBeGreaterThanOrEqual(0)
    expect(await step.run.mock.results[send].value).toEqual({ kind: 'settled', settled: { outcome: 'done', written: true, posted: true } })
  })
})
