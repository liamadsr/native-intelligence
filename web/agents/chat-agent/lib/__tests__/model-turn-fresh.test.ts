import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatSpec } from '../spec-client'

/**
 * The mid-conversation model-switch fix (fix/mid-chat-model-switch): the dynamic
 * MODEL resolver originally subscribed to `session.started`, which eve fires ONCE
 * per durable session — so the picker value only took effect on turn 1 and every
 * later switch was silently ignored (the same regression the instructions
 * resolver had — see persona-turn-fresh.test.ts). The browser re-sends the picker
 * value every turn (ctx → spec route → rebuildChatSpec clamps + qualifies it), so
 * `turn.started` is the resolver that actually consumes it.
 *
 * Invariants pinned here:
 *   1. The resolver subscribes to `turn.started` (per-turn), NOT `session.started`.
 *   2. It returns modelSelectionFromSpec(spec) — a qualified passthrough for a
 *      non-Anthropic slug, and the Gateway-attribution OBJECT form when telemetry
 *      is present — so a mid-conversation switch reaches the model each turn.
 *   3. On a spec-fetch failure it RETURNS a concrete default (MAIN_MODEL, Haiku 5.5) — it must NOT
 *      throw and must NOT return null. GROUND TRUTH (eve 0.47.7):
 *      resolveRuntimeModelSelection (dist/src/runtime/agent/resolve-model.js)
 *      throws on a null/undefined selection, and dynamic-model-lifecycle rethrows
 *      any resolver error as DynamicModelSelectionError, which tool-loop turns
 *      into the TERMINAL step.failed → turn.failed → session.failed cascade. So a
 *      throw here would kill the durable chat session on a transient spec outage.
 *      That default carries the chat default's full model policy (its window),
 *      pinned below against the server constants, as does the plain helper's
 *      Flash fallback (thinking on, host routing, window).
 *   4. There is NO compiled `fallback` key any more — defineDynamic accepts only
 *      `{ build?, events }`. The default lives in the resolver (FALLBACK_SELECTION).
 */

const fetchChatSpec = vi.fn<(t: string, c: string) => Promise<ChatSpec | null>>()
const stateStore = new Map<string, unknown>()
vi.mock('eve/context', () => ({
  defineState: <T,>(name: string, initial: () => T) => ({
    get: () => stateStore.has(name) ? stateStore.get(name) as T : initial(),
    update: (fn: (prev: T) => T) => stateStore.set(name, fn(stateStore.has(name) ? stateStore.get(name) as T : initial())),
  }),
}))

// Mirrors persona-turn-fresh.test.ts: the resolver imports the REAL
// modelSelectionFromSpec (a pure mapping) from spec-client, so keep the actual
// module and stub only the fetch + auth readers. agent.ts imports
// './lib/spec-client.js' and this test '../spec-client' — both resolve to the
// same absolute module, so this mock intercepts the resolver's import.
vi.mock('../spec-client', async () => {
  const actual = await vi.importActual<typeof import('../spec-client')>('../spec-client')
  return {
    ...actual,
    fetchChatSpec: (...a: [string, string]) => fetchChatSpec(...a),
    runTokenFromAuth: () => 'tok.sig',
    turnCtxFromAuth: () => 'ENC_CTX',
  }
})

import agent from '../../agent'
import { modelSelectionFromSpec } from '../spec-client'
import { captureBrowserPermissionHandoff } from '../browser-permission-handoff'
import { DEFAULT_CHAT_POLICY, DEFAULT_MODEL, FLASH_CHAT_POLICY, MAIN_MODEL, chatModelPolicy, gatewayModelSlug } from '@/lib/ai/models'
import { FLASH_FALLBACK_SELECTION } from '../helper-models'
import { flashTurnFromRunToken } from '../chat-model'

type ModelResolver = {
  events: Record<string, (e: unknown, ctx: { session: { auth: unknown } }) => Promise<unknown>>
}
const model = (agent as unknown as { model: ModelResolver }).model
const ctx = { session: { auth: {} } }
const turnEvent = { data: { turnId: 'turn-1', sequence: 0, stepIndex: 1 } }

