import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LiveAgentSpec } from '../spec-client'

/**
 * The live-agent's tool resolvers (tools/workspace_tools.ts, ask_user.ts,
 * say_to_user.ts). Invariants:
 *   1. session.started advertises ONLY the spec's coreToolNames + native
 *      search_tools — never the full ceiling;
 *   2. ask_user / say_to_user are never proxied here; their own resolvers exist
 *      ONLY when the turn's ceiling holds them (never on a notes turn);
 *   3. search_tools reveals only ceiling tools, records them in state, and the
 *      NEXT step.started advertises them;
 *   4. nothing outside spec.ceilingTools is ever built;
 *   5. web_search / web_fetch are never proxied — but on a turn with NO web
 *      access web_search is shadowed by a refusal stub (eval isolation);
 *      web_fetch is disabled outright on this mount (tools/web_fetch.ts);
 *   6. every proxy dispatches dispatchLiveAgentTool(name, runToken, input);
 *   7. no spec → no workspace tools and no search_tools — but web FAILS
 *      CLOSED: web_search is still shadowed by a refusal, because the only
 *      thing marking an eval turn on the eve side is its spec.
 */
const stateStore = new Map<string, unknown>()
vi.mock('eve/context', () => ({
  defineState: <T,>(name: string, initial: () => T) => ({
    get: () => (stateStore.has(name) ? (stateStore.get(name) as T) : initial()),
    update: (fn: (prev: T) => T) => {
      const prev = stateStore.has(name) ? (stateStore.get(name) as T) : initial()
      stateStore.set(name, fn(prev))
    },
  }),
}))

const fetchLiveAgentSpec = vi.fn<(t: string) => Promise<LiveAgentSpec | null>>()
const dispatchLiveAgentTool = vi.fn<(n: string, t: string, i: unknown) => Promise<unknown>>(async () => ({ ok: true }))

vi.mock('../spec-client', () => ({
  fetchLiveAgentSpec: (t: string) => fetchLiveAgentSpec(t),
  dispatchLiveAgentTool: (n: string, t: string, i: unknown) => dispatchLiveAgentTool(n, t, i),
  runTokenFromAuth: () => 'tok.sig',
}))

import workspaceTools from '../../tools/workspace_tools'
import askUser from '../../tools/ask_user'
import sayToUser from '../../tools/say_to_user'

type ToolFn = { description?: string; execute: (i: unknown) => unknown }
type Resolver = {
  events: Record<string, (e: unknown, ctx: { session: { auth: unknown } }) => Promise<Record<string, ToolFn> | ToolFn | null>>
}
const ws = workspaceTools as unknown as Resolver
const ctx = { session: { auth: {} } }

function t(name: string, description = `${name} tool`) {
  return { name, description, inputSchema: { type: 'object' } as const }
}

/** A copilot turn: staging + reads; core is small, the ceiling larger. */
function copilotSpec(over: Partial<LiveAgentSpec> = {}): LiveAgentSpec {
  const ceiling = ['propose_change', 'say_to_user', 'ask_user', 'write_summary', 'find', 'list_actions', 'list_milestones', 'get_package']
  return {
    systemPrompt: 'p',
    model: 'deepseek/deepseek-v4-flash',
    ceiling,
    ceilingTools: ceiling.map((n) => t(n, n === 'list_milestones' ? 'List milestones for a project' : `${n} tool`)),
    coreToolNames: ['propose_change', 'say_to_user', 'ask_user', 'write_summary', 'find', 'list_actions'],
    assistOnly: false,
    pairNotes: false,
    webAccess: true,
    ...over,
  }
}

async function resolve(event: 'session.started' | 'step.started', spec: LiveAgentSpec | null) {
  fetchLiveAgentSpec.mockResolvedValue(spec)
  return (await ws.events[event]({}, ctx)) as Record<string, ToolFn> | null
}

beforeEach(() => {
  stateStore.clear()
  fetchLiveAgentSpec.mockReset()
  dispatchLiveAgentTool.mockClear()
})

