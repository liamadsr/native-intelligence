import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Eval web isolation FAILS CLOSED, end to end through the REAL spec client
 * (only eve's state store is stubbed). An eval turn is known to be one on the
 * eve side only through its spec (`webAccess: false`), and the authored
 * web_search (Exa) is live by default — so when the spec fetch itself fails (a
 * 5xx, a rejected fetch, a missing secret), the workspace_tools resolver must
 * still shadow it with a refusal on session.started AND step.started, and build
 * nothing else. (web_fetch is disabled on this mount outright.)
 */
const stateStore = new Map<string, unknown>()
vi.mock('eve/context', () => ({
  defineState: <T,>(name: string, initial: () => T) => ({
    get: () => (stateStore.has(name) ? (stateStore.get(name) as T) : initial()),
    update: (fn: (prev: T) => T) => {
      stateStore.set(name, fn(stateStore.has(name) ? (stateStore.get(name) as T) : initial()))
    },
  }),
}))

import workspaceTools from '../../tools/workspace_tools'
import { resetLiveAgentSpecCache } from '../spec-client'

type ToolFn = { execute: (i: unknown) => unknown }
type Resolver = {
  events: Record<string, (e: unknown, ctx: { session: { auth: unknown } }) => Promise<Record<string, ToolFn> | null>>
}
const ws = workspaceTools as unknown as Resolver
const ctx = { session: { auth: { current: { attributes: { runToken: 'tok.sig' } } } } }

const ENV_KEYS = ['LIVE_AGENT_INTERNAL_SECRET', 'RUN_SKILL_INTERNAL_SECRET', 'NEXT_PUBLIC_APP_URL'] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  stateStore.clear()
  resetLiveAgentSpecCache()
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  process.env.LIVE_AGENT_INTERNAL_SECRET = 'secret'
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** A spec that WOULD turn web on — what a fetch sent without a secret must never get to apply. */
const WEB_ON_SPEC = {
  systemPrompt: 'P',
  model: 'm/x',
  ceiling: [],
  ceilingTools: [],
  coreToolNames: [],
  assistOnly: false,
  pairNotes: false,
  webAccess: true,
}

/** [label, arrange → the stubbed fetch, whether that fetch may be called at all] */
const failures: Array<[string, () => ReturnType<typeof vi.fn>, boolean]> = [
  [
    'a 503 from the spec route',
    () => {
      const f = vi.fn(async () => new Response('down', { status: 503 }))
      vi.stubGlobal('fetch', f)
      return f
    },
    true,
  ],
  [
    'a network error (rejected fetch)',
    () => {
      const f = vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      })
      vi.stubGlobal('fetch', f)
      return f
    },
    true,
  ],
  [
    'no internal secret configured',
    () => {
      delete process.env.LIVE_AGENT_INTERNAL_SECRET
      delete process.env.RUN_SKILL_INTERNAL_SECRET
      // Answers 200 with web ON: if the request went out without the secret,
      // web would go live and this case would fail — not just the call count.
      const f = vi.fn(async () => Response.json(WEB_ON_SPEC))
      vi.stubGlobal('fetch', f)
      return f
    },
    false,
  ],
]

describe('live-agent web access fails closed when the spec cannot be fetched', () => {
  it.each(failures)('%s → web_search resolves to a refusal, nothing else', async (_label, arrange, mayFetch) => {
    const fetchStub = arrange()
    stateStore.set('live-agent.discovered-tools', ['list_milestones'])
    for (const event of ['session.started', 'step.started']) {
      const tools = await ws.events[event]({}, ctx)
      expect(Object.keys(tools ?? {}).sort(), event).toEqual(['web_search'])
      const out = (await tools!.web_search.execute({ query: 'q' })) as { error?: string }
      expect(out.error, event).toMatch(/Web access is disabled/)
    }
    if (mayFetch) expect(fetchStub).toHaveBeenCalled()
    else expect(fetchStub).not.toHaveBeenCalled()
  })
})
