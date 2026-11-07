/**
 * lib/model-policy.ts exists once per agent that takes a spec model policy
 * (the eve bundler can't share code across agents). The copies must stay
 * identical apart from comments; normalization is url-guard-drift.test.ts's.
 *
 * Also pins the agent with a static model (onboarding-researcher's Gateway
 * selection: a free user's research runs on their plan instead) to the
 * Next-side policy it copies by hand, and runs it through eve's own
 * resolveRuntimeModelSelection.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, it, expect, vi } from 'vitest'
import { COMPACTION_WINDOW_TOKENS, KNOWN_CONTEXT_WINDOWS, selectionWithPolicy, validModelPolicy, withCompactionWindowFor } from '../model-policy'
import { GATEWAY_SELECTION as onboardingResearcher } from '../../../onboarding-researcher/lib/model'
import { CHAT_MODELS, DEFAULT_MODEL, chatModelPolicy, deepseekSurfacePolicy, gatewayModelSlug } from '@/lib/ai/models'

const AGENTS = ['chat-agent', 'live-agent', 'skill-runner', 'work-agent'] as const
const AGENTS_ROOT = new URL('../../../', import.meta.url)

function read(agent: string): string {
  return readFileSync(fileURLToPath(new URL(`${agent}/lib/model-policy.ts`, AGENTS_ROOT)), 'utf8')
}

function normalize(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('agents/*/lib/model-policy.ts', () => {
  const canonical = normalize(read('chat-agent'))

  it('the chat-agent original survives normalization', () => {
    expect(canonical).toContain('export function validModelPolicy')
    expect(canonical).toContain('export function selectionWithPolicy')
    expect(canonical.length).toBeGreaterThan(2000)
  })

  for (const agent of AGENTS.filter((a) => a !== 'chat-agent')) {
    it(`${agent} matches the chat-agent original (comments aside)`, () => {
      expect(normalize(read(agent))).toBe(canonical)
    })
  }
})

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

describe.each([
  ['onboarding-researcher', onboardingResearcher],
])('%s: a static model at chat’s Light', (_name, agent) => {
  const { model, reasoning, modelContextWindowTokens, modelOptions } = agent as unknown as Record<string, unknown>
  const selection = { model, reasoning, modelContextWindowTokens, modelOptions }

  it('is the default model with thinking off, on the private hosts (deepseekSurfacePolicy off)', () => {
    expect(selection).toEqual(selectionWithPolicy(gatewayModelSlug(DEFAULT_MODEL), null, validModelPolicy(deepseekSurfacePolicy(DEFAULT_MODEL, 'off'))))
  })

  it('resolves through eve with that window, thinking off, and no catalog lookup', async () => {
    const reference = await resolveWithEve(selection)
    expect(reference).toMatchObject({ id: 'deepseek/deepseek-v4-flash', reasoning: 'none', contextWindowTokens: 1_000_000 })
    expect(reference.providerOptions).toMatchObject({ deepseek: { thinking: { type: 'disabled' } } })
  })
})

describe('KNOWN_CONTEXT_WINDOWS (the compaction ceiling for every model)', () => {
  it('lists every chat model by its Gateway slug, with the window chatModelPolicy gives it', () => {
    expect(Object.keys(KNOWN_CONTEXT_WINDOWS).sort()).toEqual(CHAT_MODELS.map((m) => m.gatewayId).sort())
    for (const m of CHAT_MODELS) expect(KNOWN_CONTEXT_WINDOWS[m.gatewayId]).toBe(chatModelPolicy(m.id, 'light').contextWindowTokens)
  })

  it('a non-DeepSeek 1M model with no policy compacts at the 600K ceiling; a smaller one keeps its own window', () => {
    expect(withCompactionWindowFor('anthropic/claude-sonnet-5.5', null)).toEqual({ contextWindowTokens: COMPACTION_WINDOW_TOKENS })
    expect(withCompactionWindowFor('anthropic/claude-haiku-4.5', { reasoning: 'low' })).toEqual({ reasoning: 'low', contextWindowTokens: 200_000 })
    // The policy's own window wins (still capped); an unknown model is left to eve.
    expect(withCompactionWindowFor('anthropic/claude-sonnet-5.5', { contextWindowTokens: 200_000 })).toEqual({ contextWindowTokens: 200_000 })
    expect(withCompactionWindowFor('acme/mystery-1', null)).toBeNull()
  })
})