describe('workspace_tools', () => {
  it('advertises core proxies + search_tools at session start — not the whole ceiling', async () => {
    const tools = await resolve('session.started', copilotSpec())
    expect(Object.keys(tools!).sort()).toEqual(['find', 'list_actions', 'propose_change', 'search_tools', 'write_summary'])
    expect(fetchLiveAgentSpec).toHaveBeenCalledWith('tok.sig')
  })

  it('never proxies ask_user / say_to_user / search_tools / web tools', async () => {
    const spec = copilotSpec()
    spec.coreToolNames.push('web_search', 'web_fetch', 'search_tools')
    spec.ceilingTools.push(t('web_search'), t('web_fetch'))
    const tools = await resolve('session.started', spec)
    for (const name of ['ask_user', 'say_to_user', 'web_search', 'web_fetch']) expect(tools).not.toHaveProperty(name)
    // search_tools is the NATIVE one (typed query input), not a proxy.
    await tools!.search_tools.execute({ query: 'zzz-nothing' })
    expect(dispatchLiveAgentTool).not.toHaveBeenCalled()
  })

  it('each proxy dispatches (name, runToken, input)', async () => {
    const tools = await resolve('session.started', copilotSpec())
    await tools!.propose_change.execute({ change_type: 'create' })
    expect(dispatchLiveAgentTool).toHaveBeenCalledWith('propose_change', 'tok.sig', { change_type: 'create' })
  })

  it('search_tools reveals ceiling tools and the NEXT step advertises them', async () => {
    const spec = copilotSpec()
    const tools = await resolve('session.started', spec)
    fetchLiveAgentSpec.mockResolvedValue(spec)
    const found = (await tools!.search_tools.execute({ query: 'milestones' })) as { tools: Array<{ name: string }> }
    expect(found.tools.map((x) => x.name)).toContain('list_milestones')
    const next = await resolve('step.started', spec)
    expect(next).toHaveProperty('list_milestones')
  })

  it('discovery can never widen the ceiling', async () => {
    const spec = copilotSpec()
    const tools = await resolve('session.started', spec)
    fetchLiveAgentSpec.mockResolvedValue(spec)
    const found = (await tools!.search_tools.execute({ query: 'create action update' })) as { tools: Array<{ name: string }> }
    expect(found.tools.map((x) => x.name)).not.toContain('create_action')
    // Even a name forced into state is dropped if the ceiling doesn't hold it.
    stateStore.set('live-agent.discovered-tools', ['create_action', 'accept_proposal'])
    const next = await resolve('step.started', spec)
    expect(next).not.toHaveProperty('create_action')
    expect(next).not.toHaveProperty('accept_proposal')
  })

  it('shadows web_search with a refusal on a turn with NO web access (web_fetch is never minted)', async () => {
    for (const event of ['session.started', 'step.started'] as const) {
      const tools = await resolve(event, copilotSpec({ webAccess: false }))
      expect(tools, `${event} web_search`).toHaveProperty('web_search')
      expect(tools, `${event} web_fetch`).not.toHaveProperty('web_fetch')
      const out = (await tools!.web_search.execute({ query: 'x' })) as { error: string }
      expect(out.error).toMatch(/Web access is disabled/)
    }
    expect(dispatchLiveAgentTool).not.toHaveBeenCalled()
  })

  it('leaves the framework web tool alone when web access is on', async () => {
    const tools = await resolve('session.started', copilotSpec({ webAccess: true }))
    expect(tools).not.toHaveProperty('web_search')
    expect(tools).not.toHaveProperty('web_fetch')
  })

  it('no spec → no workspace tools, and web FAILS CLOSED (the refusal on both events)', async () => {
    stateStore.set('live-agent.discovered-tools', ['list_milestones'])
    for (const event of ['session.started', 'step.started'] as const) {
      const tools = await resolve(event, null)
      // Only the refusal: no proxy, no search_tools, even for discovered names.
      expect(Object.keys(tools!).sort(), event).toEqual(['web_search'])
      const out = (await tools!.web_search.execute({ query: 'x' })) as { error: string }
      expect(out.error, event).toMatch(/Web access is disabled/)
    }
    expect(dispatchLiveAgentTool).not.toHaveBeenCalled()
  })

  it('a spec without an explicit webAccess: true is treated as no-web', async () => {
    const spec = copilotSpec()
    delete (spec as Partial<LiveAgentSpec>).webAccess
    const tools = await resolve('session.started', spec)
    expect(tools).toHaveProperty('web_search')
    const out = (await tools!.web_search.execute({ query: 'x' })) as { error: string }
    expect(out.error).toMatch(/Web access is disabled/)
  })
})