function spec(over: Partial<ChatSpec> = {}): ChatSpec {
  return {
    systemPrompt: 'p',
    model: 'anthropic/claude-haiku-4-5-20251001',
    ceiling: null,
    ceilingTools: [],
    coreToolNames: [],
    ...over,
  }
}

/** A server model policy as the agent receives it: JSON from the spec route. */
const onTheWire = (policy: unknown): ChatSpec['modelPolicy'] => JSON.parse(JSON.stringify(policy))

beforeEach(() => { vi.clearAllMocks(); stateStore.clear() })

describe('chat-agent model resolver — turn-fresh resolution', () => {
  it('subscribes to turn.started (per-turn), not session.started (once-per-session)', () => {
    expect(Object.keys(model.events)).toEqual(['turn.started', 'step.started'])
  })

  it('declares NO compiled fallback (eve 0.47.7 defineDynamic takes only build/events)', () => {
    expect(model).not.toHaveProperty('fallback')
  })

  it('returns the qualified slug for a non-Anthropic model each turn (mid-chat switch works)', async () => {
    fetchChatSpec.mockResolvedValue(spec({ model: 'deepseek/deepseek-v4-pro' }))
    const out = await model.events['turn.started'](turnEvent, ctx)
    // Its real window rides along: the compaction ceiling applies to every model.
    expect(out).toEqual({ model: 'deepseek/deepseek-v4-pro', modelContextWindowTokens: 250_000 })
    expect(fetchChatSpec).toHaveBeenCalledWith('tok.sig', 'ENC_CTX')
  })

  it('returns the Gateway-attribution object form when telemetry is present', async () => {
    fetchChatSpec.mockResolvedValue(
      spec({
        model: 'deepseek/deepseek-v4-flash',
        gatewayTelemetry: { user: 'user-1', tags: ['feature:ai_chat', 'runtime:eve'] },
      }),
    )
    const out = await model.events['turn.started'](turnEvent, ctx)
    expect(out).toEqual({
      model: 'deepseek/deepseek-v4-flash',
      modelContextWindowTokens: 250_000,
      modelOptions: { providerOptions: { gateway: { user: 'user-1', tags: ['feature:ai_chat', 'runtime:eve'] } } },
    })
  })

  it('returns the policy object form for a spec carrying a model policy', async () => {
    fetchChatSpec.mockResolvedValue(
      spec({ model: 'deepseek/deepseek-v4-pro', modelPolicy: onTheWire(chatModelPolicy('deepseek-v4-pro', 'light')) }),
    )
    const out = await model.events['turn.started'](turnEvent, ctx)
    // The 1M window is capped at the chat's 250K compaction window (lib/compaction-window.ts).
    expect(out).toMatchObject({ model: 'deepseek/deepseek-v4-pro', reasoning: 'high', modelContextWindowTokens: 250_000 })
  })

  it('RETURNS the default model on a spec-fetch failure (never throws — a throw kills the session)', async () => {
    fetchChatSpec.mockResolvedValue(null)
    const out = await model.events['turn.started'](turnEvent, ctx)
    expect(out).toMatchObject({ model: 'anthropic/claude-haiku-5.5' })
    // Haiku 5.5 runs adaptive thinking: no reasoning parameter at all.
    expect(out).not.toHaveProperty('reasoning')
  })

  it('the fallback is the chat default called with its full policy (drift lock against src/lib/ai)', async () => {
    // Agent code cannot import src/, so FALLBACK_SELECTION is a literal copy of
    // the thread's model (MAIN_MODEL) and its policy (DEFAULT_CHAT_POLICY). It must equal
    // what a spec for that model maps to, minus the Gateway attribution a failed
    // fetch cannot supply. A failure here means one side changed: update
    // FALLBACK_SELECTION in agents/chat-agent/lib/chat-model.ts.
    fetchChatSpec.mockResolvedValue(null)
    const expected = modelSelectionFromSpec(
      spec({ model: gatewayModelSlug(MAIN_MODEL), modelPolicy: onTheWire(DEFAULT_CHAT_POLICY) }),
    )
    expect(typeof expected).toBe('object')
    await expect(model.events['turn.started'](turnEvent, ctx)).resolves.toEqual(expected)
  })

  it('a device ask or a guest\'s turn falls to Flash on a spec outage, never to the thread\'s Haiku', () => {
    const tok = (claims: object) => `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`
    expect(flashTurnFromRunToken(tok({ conversationId: 'c', surface: 'device_ask' }))).toBe(true)
    expect(flashTurnFromRunToken(tok({ conversationId: 'c', guestId: 'g1', surface: 'sms' }))).toBe(true)
    expect(flashTurnFromRunToken(tok({ conversationId: 'c', surface: 'slack' }))).toBe(false)
    expect(flashTurnFromRunToken(tok({ conversationId: 'c' }))).toBe(false)
    expect(flashTurnFromRunToken('garbage')).toBe(false)
  })

  it("the plain helper's fallback is Flash called with its full policy (drift lock against src/lib/ai)", () => {
    // FLASH_FALLBACK_SELECTION (lib/helper-models.ts) is a literal copy of Flash
    // at Light (FLASH_CHAT_POLICY): thinking on in both encodings, the private
    // hosts, and the capped window.
    const expected = modelSelectionFromSpec(spec({ model: gatewayModelSlug(DEFAULT_MODEL), modelPolicy: onTheWire(FLASH_CHAT_POLICY) }))
    expect(FLASH_FALLBACK_SELECTION).toEqual(expected)
  })

  it('keeps the selected Max policy across steps without another spec fetch', async () => {
    fetchChatSpec.mockResolvedValue(spec({ model: 'deepseek/deepseek-v4-flash', modelPolicy: {
      reasoning: 'xhigh', contextWindowTokens: 1_000_000,
      providerOptions: { deepseek: { thinking: { type: 'enabled' } } }, gateway: { only: ['wafer', 'alibaba'] },
    } }))
    await model.events['turn.started'](turnEvent, ctx)
    fetchChatSpec.mockResolvedValue(null)
    const step = await model.events['step.started'](turnEvent, ctx)
    expect(step).toMatchObject({ reasoning: 'xhigh', modelContextWindowTokens: 250_000,
      modelOptions: { providerOptions: { deepseek: { thinking: { type: 'enabled' } }, gateway: { only: ['wafer', 'alibaba'] } } },
    })
    expect(fetchChatSpec).toHaveBeenCalledTimes(1)
  })
})


