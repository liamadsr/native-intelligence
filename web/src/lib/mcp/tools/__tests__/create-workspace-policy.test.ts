/**
 * The MCP bridge's two Phase-3 obligations, through the REAL registration path.
 *
 *   1. It builds the chat toolset with `createWorkspacePolicy: 'explicit'`.
 *      This is the ONE option where MCP must differ from in-app chat: a
 *      connector's "active workspace" is an OAuth artifact chosen weeks ago and
 *      invisible in the turn, so a create that silently defaults to it is
 *      precisely the "you filed it in the wrong workspace" bug. Chat's session
 *      workspace is something the human just picked in the switcher, so it keeps
 *      the 'session' default and stays byte-identical.
 *
 *   2. The bridged wrapper lifts the routed workspace off the RESULT OBJECT —
 *      before the object becomes a JSON string — and hands it to the guard for
 *      `mcp_audit_log.target_workspace_id` (migration 271).
 *
 * `@/lib/ai/tools` is mocked so the assertions are about the bridge, not about
 * ~165 real tools.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'

const hoisted = vi.hoisted(() => ({
  createTools: vi.fn(() => ({}) as Record<string, unknown>),
}))

vi.mock('@/lib/ai/tools', () => ({ createTools: hoisted.createTools }))

const { registerTools } = await import('../index')

const USER = 'user-1'
const WS_SESSION = 'ws-1'
const WS_TARGET = 'ws-2'

/** Registration only builds closures — a chainable no-op satisfies every read. */
function chainableStub(): unknown {
  const stub: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === 'then' ? undefined : stub),
    apply: () => stub,
  })
  return stub
}
const fakeSupabase = chainableStub() as SupabaseClient

/** Minimal McpServer: `server.tool` is overloaded, so the handler is last. */
function captureHandlers() {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
  const server = {
    tool: (...args: unknown[]) => {
      handlers.set(args[0] as string, args[args.length - 1] as never)
    },
  }
  return { server, handlers }
}

beforeEach(() => {
  hoisted.createTools.mockReset()
  hoisted.createTools.mockReturnValue({})
})

describe('createTools options', () => {
  it("builds the MCP toolset with createWorkspacePolicy: 'explicit'", async () => {
    const { server } = captureHandlers()
    await registerTools(server as never, USER, fakeSupabase, WS_SESSION, 'Alpha')

    expect(hoisted.createTools).toHaveBeenCalledTimes(1)
    const args = hoisted.createTools.mock.calls[0] as unknown[]
    expect(args[0]).toBe(USER)
    expect(args[2]).toBe(WS_SESSION)
    // botWorkVoice 'person': on MCP the person's own agent is narrated in the
    // third person ("Your agent drafted…"), not as the caller (A3 one face).
    expect(args[4]).toEqual({ createWorkspacePolicy: 'explicit', botWorkVoice: 'person' })
  })

  it('passes no access token (chat-only) and nothing about a search window', async () => {
    const { server } = captureHandlers()
    await registerTools(server as never, USER, fakeSupabase, WS_SESSION, 'Alpha')

    const args = hoisted.createTools.mock.calls[0] as unknown[]
    expect(args[3]).toBeUndefined()
    expect(args).toHaveLength(5)
    expect(JSON.stringify(args[4])).not.toContain('timeWindow')
  })
})

describe('bridged results carry the routed workspace to the audit log', () => {
  /** Register one fake chat tool whose execute returns `result`, then call it. */
  async function callBridged(result: unknown) {
    hoisted.createTools.mockReturnValue({
      create_action: {
        description: 'Create an action',
        inputSchema: z.object({ title: z.string() }),
        execute: async () => result,
      },
    })
    const audit = vi.fn()
    const { server, handlers } = captureHandlers()
    await registerTools(server as never, USER, fakeSupabase, WS_SESSION, 'Alpha', undefined, {
      readOnly: false,
      audit,
    })
    const res = (await handlers.get('ni_create_action')!({ title: 'x' })) as {
      content: Array<{ text: string }>
    }
    return { audit, body: JSON.parse(res.content[0].text) }
  }

  it("audits the create echo's workspace, not the session's", async () => {
    const { audit, body } = await callBridged({
      success: true,
      action: { id: 'a-1' },
      workspace: { id: WS_TARGET, name: 'Beta' },
    })

    expect(audit).toHaveBeenCalledWith(
      'ni_create_action',
      true,
      expect.any(Number),
      undefined,
      WS_TARGET,
    )
    // And the same fact is in-band: `workspace` next to `active_workspace` is
    // what makes a mis-route visible in the turn that caused it.
    expect(body.workspace).toEqual({ id: WS_TARGET, name: 'Beta' })
    expect(body.active_workspace).toEqual({ id: WS_SESSION, name: 'Alpha' })
  })

  it('falls back to the row-level workspace_id tag', async () => {
    const { audit } = await callBridged({ success: true, workspace_id: WS_TARGET })
    expect(audit.mock.calls[0][4]).toBe(WS_TARGET)
  })

  it('audits null for a read that routed nowhere', async () => {
    const { audit, body } = await callBridged({ success: true, actions: [] })
    // `active_workspace` is stamped on every result, so it must NOT be mistaken
    // for a routing target — otherwise every read looks cross-workspace.
    expect(body.active_workspace).toEqual({ id: WS_SESSION, name: 'Alpha' })
    expect(audit.mock.calls[0][4]).toBeNull()
  })

  it('audits null when the tool throws', async () => {
    hoisted.createTools.mockReturnValue({
      create_action: {
        description: 'Create an action',
        inputSchema: z.object({ title: z.string() }),
        execute: async () => {
          throw new Error('boom')
        },
      },
    })
    const audit = vi.fn()
    const { server, handlers } = captureHandlers()
    await registerTools(server as never, USER, fakeSupabase, WS_SESSION, 'Alpha', undefined, {
      readOnly: false,
      audit,
    })

    const res = (await handlers.get('ni_create_action')!({ title: 'x' })) as { isError?: boolean }
    expect(res.isError).toBe(true)
    expect(audit).toHaveBeenCalledWith(
      'ni_create_action',
      false,
      expect.any(Number),
      'execution_error',
      null,
    )
  })
})
