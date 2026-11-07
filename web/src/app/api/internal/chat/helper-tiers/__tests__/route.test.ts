/**
 * POST /api/internal/chat/helper-tiers — each quick helper task's tier (auto
 * model selection): the secret and a verified token gate it, helpers must be
 * allowed in the conversation, the rules (and the cap, through
 * decideHelperTier) decide, and Jev answers in shadow only for undecided tasks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const SECRET = 'test-chat-internal-secret-abcdefghij'

const h = vi.hoisted(() => ({
  decide: vi.fn(),
  runDecision: vi.fn(async (..._a: unknown[]) => ({ status: 'escalate', reason: 'test' })),
  deferred: [] as Promise<unknown>[],
  /** The run-token DB binding's answer (surface-run-guard.ts has its own tests). */
  bindingRefusal: null as Response | null,
}))
vi.mock('@/lib/chat/surface-run-guard', () => ({ chatRunBindingRefusal: async () => h.bindingRefusal }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/ai/helper-tier', () => ({ decideHelperTiers: h.decide }))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: h.runDecision }))
vi.mock('@/lib/log/agent-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/log/agent-log')>()),
  deferLogWrite: (w: Promise<unknown>) => h.deferred.push(w),
}))

import { POST } from '@/app/api/internal/chat/helper-tiers/route'
import { mintChatRunToken, CHAT_RUN_SECRET_HEADER, CHAT_RUN_TOKEN_HEADER, type ChatRunTokenClaims } from '@/lib/chat/chat-run-token'
import { turnRouteSignals } from '@/lib/ai/model-route'

const token = (over: Partial<ChatRunTokenClaims> = {}) =>
  mintChatRunToken({ conversationId: 'c', workspaceId: 'ws-1', userId: 'user-1', ...over } as never)

function req(body: unknown, opts: { secret?: string; token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.secret !== undefined) headers[CHAT_RUN_SECRET_HEADER] = opts.secret
  if (opts.token !== undefined) headers[CHAT_RUN_TOKEN_HEADER] = opts.token
  return new Request('http://localhost/api/internal/chat/helper-tiers', { method: 'POST', headers, body: JSON.stringify(body) })
}

const ctxWith = (text: string) => Buffer.from(JSON.stringify({ route: turnRouteSignals(text) }), 'utf8').toString('base64url')