describe('browser permission handoff through the model resolver', () => {
  it('stops every selected model on a blocked site and restores it next user turn', async () => {
    fetchChatSpec.mockResolvedValue(spec({ model: 'deepseek/deepseek-v4-pro' }))
    await model.events['turn.started'](turnEvent, ctx)
    captureBrowserPermissionHandoff({ turnId: 'turn-1', toolName: 'run_browser_task', input: {},
      output: { success: true, result: { status: 'escalate', reason: 'site_blocked', blockedSite: 'linkedin.com' } } })
    const blocked = await model.events['step.started'](turnEvent, ctx)
    expect(blocked).toMatchObject({ model: { provider: 'deepseek', modelId: 'deepseek-v4-pro' } })
    expect(fetchChatSpec).toHaveBeenCalledTimes(1)
    const nextTurn = { data: { turnId: 'turn-2' } }
    await model.events['turn.started'](nextTurn, ctx)
    expect(await model.events['step.started'](nextTurn, ctx)).toEqual({ model: 'deepseek/deepseek-v4-pro', modelContextWindowTokens: 250_000 })
  })

  it('lets the model answer from an uncertain browser result, but ends the turn on a user Stop', async () => {
    fetchChatSpec.mockResolvedValue(spec({ model: 'deepseek/deepseek-v4-pro' }))
    await model.events['turn.started'](turnEvent, ctx)
    captureBrowserPermissionHandoff({ turnId: 'turn-1', toolName: 'run_browser_task', input: {},
      output: { success: true, result: { status: 'escalate', reason: 'uncertain' } } })
    expect(await model.events['step.started'](turnEvent, ctx)).toEqual({ model: 'deepseek/deepseek-v4-pro', modelContextWindowTokens: 250_000 })
    captureBrowserPermissionHandoff({ turnId: 'turn-1', toolName: 'run_browser_task', input: {},
      output: { success: true, result: { status: 'cancelled', reason: 'user_stopped' } } })
    expect(await model.events['step.started'](turnEvent, ctx)).toMatchObject({ model: { provider: 'deepseek', modelId: 'deepseek-v4-pro' } })
  })
})
