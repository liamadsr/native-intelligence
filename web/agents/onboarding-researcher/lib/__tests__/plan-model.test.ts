/**
 * The researcher on a free user's own ChatGPT plan (lib/model.ts). Pinned:
 *   - no plan token: the Gateway selection, unchanged, at every scope;
 *   - a plan token: the plan's guard at session scope, the plan's search
 *     model (eve reads it as OpenAI's own) at every step, through the plan
 *     proxy with the agent-run secret and the token, never a key;
 *   - a session that started on the plan stays there when a later message
 *     brings a principal without the token;
 *   - only a create the app vouched for with the internal secret carries a
 *     plan token onto the principal (vouchedPlanToken).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stateStore = new Map<string, unknown>()
vi.mock('eve/context', () => ({
  defineState: <T,>(name: string, initial: () => T) => ({
    get: () => (stateStore.has(name) ? (stateStore.get(name) as T) : initial()),
    update: (fn: (prev: T) => T) => stateStore.set(name, fn(stateStore.has(name) ? (stateStore.get(name) as T) : initial())),
  }),
}))

import { GATEWAY_SELECTION, RESEARCH_PLAN, researcherModel } from '../model'
import { planTurnSelection } from '../chatgpt-plan-model'
import { vouchedPlanToken } from '../auth'

type Resolver = { events: Record<string, (e: unknown, ctx: { session: { auth: unknown } }) => unknown> }
const events = () => (researcherModel as unknown as Resolver).events
const auth = (planToken?: string) => ({ current: { attributes: { workspaceId: 'ws-1', ...(planToken ? { planToken } : {}) } } })
type LiveModel = { provider: string; modelId: string; doStream: (o: unknown) => Promise<unknown> }

const env = { ...process.env }
beforeEach(() => {
  stateStore.clear()
  process.env.AGENT_RUN_INTERNAL_SECRET = 'agent-run-secret'
  process.env.NEXT_PUBLIC_APP_URL = 'http://127.0.0.1:3002'
})
afterEach(() => {
  process.env = { ...env }
  vi.unstubAllGlobals()
})

describe('the researcher model', () => {
  it('runs everyone without a plan token on the Gateway selection, unchanged', () => {
    expect(events()['session.started']({}, { session: { auth: auth() } })).toEqual(GATEWAY_SELECTION)
    expect(events()['step.started']({}, { session: { auth: auth() } })).toEqual(GATEWAY_SELECTION)
  })

  it("runs a free user's research on their plan's search model, through the plan proxy with their token", async () => {
    expect(events()['session.started']({}, { session: { auth: auth('plan.tok') } })).toEqual(planTurnSelection(RESEARCH_PLAN))
    const step = events()['step.started']({}, { session: { auth: auth('plan.tok') } }) as { model: LiveModel }
    expect(step.model.provider).toBe('openai.chatgpt-plan.responses')
    expect(step.model.modelId).toBe('gpt-6-luna')

    const fetchMock = vi.fn(async () =>
      new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await step.model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:3002/api/internal/chatgpt-plan/v1/responses')
    const headers = new Headers(init.headers)
    expect(headers.get('x-agent-run-secret')).toBe('agent-run-secret')
    expect(headers.get('x-agent-run-token')).toBe('plan.tok')
    expect(headers.get('authorization')).toBeNull()
  })

  it('keeps a session that started on the plan on it, whatever a later principal carries', () => {
    events()['session.started']({}, { session: { auth: auth('plan.tok') } })
    const later = events()['step.started']({}, { session: { auth: auth() } }) as { model: LiveModel }
    expect(later.model.provider).toBe('openai.chatgpt-plan.responses')
  })
})

describe('vouchedPlanToken', () => {
  const create = (headers: Record<string, string>, path = '/eve/v1/session', method = 'POST') =>
    new Request(`http://app.test/eve/onboarding-researcher${path}`, { method, headers })

  it('reads the token only off a create vouched for with the internal secret', () => {
    expect(vouchedPlanToken(create({ 'x-agent-run-secret': 'agent-run-secret', 'x-agent-run-token': 'plan.tok' }))).toBe('plan.tok')
    expect(vouchedPlanToken(create({ 'x-agent-run-secret': 'wrong', 'x-agent-run-token': 'plan.tok' }))).toBeNull()
    expect(vouchedPlanToken(create({ 'x-agent-run-token': 'plan.tok' }))).toBeNull()
    expect(vouchedPlanToken(create({ 'x-agent-run-secret': 'agent-run-secret' }))).toBeNull()
    expect(vouchedPlanToken(create({ 'x-agent-run-secret': 'agent-run-secret', 'x-agent-run-token': 'plan.tok' }, '/eve/v1/session/wrun_1/stream', 'GET'))).toBeNull()
  })
})
