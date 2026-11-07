/**
 * CONTRACT test for the chat model selection against eve's shipped code (the
 * installed dist, not memory), in the style of the utility agent's
 * step-event-contract.test.ts.
 *
 * An invalid selection is terminal: eve fails the turn with
 * MODEL_SELECTION_FAILED and the durable chat dies. Every other test here feeds
 * hand-written selections to mocks, so this one runs what the resolver really
 * returns through eve's own resolveRuntimeModelSelection
 * (dist/src/runtime/agent/resolve-model.js), durable like the turn.started
 * lifecycle, and pins:
 *   1. the installed version this was reviewed at — a bump fails here first;
 *   2. every (model, level) policy, as the spec rebuilds send it
 *      (chatModelPolicy: the tiers' and the catalog's), with and without Gateway attribution, resolves: the
 *      reference keeps the catalog slug as its id (device-ask billing maps it
 *      back), the policy's window and reasoning, and exactly the provider
 *      options sent. eve never touches the Gateway catalog or its per-session
 *      metadata cache. DEFAULT_CHAT_POLICY, the Fast tier's, is among them;
 *   3. the spec-failure fallback (FALLBACK_SELECTION) resolves the same way;
 *   4. eve's per-step caching merge (harness/prompt-cache.js
 *      mergeGatewayAutoCaching) keeps the routing and attribution beside
 *      `caching: 'auto'`;
 *   5. the window is the policy's capped at CHAT_COMPACTION_WINDOW_TOKENS
 *      (250K, lib/compaction-window.ts), so eve's own compaction threshold
 *      (execution/session.js createCompactionConfig) lands at
 *      CHAT_MIDTURN_COMPACTION_TOKENS (225K) on a 1M or 262K model, and at 90%
 *      of a smaller model's own window.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import agent from '../../agent'
import { modelSelectionFromSpec, type ChatSpec, type ModelSelection } from '../spec-client'
import { CHAT_COMPACTION_WINDOW_TOKENS, chatCompactionWindow } from '../compaction-window'
import {
  CHAT_MODELS,
  DEFAULT_CHAT_POLICY,
  FLASH_CHAT_POLICY,
  MAIN_MODEL,
  THINKING_LEVELS,
  chatModelPolicy,
  gatewayModelSlug,
  type ChatModelId,
  type ChatModelPolicy,
  type ThinkingLevel,
} from '@/lib/ai/models'
import { tierPolicy } from '@/lib/ai/model-route'

const eveRoot = dirname(createRequire(import.meta.url).resolve('eve/package.json'))
const distFile = (rel: string) => join(eveRoot, 'dist/src', rel)
const load = async <T>(rel: string) => (await import(pathToFileURL(distFile(rel)).href)) as T

const REVIEWED_EVE_VERSION = '0.79.1'

vi.mock('eve/context', () => ({
  defineState: <T,>(_name: string, initial: () => T) => ({ get: initial, update: (fn: (value: T) => T) => fn(initial()) }),
}))

type Reference = {
  id: string
  contextWindowTokens?: number
  reasoning?: string
  providerOptions?: Record<string, Record<string, unknown>>
}
type ResolveRuntimeModelSelection = (args: {
  selection: unknown
  state: unknown
  catalog?: unknown
  durability: 'durable' | 'live'
}) => Promise<{ reference: Reference }>
type CreateCompactionConfig = (args: { contextWindowTokens?: number; thresholdPercent?: number }) => { threshold: number }
type MergeGatewayAutoCaching = (
  providerOptions: Record<string, Record<string, unknown>> | undefined,
) => Record<string, Record<string, unknown>>

/** eve's resolution of one selection, with a catalog and a state that record any use. */
async function resolveWithEve(selection: ModelSelection | null) {
  const { resolveRuntimeModelSelection } = await load<{ resolveRuntimeModelSelection: ResolveRuntimeModelSelection }>(
    'runtime/agent/resolve-model.js',
  )
  const catalog = { getByGatewayId: vi.fn(async () => null), getByProviderModelId: vi.fn(async () => null) }
  const state = { get: vi.fn(), set: vi.fn() }
  const { reference } = await resolveRuntimeModelSelection({ selection, state, catalog, durability: 'durable' })
  return { reference, catalog, state }
}

const TELEMETRY = { user: 'user-1', tags: ['feature:ai_chat', 'env:production', 'ws:ws-1', 'runtime:eve'] }

/**
 * The spec rebuildChatSpec sends for `id` at `level` (Light when omitted), as
 * the agent receives it (JSON).
 */
