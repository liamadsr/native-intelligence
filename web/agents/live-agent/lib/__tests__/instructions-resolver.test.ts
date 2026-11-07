import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LiveAgentSpec } from '../spec-client'

/**
 * instructions/live-turn.ts — the LAST hop of the byte-identical system prompt.
 * live-agent-spec-parity.test.ts proves the spec's systemPrompt equals the cloud
 * route's; this proves the resolver hands that string to eve UNCHANGED (no
 * trim, no wrapper, the right field) and resolves nothing without one.
 */
const fetchLiveAgentSpec = vi.fn<(t: string) => Promise<LiveAgentSpec | null>>()

vi.mock('../spec-client', async () => {
  const actual = await vi.importActual<typeof import('../spec-client')>('../spec-client')
  return {
    ...actual,
    fetchLiveAgentSpec: (t: string) => fetchLiveAgentSpec(t),
    // runTokenFromAuth stays REAL, so the token is read off the right path.
  }
})

import liveTurn from '../../instructions/live-turn'

type Resolver = { events: Record<string, (e: unknown, ctx: { session: { auth: unknown } }) => Promise<unknown>> }
const resolver = liveTurn as unknown as Resolver
const ctx = { session: { auth: { current: { attributes: { runToken: 'tok.sig' } } } } }

function spec(systemPrompt: string): LiveAgentSpec {
  return {
    systemPrompt,
    model: 'deepseek/deepseek-v4-flash',
    ceiling: [],
    ceilingTools: [],
    coreToolNames: [],
    assistOnly: false,
    pairNotes: false,
    webAccess: true,
  }
}

beforeEach(() => fetchLiveAgentSpec.mockReset())

describe('live-agent instructions resolver', () => {
  it('resolves once, at session.started', () => {
    expect(Object.keys(resolver.events)).toEqual(['session.started'])
  })

  it('returns the spec’s systemPrompt VERBATIM (whitespace and all)', async () => {
    const prompt = '\n  You are the live meeting agent.\n\n## Persona\n  - keep it short  \n\n'
    fetchLiveAgentSpec.mockResolvedValue(spec(prompt))
    const out = (await resolver.events['session.started']({}, ctx)) as { content: unknown }
    expect(out).not.toBeNull()
    expect(out.content).toBe(prompt)
    expect(fetchLiveAgentSpec).toHaveBeenCalledWith('tok.sig')
  })

  it('reads the run token off the session principal (no token → the client gets "")', async () => {
    fetchLiveAgentSpec.mockResolvedValue(null)
    await resolver.events['session.started']({}, { session: { auth: {} } })
    expect(fetchLiveAgentSpec).toHaveBeenCalledWith('')
  })

  it('is null without a spec or with an empty prompt', async () => {
    fetchLiveAgentSpec.mockResolvedValue(null)
    expect(await resolver.events['session.started']({}, ctx)).toBeNull()
    fetchLiveAgentSpec.mockResolvedValue(spec(''))
    expect(await resolver.events['session.started']({}, ctx)).toBeNull()
  })
})
