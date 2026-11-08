/**
 * /api/account/agent-model — the model the person's main agent runs on.
 *
 *  • GET reports the saved pick (`auto` when none, or when what's saved isn't
 *    a pick) and the plan the setting offers from: `chatgpt` with the plan's
 *    model named, `paid`, `unpaid`, or null when the usage check failed. The
 *    check is the chat's own, opted in to the ChatGPT plan.
 *  • PUT saves `auto` (as null) or a pick through the ADMIN API keyed on the
 *    verified user, touching only `agent_model`; anything else is a 400 and
 *    writes nothing; a failed save is a 500.
 *  • Signed out: 401, nothing read or written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  user: null as null | { id: string; user_metadata: Record<string, unknown> },
  updateUserById: vi.fn(async (..._args: unknown[]) => ({ error: null as null | { message: string } })),
  rpc: vi.fn(async (..._args: unknown[]) => ({ data: [] as unknown[], error: null as null | { message: string } })),
}))

vi.mock('@/lib/api-auth', () => ({
  requireUser: async () =>
    hoisted.user ? { user: hoisted.user, supabase: {} } : new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({ auth: { admin: { updateUserById: hoisted.updateUserById } }, rpc: hoisted.rpc }),
}))

const { GET, PUT } = await import('@/app/api/account/agent-model/route')

const put = (body: unknown) => PUT(buildRequest({ url: 'http://localhost/api/account/agent-model', method: 'PUT', body }))

beforeEach(() => {
  hoisted.user = { id: 'user-1', user_metadata: {} }
  hoisted.updateUserById.mockClear()
  hoisted.updateUserById.mockResolvedValue({ error: null })
  hoisted.rpc.mockClear()
  hoisted.rpc.mockResolvedValue({ data: [{ allowed: true, reason: 'within_limits', is_paid_plan: true }], error: null })
})

describe('GET /api/account/agent-model', () => {
  it('reports the saved pick and a paid plan, from the chat\'s own usage check', async () => {
    hoisted.user!.user_metadata = { agent_model: 'claude-opus-5-5', assistant_name: 'Mary' }
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ model: 'claude-opus-5-5', plan: 'paid', planModel: null })
    expect(hoisted.rpc).toHaveBeenCalledWith('check_ai_usage_limit', { p_user_id: 'user-1', p_chatgpt_plan: true })
  })

  it('reports auto when nothing (or not a pick) is saved', async () => {
    for (const saved of [undefined, null, 'claude-haiku-5-5', 'gpt-6.1-sol']) {
      hoisted.user!.user_metadata = saved === undefined ? {} : { agent_model: saved }
      expect(((await readJson(await GET())) as { model: string }).model, String(saved)).toBe('auto')
    }
  })

  it('names the plan model on the ChatGPT plan, and says unpaid or unknown otherwise', async () => {
    hoisted.rpc.mockResolvedValue({ data: [{ allowed: true, reason: 'chatgpt_plan_exhausted', is_paid_plan: false }], error: null })
    expect(await readJson(await GET())).toEqual({ model: 'auto', plan: 'chatgpt', planModel: 'GPT-6.1 Sol' })
    hoisted.rpc.mockResolvedValue({ data: [{ allowed: false, reason: 'subscription_required', is_paid_plan: false }], error: null })
    expect(await readJson(await GET())).toMatchObject({ plan: 'unpaid' })
    // Over the limit is still a paid plan.
    hoisted.rpc.mockResolvedValue({ data: [{ allowed: false, reason: 'cost_limit_exceeded', is_paid_plan: true }], error: null })
    expect(await readJson(await GET())).toMatchObject({ plan: 'paid' })
    hoisted.rpc.mockResolvedValue({ data: [], error: { message: 'down' } })
    expect(await readJson(await GET())).toMatchObject({ plan: null, planModel: null })
  })

  it('is a 401 signed out', async () => {
    hoisted.user = null
    expect((await GET()).status).toBe(401)
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })
})

describe('PUT /api/account/agent-model', () => {
  it('saves a pick on the account, touching only agent_model', async () => {
    const res = await put({ model: 'gpt-5.6-luna' })
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ model: 'gpt-5.6-luna' })
    expect(hoisted.updateUserById).toHaveBeenCalledWith('user-1', { user_metadata: { agent_model: 'gpt-5.6-luna' } })
  })

  it('saves auto as null', async () => {
    const res = await put({ model: 'auto' })
    expect(await readJson(res)).toEqual({ model: 'auto' })
    expect(hoisted.updateUserById).toHaveBeenCalledWith('user-1', { user_metadata: { agent_model: null } })
  })

  it('refuses anything else, writing nothing', async () => {
    for (const body of [{ model: 'claude-haiku-5-5' }, { model: 'gpt-6.1-sol' }, { model: 42 }, {}, null]) {
      expect((await put(body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(hoisted.updateUserById).not.toHaveBeenCalled()
  })

  it('is a 500 when the account doesn\'t take it, and a 401 signed out', async () => {
    hoisted.updateUserById.mockResolvedValue({ error: { message: 'nope' } })
    expect((await put({ model: 'claude-opus-5-5' })).status).toBe(500)
    hoisted.user = null
    hoisted.updateUserById.mockClear()
    expect((await put({ model: 'claude-opus-5-5' })).status).toBe(401)
    expect(hoisted.updateUserById).not.toHaveBeenCalled()
  })
})