function specFor(id: ChatModelId, withTelemetry: boolean, level?: ThinkingLevel): ChatSpec {
  return JSON.parse(
    JSON.stringify({
      systemPrompt: 'p',
      model: gatewayModelSlug(id),
      ceiling: null,
      ceilingTools: [],
      coreToolNames: [],
      modelPolicy: chatModelPolicy(id, level ?? 'light'),
      ...(withTelemetry ? { gatewayTelemetry: TELEMETRY } : {}),
    }),
  )
}

/** Both levels of every model, with and without attribution. */
const CASES = CHAT_MODELS.flatMap((m) =>
  THINKING_LEVELS.flatMap((level) => [
    { id: m.id, level, withTelemetry: true },
    { id: m.id, level, withTelemetry: false },
  ]),
)

describe('eve model-selection contract (chat model policy)', () => {
  it(`is reviewed against eve ${REVIEWED_EVE_VERSION}`, () => {
    const { version } = JSON.parse(readFileSync(join(eveRoot, 'package.json'), 'utf8')) as { version: string }
    expect(
      version,
      'eve was bumped: re-verify the selection keys, reasoning values and providerOptions rules resolve-model.js accepts, and mergeGatewayAutoCaching, then update REVIEWED_EVE_VERSION',
    ).toBe(REVIEWED_EVE_VERSION)
  })

  it('covers both levels of every catalog model', () => {
    expect(CASES).toHaveLength(CHAT_MODELS.length * 2 * 2)
  })

  it.each(CASES)('$id at $level (telemetry: $withTelemetry): eve accepts the selection and keeps the policy', async ({ id, level, withTelemetry }) => {
    const selection = modelSelectionFromSpec(specFor(id, withTelemetry, level))
    const policy: ChatModelPolicy = chatModelPolicy(id, level)
    const { reference, catalog, state } = await resolveWithEve(selection)

    expect(reference.id).toBe(gatewayModelSlug(id))
    expect(reference.contextWindowTokens).toBe(chatCompactionWindow(policy.contextWindowTokens))
    expect(reference.reasoning).toBe(policy.reasoning)
    expect(reference.providerOptions).toEqual(typeof selection === 'object' ? selection?.modelOptions?.providerOptions : undefined)
    // The window rides the selection, so no per-session catalog download and no
    // metadata-cache entry for the chat model.
    expect(catalog.getByGatewayId).not.toHaveBeenCalled()
    expect(state.get).not.toHaveBeenCalled()
    expect(state.set).not.toHaveBeenCalled()

    // The selection's exact shape: only the keys eve's resolver accepts.
    const keys = ['model', 'modelContextWindowTokens']
    if (policy.reasoning) keys.push('reasoning')
    if (withTelemetry || policy.providerOptions || policy.gateway) keys.push('modelOptions')
    expect(Object.keys(selection as object).sort()).toEqual(keys.sort())
    if (id.startsWith('deepseek')) {
      // Provider options win over `reasoning`, and compaction reads only them:
      // the entry must say what the level says, never a leftover `disabled`.
      expect(reference.providerOptions?.deepseek).toEqual({
        thinking: { type: policy.reasoning === 'none' ? 'disabled' : 'enabled' },
      })
      expect(reference.providerOptions?.gateway).toMatchObject(policy.gateway ?? {})
    } else {
      expect(reference.providerOptions?.deepseek).toBeUndefined()
    }
  })

  it('Sonnet resolves to the 200K window every host serves without the context-1m beta, not the catalog 1M', async () => {
    // eve compacts at 90% of the reference window (harness/tool-loop.js
    // updateCompactionThresholdForModelReference): 180K here. At the catalog's
    // 1M it would wait until 900K, long after the host rejected the prompt.
    const { reference, catalog } = await resolveWithEve(
      modelSelectionFromSpec(specFor('claude-sonnet-4-5-20250929', true)),
    )
    expect(reference).toMatchObject({ id: 'anthropic/claude-sonnet-4.5', contextWindowTokens: 200_000 })
    expect(reference.reasoning).toBeUndefined()
    expect(catalog.getByGatewayId).not.toHaveBeenCalled()
  })

  it('the Strong tier (Sonnet 5.5) resolves to its 1M window, capped at 600K, with no reasoning (Sonnet 5.5 refuses thinking off)', async () => {
    const policy = tierPolicy('strong')
    const { reference, catalog } = await resolveWithEve(
      modelSelectionFromSpec(JSON.parse(JSON.stringify({ systemPrompt: 'p', model: 'anthropic/claude-sonnet-5.5', ceiling: null, ceilingTools: [], coreToolNames: [], modelPolicy: policy }))),
    )
    expect(reference).toMatchObject({ id: 'anthropic/claude-sonnet-5.5', contextWindowTokens: CHAT_COMPACTION_WINDOW_TOKENS })
    expect(reference.reasoning).toBeUndefined()
    expect(catalog.getByGatewayId).not.toHaveBeenCalled()
  })

  it('the spec-failure fallback resolves too: the thread\'s Haiku 5.5, the window, no reasoning, no catalog lookup', async () => {
    // No run token on the principal: fetchChatSpec answers null without fetching.
    const resolver = (agent as unknown as {
      model: { events: Record<string, (e: unknown, ctx: { session: { auth: unknown } }) => Promise<ModelSelection>> }
    }).model
    const fallback = await resolver.events['turn.started']({}, { session: { auth: {} } })
    const { reference, catalog } = await resolveWithEve(fallback)
    expect(reference).toMatchObject({
      id: 'anthropic/claude-haiku-5.5',
      contextWindowTokens: chatCompactionWindow(DEFAULT_CHAT_POLICY.contextWindowTokens),
    })
    expect(reference.reasoning).toBeUndefined()
    expect(reference.providerOptions?.deepseek).toBeUndefined()
    expect(DEFAULT_CHAT_POLICY).toEqual(chatModelPolicy(MAIN_MODEL, 'light'))
    expect(catalog.getByGatewayId).not.toHaveBeenCalled()
  })

  it("the plain helper's Flash fallback resolves too: Flash at Light (thinking on), the window", async () => {
    const { FLASH_FALLBACK_SELECTION } = await import('../helper-models')
    const { reference, catalog } = await resolveWithEve(FLASH_FALLBACK_SELECTION)
    expect(reference).toMatchObject({ id: 'deepseek/deepseek-v4-flash', contextWindowTokens: CHAT_COMPACTION_WINDOW_TOKENS, reasoning: 'high' })
    expect(reference.providerOptions?.deepseek).toEqual({ thinking: { type: 'enabled' } })
    expect(FLASH_CHAT_POLICY).toEqual(tierPolicy('fast'))
    expect(catalog.getByGatewayId).not.toHaveBeenCalled()
  })

  it.each([
    ['a 1M model (DeepSeek V4 Flash)', 'deepseek-v4-flash', 225_000],
    ['a 200K model (Claude Haiku 4.5)', 'claude-haiku-4-5-20251001', 180_000],
  ] as const)("eve's own compaction threshold for %s is 90%% of the capped window", async (_label, id, threshold) => {
    const { createCompactionConfig } = await load<{ createCompactionConfig: CreateCompactionConfig }>('execution/session.js')
    const { reference } = await resolveWithEve(modelSelectionFromSpec(specFor(id, true)))
    expect(reference.contextWindowTokens).toBe(Math.min(chatModelPolicy(id, 'light').contextWindowTokens, CHAT_COMPACTION_WINDOW_TOKENS))
    expect(createCompactionConfig({ contextWindowTokens: reference.contextWindowTokens }).threshold).toBe(threshold)
  })

  it("eve's per-step caching merge keeps the routing and attribution beside caching:'auto'", async () => {
    const { mergeGatewayAutoCaching } = await load<{ mergeGatewayAutoCaching: MergeGatewayAutoCaching }>(
      'harness/prompt-cache.js',
    )
    const { reference } = await resolveWithEve(modelSelectionFromSpec(specFor('deepseek-v4-pro', true)))
    const merged = mergeGatewayAutoCaching(reference.providerOptions)
    expect(merged.gateway).toEqual({ ...TELEMETRY, ...chatModelPolicy('deepseek-v4-pro', 'light').gateway, caching: 'auto' })
    expect(merged.deepseek).toEqual({ thinking: { type: 'enabled' } })
  })

  it('the harness is live: eve rejects what validModelPolicy drops', async () => {
    await expect(resolveWithEve({ model: 'deepseek/deepseek-v4-flash', reasoning: 'max' } as never)).rejects.toThrow(
      /reasoning/,
    )
    await expect(
      resolveWithEve({ model: 'deepseek/deepseek-v4-flash', modelContextWindowTokens: 0 } as never),
    ).rejects.toThrow(/modelContextWindowTokens/)
    await expect(
      resolveWithEve({ model: 'deepseek/deepseek-v4-flash', modelContextWindowTokens: 1, gateway: {} } as never),
    ).rejects.toThrow(/unknown key/)
    await expect(
      resolveWithEve({
        model: 'deepseek/deepseek-v4-flash',
        modelContextWindowTokens: 1,
        modelOptions: { providerOptions: { deepseek: 'off' } },
      } as never),
    ).rejects.toThrow(/JSON-serializable object/)
  })
})
