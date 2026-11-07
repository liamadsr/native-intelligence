/**
 * `active_workspace` on the HAND-REGISTERED MCP tools.
 *
 * The adapter loop in ./index.ts merges `active_workspace: { id, name }` into
 * every BRIDGED tool result (envelope.ts's withActiveWorkspace) so an agent can
 * re-check its scope on any response without spending a call. The four
 * hand-written registrars — workspaces, github, library, evals — build their own
 * `content` blocks, so the adapter never saw them: they were the only results in
 * a ~165-tool catalog that didn't say which workspace they came from, and
 * `dial8_list_workspaces` (the tool an agent reaches for when it is UNSURE of
 * its scope) was among them.
 *
 * Pinned here: every JSON success payload from those registrars carries the
 * stamp, `dial8_set_workspace` reports the NEW workspace rather than the one the
 * call started in, and error payloads are left exactly as they were.
 */
import { describe, it, expect, vi } from 'vitest'
import { registerWorkspaceTools } from '../workspaces'
import { registerGitHubTools } from '../github'
import { registerLibraryTools } from '../library'

const USER_ID = 'user-1'
const WS_ID = 'ws-1'
const WS_NAME = 'Alpha'

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>
  isError?: boolean
}>

/** Same minimal fake McpServer the other suites here use: server.tool is
 *  overloaded — (name, desc, handler) and (name, desc, schema, handler) — so the
 *  handler is always the LAST argument. */
function captureHandlers() {
  const handlers = new Map<string, ToolHandler>()
  const server = {
    tool: (...registerArgs: unknown[]) => {
      handlers.set(registerArgs[0] as string, registerArgs[registerArgs.length - 1] as ToolHandler)
    },
  }
  return { server, handlers }
}

/** Every from().…-chain resolves to `result`, awaited or via single/maybeSingle. */
function supabaseStub(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'is', 'not', 'or', 'order', 'limit', 'update', 'upsert']) {
    chain[m] = vi.fn(() => chain)
  }
  chain.single = vi.fn(async () => result)
  chain.maybeSingle = vi.fn(async () => result)
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return { from: vi.fn(() => chain) } as never
}

const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

describe('dial8_list_workspaces', () => {
  it('stamps the active workspace onto the result', async () => {
    const { server, handlers } = captureHandlers()
    registerWorkspaceTools(
      server as never,
      USER_ID,
      supabaseStub({ data: [{ workspace_id: WS_ID, role: 'owner', workspace: { id: WS_ID, name: WS_NAME, slug: 'alpha' } }], error: null }),
      WS_ID,
      undefined,
      WS_NAME,
    )

    const res = await handlers.get('dial8_list_workspaces')!({})
    const parsed = body(res)
    expect(parsed.active_workspace).toEqual({ id: WS_ID, name: WS_NAME })
    // The stamp is additive — the payload itself is untouched.
    expect(parsed.workspaces).toHaveLength(1)
  })

  it('still stamps when the caller had no workspace name to thread', async () => {
    const { server, handlers } = captureHandlers()
    registerWorkspaceTools(server as never, USER_ID, supabaseStub({ data: [], error: null }), WS_ID)

    expect(body(await handlers.get('dial8_list_workspaces')!({})).active_workspace).toEqual({
      id: WS_ID,
      name: null,
    })
  })

  it('leaves an error payload exactly as it was', async () => {
    const { server, handlers } = captureHandlers()
    registerWorkspaceTools(
      server as never,
      USER_ID,
      supabaseStub({ data: null, error: { message: 'boom' } }),
      WS_ID,
      undefined,
      WS_NAME,
    )

    const res = await handlers.get('dial8_list_workspaces')!({})
    expect(res.isError).toBe(true)
    expect(body(res)).toEqual({ error: 'boom' })
  })
})

