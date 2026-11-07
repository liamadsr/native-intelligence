import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatSpec } from '../spec-client'

/**
 * The frozen-context regression fix (2026-07-14 parity audit): the dynamic
 * instructions resolver originally subscribed to `session.started`, which fires
 * ONCE for the life of the durable eve session — so mid-conversation navigation
 * (the §4c CONTEXT SWITCH block, editor selection, chat files) never reached the
 * model after the first turn, even though the transport re-encoded the ctx on
 * every send. The cloud route rebuilt the prompt on every POST (= every turn).
 *
 * Invariants pinned here:
 *   1. The resolver subscribes to `turn.started` (per-turn, cloud parity) and
 *      NOT `session.started` (once-per-session, the regression).
 *   2. It fetches the spec WITH skills and the split prompt, and returns the
 *      rebuilt systemPrompt as system content.
 *   3. On a fetch failure it THROWS, so eve logs the skipped resolver. eve
 *      0.66.3 resets turn-scoped system instructions at every turn.started, so
 *      the turn runs without the persona either way (a throw does not keep the
 *      previous turn's prompt).
 *   4. The prompt it returns is measured for the event's turn
 *      (lib/context-parts.ts: the side panel's Context card); a failed fetch
 *      measures nothing.
 */

type Opts = { skills?: boolean; turnContext?: boolean }
const fetchChatSpec = vi.fn<(t: string, c: string, o?: Opts) => Promise<ChatSpec | null>>()

vi.mock('../spec-client', () => ({
  fetchChatSpec: (...a: [string, string, Opts?]) => fetchChatSpec(...a),
  runTokenFromAuth: () => 'tok.sig',
  turnCtxFromAuth: () => 'ENC_CTX',
}))

// The prompt's measured size (lib/context-parts.ts) lands in durable eve state: an in-memory store here.
const stateStore = new Map<string, unknown>()
vi.mock('eve/context', () => ({
  defineState: <T,>(name: string, initial: () => T) => ({
    get: () => (stateStore.has(name) ? (stateStore.get(name) as T) : initial()),
    update: (fn: (prev: T) => T) => {
      stateStore.set(name, fn(stateStore.has(name) ? (stateStore.get(name) as T) : initial()))
    },
  }),
}))

import persona from '../../instructions/persona'
import { STATIC_INSTRUCTIONS_TOKENS, STATIC_TOOLS_TOKENS, contextPartsFor } from '../context-parts'

type Resolver = {
  events: Record<string, (e: unknown, ctx: { session: { auth: unknown } }) => Promise<unknown>>
}
const resolver = persona as unknown as Resolver
const ctx = { session: { auth: {} } }

beforeEach(() => {
  vi.clearAllMocks()
  stateStore.clear()
})

describe('chat-agent persona instructions — turn-fresh resolution', () => {
  it('subscribes to turn.started (per-turn), not session.started (once-per-session)', () => {
    expect(Object.keys(resolver.events)).toEqual(['turn.started'])
  })

  it('returns the rebuilt systemPrompt (skills + split variant) each turn, as system content', async () => {
    fetchChatSpec.mockResolvedValue({
      systemPrompt: '## Active Agent: Closer\nprompt body',
      model: 'm',
      ceiling: null,
      ceilingTools: [],
      coreToolNames: [],
    })
    const out = (await resolver.events['turn.started']({}, ctx)) as { content: string; role?: string }
    expect(out.content).toBe('## Active Agent: Closer\nprompt body')
    expect(out.role).toBeUndefined()
    expect(fetchChatSpec).toHaveBeenCalledWith('tok.sig', 'ENC_CTX', { skills: true, turnContext: true })
  })

  it('THROWS on a spec-fetch failure, so eve logs the skipped resolver', async () => {
    fetchChatSpec.mockResolvedValue(null)
    await expect(resolver.events['turn.started']({}, ctx)).rejects.toThrow(
      /this turn runs without the conversation prompt/,
    )
  })

  it("records the prompt's size for the event's turn (the side panel's Context card), and nothing on a failed fetch", async () => {
    // 40 characters of prompt and a 40-character skills section.
    const systemPrompt = `${'p'.repeat(40)}\n\n## Available skills\n${'s'.repeat(18)}`
    fetchChatSpec.mockResolvedValue({ systemPrompt, model: 'm', ceiling: null, ceilingTools: [], coreToolNames: [] })
    await resolver.events['turn.started']({ type: 'turn.started', data: { turnId: 'turn_7' } }, ctx)
    expect(contextPartsFor('turn_7')).toEqual({ system: STATIC_INSTRUCTIONS_TOKENS + 10, skills: 10, tools: STATIC_TOOLS_TOKENS, memory: 0 })
    expect(contextPartsFor('turn_8')).toBeNull()

    fetchChatSpec.mockResolvedValue(null)
    await expect(resolver.events['turn.started']({ type: 'turn.started', data: { turnId: 'turn_8' } }, ctx)).rejects.toThrow()
    expect(contextPartsFor('turn_8')).toBeNull()
  })

  it('an event without a turn id records a prompt no turn reads', async () => {
    fetchChatSpec.mockResolvedValue({ systemPrompt: 'prompt', model: 'm', ceiling: null, ceilingTools: [], coreToolNames: [] })
    await resolver.events['turn.started']({ type: 'turn.started', data: {} }, ctx)
    expect(contextPartsFor('')).toBeNull()
    expect(contextPartsFor('turn_7')).toBeNull()
  })
})
