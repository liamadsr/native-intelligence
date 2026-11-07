import { describe, expect, it, vi } from 'vitest'

const spec = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }))
vi.mock('../spec-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../spec-client')>()),
  fetchEveSpec: async () => spec.value,
  runTokenFromAuth: () => 'tok',
}))

import agent from '../../agent'
import { CODING_COMPACTION_WINDOW_TOKENS, codingCompactionWindow, codingModelSelection } from '../model-selection'
import { STRONG_MODEL, gatewayModelSlug } from '@/lib/ai/models'

type Resolver = { events: Record<string, (e: unknown, ctx: { session: { auth: unknown } }) => Promise<unknown>> }
const resolver = (agent as unknown as { model: Resolver }).model

describe('coding agent model selection: the compaction window is capped at 250K', () => {
  it('caps Sonnet 5.5’s 1M window at 250K (eve compacts at ~225K, near the 4.5 behaviour); a smaller known window keeps its own', () => {
    expect(CODING_COMPACTION_WINDOW_TOKENS).toBe(250_000)
    expect(codingCompactionWindow(gatewayModelSlug(STRONG_MODEL))).toBe(250_000)
    expect(codingCompactionWindow('anthropic/claude-sonnet-4.5')).toBe(200_000)
    expect(codingCompactionWindow('anthropic/unknown')).toBe(250_000)
    expect(codingModelSelection('anthropic/claude-sonnet-5.5', null)).toEqual({ model: 'anthropic/claude-sonnet-5.5', modelContextWindowTokens: 250_000 })
  })

  it('the resolver hands eve the capped window on every path: the spec’s model, with attribution, and the fallback', async () => {
    spec.value = { model: 'anthropic/claude-sonnet-5.5', gatewayTelemetry: { user: 'u', tags: ['t'] } }
    expect(await resolver.events['session.started']({}, { session: { auth: {} } })).toEqual({
      model: 'anthropic/claude-sonnet-5.5',
      modelContextWindowTokens: 250_000,
      modelOptions: { providerOptions: { gateway: { user: 'u', tags: ['t'] } } },
    })
    spec.value = null
    expect(await resolver.events['session.started']({}, { session: { auth: {} } })).toEqual({
      model: gatewayModelSlug(STRONG_MODEL),
      modelContextWindowTokens: 250_000,
    })
  })
})