describe('dial8_get_workspace', () => {
  it('stamps the active workspace', async () => {
    const { server, handlers } = captureHandlers()
    // This handler mixes a .single() read (the workspace row) with two awaited
    // list reads (teams, members), so the stub has to answer per table.
    const chain = (single: unknown, list: unknown[]): Record<string, unknown> => {
      const self: Record<string, unknown> = {
        single: async () => ({ data: single, error: null }),
        maybeSingle: async () => ({ data: single, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: list, error: null }).then(resolve),
      }
      const proxy: Record<string, unknown> = new Proxy(self, {
        get: (t, p: string) => (p in t ? t[p] : () => proxy),
      })
      return proxy
    }
    const supabase = {
      from: (table: string) =>
        table === 'workspace'
          ? chain({ id: WS_ID, name: WS_NAME, slug: 'alpha' }, [])
          : chain(null, []),
    } as never

    registerWorkspaceTools(server as never, USER_ID, supabase, WS_ID, undefined, WS_NAME)

    expect(body(await handlers.get('dial8_get_workspace')!({})).active_workspace).toEqual({
      id: WS_ID,
      name: WS_NAME,
    })
  })
})

describe('dial8_set_workspace', () => {
  it('reports the NEW workspace as active_workspace, not the one it started in', async () => {
    const { server, handlers } = captureHandlers()
    registerWorkspaceTools(
      server as never,
      USER_ID,
      // Both reads (membership probe, then the name lookup) answer with ws-2.
      supabaseStub({ data: { workspace_id: 'ws-2', role: 'owner', name: 'Beta', slug: 'beta' }, error: null }),
      WS_ID,
      vi.fn(async () => {}),
      WS_NAME,
    )

    const parsed = body(await handlers.get('dial8_set_workspace')!({ workspace_id: 'ws-2' }))
    expect(parsed.success).toBe(true)
    // By the time this returns the switch is committed, so the stamp has to name
    // the workspace every SUBSEQUENT call will run in.
    expect(parsed.active_workspace).toEqual({ id: 'ws-2', name: 'Beta' })
    expect(parsed.workspace_id).toBe('ws-2')
  })
})

describe('dial8_get_pr_status (github registrar)', () => {
  it('stamps the active workspace', async () => {
    const { server, handlers } = captureHandlers()
    registerGitHubTools(server as never, USER_ID, supabaseStub({ data: [], error: null }), WS_ID, WS_NAME)

    const parsed = body(await handlers.get('dial8_get_pr_status')!({ action_id: 'a-1' }))
    expect(parsed.active_workspace).toEqual({ id: WS_ID, name: WS_NAME })
    expect(parsed.prs).toEqual([])
  })

  it('leaves its error payload untouched', async () => {
    const { server, handlers } = captureHandlers()
    registerGitHubTools(
      server as never,
      USER_ID,
      supabaseStub({ data: null, error: { message: 'db down' } }),
      WS_ID,
      WS_NAME,
    )

    const res = await handlers.get('dial8_get_pr_status')!({ action_id: 'a-1' })
    expect(res.isError).toBe(true)
    expect(body(res)).toEqual({ error: 'db down' })
  })
})

describe('dial8_list_skills (library registrar)', () => {
  it('stamps the active workspace', async () => {
    const { server, handlers } = captureHandlers()
    // `workspace` answers the edition lookup (which drives the feature gate);
    // `recipe` is the awaited list read.
    const chain = (single: unknown, list: unknown[]): Record<string, unknown> => {
      const self: Record<string, unknown> = {
        single: async () => ({ data: single, error: null }),
        maybeSingle: async () => ({ data: single, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: list, error: null }).then(resolve),
      }
      const proxy: Record<string, unknown> = new Proxy(self, {
        get: (t, p: string) => (p in t ? t[p] : () => proxy),
      })
      return proxy
    }
    const supabase = {
      from: (table: string) =>
        table === 'workspace' ? chain({ settings: {} }, []) : chain(null, [{ id: 'r-1', name: 'Planner' }]),
    } as never

    registerLibraryTools(server as never, USER_ID, supabase, WS_ID, WS_NAME)

    const parsed = body(await handlers.get('dial8_list_skills')!({}))
    expect(parsed.active_workspace).toEqual({ id: WS_ID, name: WS_NAME })
    expect(parsed.skills).toHaveLength(1)
  })
})