describe('POST /api/internal/chat/helper-tiers', () => {
  beforeEach(() => {
    process.env.CHAT_INTERNAL_SECRET = SECRET
    h.decide.mockReset()
    h.runDecision.mockClear()
    h.deferred.length = 0
    h.bindingRefusal = null
  })
  afterEach(() => {
    delete process.env.CHAT_INTERNAL_SECRET
  })

  it('a token that does not bind to a live conversation of its user is refused before any tier is decided', async () => {
    h.bindingRefusal = Response.json({ error: 'unbound', code: 'RUN_TOKEN_UNBOUND' }, { status: 403 })
    const res = await POST(req({ tasks: ['x'] }, { secret: SECRET, token: token() }))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'RUN_TOKEN_UNBOUND' })
    expect(h.decide).not.toHaveBeenCalled()
    expect(h.runDecision).not.toHaveBeenCalled()
  })

  it('401 on a wrong secret or a bad token; 403 where helpers are not allowed (device, bot, relay, server)', async () => {
    expect((await POST(req({ tasks: ['x'] }, { secret: 'nope', token: token() }))).status).toBe(401)
    expect((await POST(req({ tasks: ['x'] }, { secret: SECRET, token: 'garbage' }))).status).toBe(401)
    for (const over of [{ surface: 'device_ask' }, { teammateId: 'tm' }, { teammateId: 'tm', relay: 'r' }, { server: 'home_turn' }]) {
      const res = await POST(req({ tasks: ['x'] }, { secret: SECRET, token: token(over as Partial<ChatRunTokenClaims>) }))
      expect(res.status, JSON.stringify(over)).toBe(403)
    }
    expect(h.decide).not.toHaveBeenCalled()
  })

  it('400 on a malformed body: 1-4 strings only', async () => {
    for (const tasks of [undefined, [], ['a', 'b', 'c', 'd', 'e'], [3], ['x'.repeat(12_001)]]) {
      expect((await POST(req({ tasks }, { secret: SECRET, token: token() }))).status, JSON.stringify(tasks)?.slice(0, 40)).toBe(400)
    }
  })

  it('decides each task for the token\'s owner, with the person\'s turn excerpt, one escalation key per task', async () => {
    h.decide.mockResolvedValueOnce([
      { route: { tier: 'fast', by: 'rule', signals: ['routine_task'], reasoning: 'none' }, undecided: false },
      { route: { tier: 'strong', by: 'rule', signals: ['sql'], reasoning: 'adaptive' }, undecided: false },
    ])
    const res = await POST(req({ tasks: ['Draft replies', 'Fix the SQL'], ctx: ctxWith('use the best model') }, { secret: SECRET, token: token() }))
    expect(res.status).toBe(200)
    expect((await res.json()).tiers).toEqual([
      { tier: 'fast', by: 'rule', signals: ['routine_task'], reasoning: 'none' },
      { tier: 'strong', by: 'rule', signals: ['sql'], reasoning: 'adaptive' },
    ])
    // One batch for the request: the plan and the cap are read once for all its tasks.
    expect(h.decide).toHaveBeenCalledTimes(1)
    const arg = h.decide.mock.calls[0][1] as { tasks: Array<{ key: string; task: string }> } & Record<string, unknown>
    expect(arg).toMatchObject({ userId: 'user-1', workspaceId: 'ws-1', surface: 'quick_helper', turnExcerpt: 'use the best model', defaultTier: 'fast' })
    expect(arg.tasks.map((t) => t.task)).toEqual(['Draft replies', 'Fix the SQL'])
    expect(arg.tasks[0].key).not.toBe(arg.tasks[1].key)
    expect(arg.tasks[0].key).toMatch(/^quick:/)
    // Nothing undecided: no Jev.
    expect(h.deferred).toHaveLength(0)
  })

  it('passes the main agent\'s chosen model per task (null: the rules pick), and answers each route with its roster key', async () => {
    h.decide.mockResolvedValueOnce([
      { route: { tier: 'strong', by: 'agent', signals: ['chose_opus'], reasoning: 'adaptive', model: 'opus' }, undecided: false },
      { route: { tier: 'fast', by: 'rule', signals: ['routine_task'], reasoning: 'none', model: 'flash' }, undecided: false },
    ])
    const res = await POST(req({ tasks: ['Weigh the three bids', 'Draft replies'], models: ['opus', null] }, { secret: SECRET, token: token() }))
    expect(res.status).toBe(200)
    expect((await res.json()).tiers).toEqual([
      { tier: 'strong', by: 'agent', signals: ['chose_opus'], reasoning: 'adaptive', model: 'opus' },
      { tier: 'fast', by: 'rule', signals: ['routine_task'], reasoning: 'none', model: 'flash' },
    ])
    const arg = h.decide.mock.calls[0][1] as { tasks: Array<{ task: string; requested?: string }> }
    expect(arg.tasks.map((t) => t.requested)).toEqual(['opus', undefined])
  })

  it('400 on malformed models: the wrong length or an unknown key (never guessed)', async () => {
    for (const models of [['opus'], ['opus', 'gpt-99'], 'opus', [1, null]]) {
      expect((await POST(req({ tasks: ['a', 'b'], models }, { secret: SECRET, token: token() }))).status, JSON.stringify(models)).toBe(400)
    }
    expect(h.decide).not.toHaveBeenCalled()
  })

  it('asks Jev in shadow for the undecided tasks only, after answering', async () => {
    h.decide.mockResolvedValueOnce([
      { route: { tier: 'fast', by: 'rule', signals: ['default'], reasoning: 'none' }, undecided: true },
      { route: { tier: 'fast', by: 'rule', signals: ['routine_task'], reasoning: 'none' }, undecided: false },
    ])
    const res = await POST(req({ tasks: ['Plan the offsite', 'Draft replies'] }, { secret: SECRET, token: token() }))
    expect(res.status).toBe(200)
    await Promise.all(h.deferred)
    expect(h.runDecision).toHaveBeenCalledTimes(1)
    expect(h.runDecision).toHaveBeenCalledWith('model.tier', { surface: 'helper', text: 'Plan the offsite', attachments: [] }, expect.objectContaining({ mode: 'shadow', userId: 'user-1' }))
  })
})