describe('ask_user / say_to_user exist only inside the turn’s ceiling', () => {
  const byFile = { ask_user: askUser, say_to_user: sayToUser } as unknown as Record<string, Resolver>

  it.each(['ask_user', 'say_to_user'])('%s resolves (and dispatches) on a copilot turn', async (name) => {
    fetchLiveAgentSpec.mockResolvedValue(copilotSpec())
    const tool = (await byFile[name].events['session.started']({}, ctx)) as ToolFn
    expect(tool.description).toBe(`${name} tool`)
    await tool.execute({ x: 1 })
    expect(dispatchLiveAgentTool).toHaveBeenCalledWith(name, 'tok.sig', { x: 1 })
  })

  it.each(['ask_user', 'say_to_user'])('%s is ABSENT on a paired notes turn (not in its ceiling)', async (name) => {
    const notes = copilotSpec()
    notes.ceiling = notes.ceiling.filter((n) => n !== 'ask_user' && n !== 'say_to_user')
    notes.ceilingTools = notes.ceilingTools.filter((x) => x.name !== 'ask_user' && x.name !== 'say_to_user')
    fetchLiveAgentSpec.mockResolvedValue(notes)
    expect(await byFile[name].events['session.started']({}, ctx)).toBeNull()
  })

  it.each(['ask_user', 'say_to_user'])('%s is absent without a spec', async (name) => {
    fetchLiveAgentSpec.mockResolvedValue(null)
    expect(await byFile[name].events['session.started']({}, ctx)).toBeNull()
  })
})

describe('connected-app lookups: discoverable like any ceiling tool, at most 3 per session', () => {
  const LOOKUP = 'mcp__jira__getJiraIssue'
  function withLookup(): LiveAgentSpec {
    const spec = copilotSpec()
    spec.ceiling = [...spec.ceiling, LOOKUP]
    spec.ceilingTools = [...spec.ceilingTools, t(LOOKUP, '[Jira] Read-only lookup in a connected app.')]
    return spec
  }

  it('is never core; search_tools reveals it, and the next step proxies it', async () => {
    const first = await resolve('session.started', withLookup())
    expect(first).not.toHaveProperty(LOOKUP)
    await first!.search_tools.execute({ query: 'jira issue' })
    const next = await resolve('step.started', withLookup())
    expect(next).toHaveProperty(LOOKUP)
  })

  it('the 4th lookup in a session is refused here and never dispatched; other tools are not counted', async () => {
    stateStore.set('live-agent.discovered-tools', [LOOKUP])
    const tools = await resolve('step.started', withLookup())
    for (let i = 0; i < 3; i++) await tools![LOOKUP].execute({ key: `A-${i}` })
    await tools!.find.execute({ query: 'x' })
    const fourth = await tools![LOOKUP].execute({ key: 'A-4' })
    expect(fourth).toEqual({ refused: 'mcp_limit', message: "This call's 3 lookups are used. Answer with what you have." })
    const dispatched = dispatchLiveAgentTool.mock.calls.map((c) => c[0])
    expect(dispatched.filter((n) => n === LOOKUP)).toHaveLength(3)
    expect(dispatched).toContain('find')
  })
})
