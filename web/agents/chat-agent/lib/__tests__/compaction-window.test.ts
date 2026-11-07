/**
 * When the main chat compacts (lib/compaction-window.ts): the target, eve's
 * in-turn threshold derived from it, the conversations it reaches, the
 * app-side mirror, and eve's own trigger run against the installed dist.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  CHAT_COMPACTION_TARGET_TOKENS,
  CHAT_COMPACTION_WINDOW_TOKENS,
  CHAT_MIDTURN_COMPACTION_TOKENS,
  EVE_COMPACTION_THRESHOLD_PERCENT,
  chatCompactionWindow,
  chatMidturnThreshold,
  withChatCompactionWindowFor,
} from '../compaction-window'
import { COMPACTION_THRESHOLD_PERCENT, COMPACTION_WINDOW_TOKENS, KNOWN_CONTEXT_WINDOWS } from '../model-policy'
import { modelSelectionFromSpec, type ChatSpec } from '../spec-client'
import agent from '../../agent'
import helper from '../../subagents/helper/agent'
import liveAgent from '../../../live-agent/agent'
import skillRunner from '../../../skill-runner/agent'
import workAgent from '../../../work-agent/agent'
import { CHAT_MODELS, chatModelPolicy, gatewayModelSlug } from '@/lib/ai/models'
import {
  CHAT_COMPACT_AT_PERCENT,
  CHAT_IDLE_COMPACT_TOKENS,
  CHAT_MIDTURN_COMPACT_TOKENS,
  CHAT_WORKING_WINDOW_TOKENS,
  contextFromRows,
  modelWindowTokens,
  workingWindowTokens,
} from '@/lib/chat/context-usage'

vi.mock('eve/context', () => ({
  defineState: <T,>(_name: string, initial: () => T) => ({ get: initial, update: (fn: (value: T) => T) => fn(initial()) }),
}))

const eveRoot = dirname(createRequire(import.meta.url).resolve('eve/package.json'))
const load = async <T,>(rel: string) => (await import(pathToFileURL(join(eveRoot, 'dist/src', rel)).href)) as T

type Message = { role: 'user' | 'assistant'; content: string }
type CompactionConfig = {
  recentWindowSize: number
  threshold: number
  lastKnownInputTokens?: number
  lastKnownPromptMessageCount?: number
}
type ShouldCompact = (messages: Message[], config: CompactionConfig) => boolean
type CreateCompactionConfig = (args: { contextWindowTokens?: number; thresholdPercent?: number }) => CompactionConfig
type AgentConfig = { compaction?: { thresholdPercent?: number; model?: unknown; modelContextWindowTokens?: number } }
type NormalizeAgentDefinition = (value: unknown, label: string) => AgentConfig

describe('the chat compaction target', () => {
  it('is 150K, and eve compacts inside a turn at half again (225K, a 250K window at its 90%)', () => {
    expect(CHAT_COMPACTION_TARGET_TOKENS).toBe(150_000)
    expect(CHAT_MIDTURN_COMPACTION_TOKENS).toBe(225_000)
    expect(CHAT_COMPACTION_WINDOW_TOKENS).toBe(250_000)
    // Well under the shared 600K ceiling the other agents keep (a 1M model compacted at 540K).
    expect(CHAT_COMPACTION_WINDOW_TOKENS).toBeLessThan(COMPACTION_WINDOW_TOKENS)
  })

  it.each([
    ['1M (DeepSeek V4 Flash)', 1_000_000, 250_000, 225_000],
    ['262K (Kimi K2.6)', 262_000, 250_000, 225_000],
    ['200K (Claude)', 200_000, 200_000, 180_000],
  ])('hands eve the smaller of a %s window and 250K', (_label, real, window, threshold) => {
    expect(chatCompactionWindow(real)).toBe(window)
    expect(chatMidturnThreshold(real)).toBe(threshold)
  })

  it('leaves an unknown window unknown', () => {
    expect(chatCompactionWindow(undefined)).toBeUndefined()
    expect(chatCompactionWindow(0)).toBeUndefined()
    expect(chatMidturnThreshold(undefined)).toBeUndefined()
    expect(withChatCompactionWindowFor('acme/mystery-1', null)).toBeNull()
    expect(withChatCompactionWindowFor('acme/mystery-1', { reasoning: 'none' })).toEqual({ reasoning: 'none' })
  })

  it("caps the policy's own window, else the model's known one", () => {
    expect(withChatCompactionWindowFor('deepseek/deepseek-v4-flash', { contextWindowTokens: 1_000_000, reasoning: 'none' })).toEqual({
      contextWindowTokens: 250_000,
      reasoning: 'none',
    })
    expect(withChatCompactionWindowFor('anthropic/claude-sonnet-5.5', null)).toEqual({ contextWindowTokens: 250_000 })
    expect(withChatCompactionWindowFor('anthropic/claude-haiku-4.5', null)).toEqual({ contextWindowTokens: 200_000 })
  })
})

describe('which conversations it reaches', () => {
  const specFor = (model: string, modelPolicy: unknown): ChatSpec =>
    JSON.parse(JSON.stringify({ systemPrompt: 'p', model, ceiling: null, ceilingTools: [], coreToolNames: [], modelPolicy }))

  it('every chat model, as the spec sends it, compacts inside a turn by 225K', () => {
    for (const m of CHAT_MODELS) {
      const selection = modelSelectionFromSpec(specFor(gatewayModelSlug(m.id), chatModelPolicy(m.id, 'light')))
      expect(typeof selection === 'object' && selection?.modelContextWindowTokens, m.id).toBe(
        chatCompactionWindow(chatModelPolicy(m.id, 'light').contextWindowTokens),
      )
    }
  })

  it('every known model without a policy window gets the chat window too', () => {
    for (const [slug, real] of Object.entries(KNOWN_CONTEXT_WINDOWS)) {
      const selection = modelSelectionFromSpec(specFor(slug, undefined))
      expect(typeof selection === 'object' && selection?.modelContextWindowTokens, slug).toBe(Math.min(real, 250_000))
    }
  })

  it("the spec-failure fallback and the quick helper's resolver use the same window", async () => {
    type Resolver = { events: Record<string, (e: unknown, ctx: { session: { auth: unknown } }) => Promise<unknown>> }
    const root = (agent as unknown as { model: Resolver }).model
    // No run token on the principal: fetchChatSpec answers null without fetching.
    expect(await root.events['turn.started']({}, { session: { auth: {} } })).toMatchObject({ modelContextWindowTokens: 250_000 })
    // The helper subagent runs on the root's resolver in the helper role
    // (subagents/helper/agent.ts, lib/chat-model.ts helperChatModel): the same fallback.
    const helperModel = (helper as unknown as { model: Resolver }).model
    expect(await helperModel.events['turn.started']({}, { session: { auth: {} } })).toMatchObject({ modelContextWindowTokens: 250_000 })
  })
})

describe('the app side mirrors the target', () => {
  it('idle-compaction.ts compacts at a turn boundary from the same 150K', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/chat/idle-compaction.ts'), 'utf8')
    const match = /export const IDLE_COMPACTION_MIN_INPUT_TOKENS = ([\d_]+)/.exec(src)
    expect(match, 'IDLE_COMPACTION_MIN_INPUT_TOKENS moved or was renamed').not.toBeNull()
    expect(Number(match![1].replace(/_/g, ''))).toBe(CHAT_COMPACTION_TARGET_TOKENS)
  })

  it("context-usage.ts (the side panel's Context card) twins every number its bar is drawn from", () => {
    expect(CHAT_IDLE_COMPACT_TOKENS).toBe(CHAT_COMPACTION_TARGET_TOKENS)
    expect(CHAT_COMPACT_AT_PERCENT).toBe(EVE_COMPACTION_THRESHOLD_PERCENT)
    expect(CHAT_MIDTURN_COMPACT_TOKENS).toBe(CHAT_MIDTURN_COMPACTION_TOKENS)
    expect(CHAT_WORKING_WINDOW_TOKENS).toBe(CHAT_COMPACTION_WINDOW_TOKENS)
    // And the idle compaction's own literal, the same 150K.
    const src = readFileSync(join(process.cwd(), 'src/lib/chat/idle-compaction.ts'), 'utf8')
    const match = /export const IDLE_COMPACTION_MIN_INPUT_TOKENS = ([\d_]+)/.exec(src)
    expect(Number(match![1].replace(/_/g, ''))).toBe(CHAT_IDLE_COMPACT_TOKENS)
  })

  it('every chat model: the card’s window and compaction line are the ones eve is handed', () => {
    for (const m of CHAT_MODELS) {
      const real = chatModelPolicy(m.id, 'light').contextWindowTokens
      expect(modelWindowTokens(m.id), m.id).toBe(real)
      expect(workingWindowTokens(modelWindowTokens(m.id)), m.id).toBe(chatCompactionWindow(real))
      const context = contextFromRows([{ model: m.id, created_at: '2026-10-22T10:00:00Z', metadata: { context_last_step_input_tokens: 1 } }])
      expect(context?.windowTokens, m.id).toBe(chatCompactionWindow(real))
      expect(context?.compactAtTokens, m.id).toBe(chatMidturnThreshold(real))
    }
  })
})

describe("eve's own trigger (installed dist)", () => {
  it('derives its threshold from the window we hand it', async () => {
    const { createCompactionConfig } = await load<{ createCompactionConfig: CreateCompactionConfig }>('execution/session.js')
    expect(createCompactionConfig({ contextWindowTokens: chatCompactionWindow(1_000_000) }).threshold).toBe(CHAT_MIDTURN_COMPACTION_TOKENS)
  })

  it("fires on the last call's provider-reported input past it, and not below", async () => {
    const { shouldCompact } = await load<{ shouldCompact: ShouldCompact }>('harness/compaction/engine.js')
    const history: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]
    const config = (lastKnownInputTokens: number): CompactionConfig => ({
      recentWindowSize: 10,
      threshold: CHAT_MIDTURN_COMPACTION_TOKENS,
      lastKnownInputTokens,
      lastKnownPromptMessageCount: history.length,
    })
    // The audit's conversation: calls at ~185K never reached the old 540K, and stay under 225K too
    // (the turn boundary, idle-compaction.ts, takes those).
    expect(shouldCompact(history, config(185_000))).toBe(false)
    expect(shouldCompact(history, config(CHAT_MIDTURN_COMPACTION_TOKENS + 1))).toBe(true)
    // The old ceiling would have let it run to 540K.
    expect(shouldCompact(history, { ...config(300_000), threshold: 540_000 })).toBe(false)
  })
})

// P11 (docs/plans/eve-alignment.md §5 row 9): the fraction the windows are
// derived from is set on the agents, not left to eve's default, and the
// summary stays on the turn's model (no compaction.model: it would lose the
// selection's Gateway host list). Behaviour is unchanged: 0.9 is eve's default.
describe('every windowed agent sets its compaction fraction explicitly', () => {
  const agents = [
    ['chat-agent', agent],
    ['live-agent', liveAgent],
    ['skill-runner', skillRunner],
    ['work-agent', workAgent],
  ] as const

  it('the fraction is eve 0.79.1’s default, so nothing moves today', async () => {
    const { createCompactionConfig } = await load<{ createCompactionConfig: CreateCompactionConfig }>('execution/session.js')
    expect(COMPACTION_THRESHOLD_PERCENT).toBe(0.9)
    expect(EVE_COMPACTION_THRESHOLD_PERCENT).toBe(COMPACTION_THRESHOLD_PERCENT)
    expect(createCompactionConfig({}).threshold).toBe(100_000)
    expect(createCompactionConfig({ contextWindowTokens: 1_000_000 }).threshold).toBe(
      createCompactionConfig({ contextWindowTokens: 1_000_000, thresholdPercent: COMPACTION_THRESHOLD_PERCENT }).threshold,
    )
  })

  it.each(agents)('%s sets compaction.thresholdPercent and no compaction model, and eve accepts it', async (name, def) => {
    const config = def as unknown as AgentConfig
    expect(config.compaction).toEqual({ thresholdPercent: COMPACTION_THRESHOLD_PERCENT })
    const { normalizeAgentDefinition } = await load<{ normalizeAgentDefinition: NormalizeAgentDefinition }>(
      'internal/authored-definition/core.js',
    )
    expect(normalizeAgentDefinition(def, `${name}/agent.ts`).compaction).toEqual({ thresholdPercent: COMPACTION_THRESHOLD_PERCENT })
  })

  it('the main chat has no lifetime input budget, and eve keeps it uncapped (no 40M default)', async () => {
    expect((agent as unknown as { limits?: unknown }).limits).toEqual({ maxInputTokensPerSession: false })
    const { normalizeAgentDefinition } = await load<{ normalizeAgentDefinition: NormalizeAgentDefinition }>(
      'internal/authored-definition/core.js',
    )
    const normalized = normalizeAgentDefinition(agent, 'chat-agent/agent.ts') as { limits?: { maxInputTokensPerSession?: unknown } }
    expect(normalized.limits?.maxInputTokensPerSession).toBe(false)
  })

  it('the chat target still lands where it did: 225K inside a turn on a 1M model', async () => {
    const { createCompactionConfig } = await load<{ createCompactionConfig: CreateCompactionConfig }>('execution/session.js')
    const thresholdPercent = (agent as unknown as AgentConfig).compaction?.thresholdPercent
    expect(createCompactionConfig({ contextWindowTokens: chatCompactionWindow(1_000_000), thresholdPercent }).threshold).toBe(
      CHAT_MIDTURN_COMPACTION_TOKENS,
    )
  })
})
