import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it, expect, vi } from 'vitest'
import { modelSelectionFromSpec, type LiveAgentSpec } from '../spec-client'
import { COMPACTION_WINDOW_TOKENS } from '../model-policy'
import { deepseekSurfacePolicy, gatewayModelSlug, type DeepSeekThinking } from '@/lib/ai/models'

/**
 * The live agent's selection with the spec's modelPolicy (deepseekSurfacePolicy):
 * a live copilot or notes turn runs DeepSeek with thinking off, a batch pass
 * with it on, both on private hosts. Each selection runs through eve's own
 * resolveRuntimeModelSelection, since an invalid one fails the turn.
 */
const eveRoot = dirname(createRequire(import.meta.url).resolve('eve/package.json'))
type Reference = { id: string; contextWindowTokens?: number; reasoning?: string; providerOptions?: Record<string, unknown> }
async function resolveWithEve(selection: unknown): Promise<Reference> {
  const { resolveRuntimeModelSelection } = (await import(
    pathToFileURL(join(eveRoot, 'dist/src/runtime/agent/resolve-model.js')).href
  )) as { resolveRuntimeModelSelection: (a: unknown) => Promise<{ reference: Reference }> }
  const { reference } = await resolveRuntimeModelSelection({
    selection,
    state: { get: vi.fn(), set: vi.fn() },
    catalog: { getByGatewayId: vi.fn(async () => null), getByProviderModelId: vi.fn(async () => null) },
    durability: 'durable',
  })
  return reference
}

const TELEMETRY = { user: 'user-1', tags: ['feature:live_agent', 'env:development', 'runtime:eve'] }

function specFor(id: string, thinking: DeepSeekThinking, withTelemetry: boolean): LiveAgentSpec {
  const modelPolicy = deepseekSurfacePolicy(id, thinking)
  return JSON.parse(
    JSON.stringify({
      systemPrompt: 'p',
      model: gatewayModelSlug(id),
      ceiling: [],
      ceilingTools: [],
      coreToolNames: [],
      assistOnly: false,
      pairNotes: false,
      webAccess: true,
      ...(withTelemetry ? { gatewayTelemetry: TELEMETRY } : {}),
      ...(modelPolicy ? { modelPolicy } : {}),
    }),
  ) as LiveAgentSpec
}

const CASES = (['deepseek-v4-flash', 'deepseek-v4-pro'] as const).flatMap((id) =>
  (['off', 'on'] as const).flatMap((thinking) => [true, false].map((withTelemetry) => ({ id, thinking, withTelemetry }))),
)

describe('live-agent selection with the model policy', () => {
  it.each(CASES)('$id, thinking $thinking (telemetry: $withTelemetry): eve accepts it and keeps the policy', async ({ id, thinking, withTelemetry }) => {
    const policy = deepseekSurfacePolicy(id, thinking)!
    const reference = await resolveWithEve(modelSelectionFromSpec(specFor(id, thinking, withTelemetry)))
    expect(reference.id).toBe(gatewayModelSlug(id))
    expect(reference.reasoning).toBe(thinking === 'on' ? 'high' : 'none')
    // The 1M window is capped at the 600K compaction safety ceiling.
    expect(policy.contextWindowTokens).toBeGreaterThan(COMPACTION_WINDOW_TOKENS)
    expect(reference.contextWindowTokens).toBe(COMPACTION_WINDOW_TOKENS)
    expect(reference.providerOptions).toEqual({
      deepseek: { thinking: { type: thinking === 'on' ? 'enabled' : 'disabled' } },
      gateway: { ...(withTelemetry ? TELEMETRY : {}), ...policy.gateway },
    })
  })

  it('a model without a policy keeps its selection, plus the compaction ceiling (its real window, capped at 600K)', async () => {
    expect(modelSelectionFromSpec(specFor('claude-sonnet-4-5-20250929', 'off', false))).toEqual({ model: 'anthropic/claude-sonnet-4.5', modelContextWindowTokens: 200_000 })
    expect(modelSelectionFromSpec(specFor('claude-haiku-4-5-20251001', 'on', true))).toEqual({
      model: 'anthropic/claude-haiku-4.5',
      modelContextWindowTokens: 200_000,
      modelOptions: { providerOptions: { gateway: TELEMETRY } },
    })
    const k3 = modelSelectionFromSpec(specFor('claude-sonnet-5-5', 'on', false))
    expect(k3).toEqual({ model: 'anthropic/claude-sonnet-5.5', modelContextWindowTokens: 600_000 })
    expect((await resolveWithEve(k3)).contextWindowTokens).toBe(600_000)
    // A model of unknown window: exactly as before.
    expect(modelSelectionFromSpec({ ...specFor('claude-haiku-4-5-20251001', 'off', false), model: 'acme/mystery-1' } as never)).toBe('acme/mystery-1')
  })

  it('caps the window at 600K and keeps a smaller one', () => {
    for (const [window, handed] of [[1_000_000, 600_000], [200_000, 200_000], [200_000, 200_000]]) {
      const spec = { ...specFor('claude-haiku-4-5-20251001', 'on', false), modelPolicy: { contextWindowTokens: window } }
      expect(modelSelectionFromSpec(spec as never)).toEqual({ model: 'anthropic/claude-haiku-4.5', modelContextWindowTokens: handed })
    }
  })

  it('a malformed policy is dropped field by field, never thrown on', () => {
    const spec = { ...specFor('deepseek-v4-flash', 'off', false), modelPolicy: { reasoning: 'max', contextWindowTokens: 0 } }
    expect(modelSelectionFromSpec(spec as never)).toEqual({ model: 'deepseek/deepseek-v4-flash', modelContextWindowTokens: 600_000 })
  })
})
