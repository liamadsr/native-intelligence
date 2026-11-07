import { describe, it, expect, vi } from 'vitest'
import { registerWorkspaceTools } from '../workspaces'

/**
 * Regression guard for the "chat dies when an MCP client switches workspace" bug.
 *
 * Root cause was that dial8_set_workspace fired its persistence callback
 * (onWorkspaceChanged → write active_workspace_id) WITHOUT awaiting it, then
 * returned `success`. Because the MCP server is stateless (fresh server per
 * POST) the next tool call re-reads active_workspace_id to scope itself — so if
 * the write hadn't committed (or, on Vercel, was dropped when the function
 * suspended post-response), the follow-up ran in the OLD workspace, the agent
 * looped on empty/wrong data, and the chat appeared to die.
 *
 * These tests lock in two properties of the fixed handler:
 *   1. it AWAITS onWorkspaceChanged before returning success, and
 *   2. a failed write surfaces as isError, not a false success.
 */

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>
  isError?: boolean
}>

/**
 * A minimal fake McpServer that records the handler registered for each tool
 * name, so a test can invoke dial8_set_workspace's handler directly. server.tool
 * is overloaded — (name, desc, handler) and (name, desc, schema, handler); the
 * handler is always the LAST argument.
 */
function captureHandlers() {
  const handlers = new Map<string, ToolHandler>()
  const server = {
    tool: (...registerArgs: unknown[]) => {
      const name = registerArgs[0] as string
      const handler = registerArgs[registerArgs.length - 1] as ToolHandler
      handlers.set(name, handler)
    },
  }
  return { server, handlers }
}

/**
 * A Supabase stub good enough for dial8_set_workspace, which does exactly two
 * reads: member membership check (.single) and workspace name lookup (.single).
 * Every from().select().eq()/.is() chain is a thenable resolving to `result`.
 */
function supabaseStub(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'is', 'order', 'limit', 'update']) {
    chain[m] = vi.fn(() => chain)
  }
  chain.single = vi.fn(async () => result)
  chain.maybeSingle = vi.fn(async () => result)
  return { from: vi.fn(() => chain) } as never
}

function getSetWorkspaceHandler(opts: {
  onWorkspaceChanged?: (id: string) => void | Promise<void>
  membership?: { data: unknown; error: unknown }
}) {
  const { server, handlers } = captureHandlers()
  // Membership check + workspace-name lookup both go through .single(); default
  // to a valid membership so the handler reaches the persistence step.
  const supabase = supabaseStub(
    opts.membership ?? { data: { workspace_id: 'ws-2', role: 'owner' }, error: null },
  )
  registerWorkspaceTools(server as never, 'user-1', supabase, 'ws-1', opts.onWorkspaceChanged)
  const handler = handlers.get('dial8_set_workspace')
  if (!handler) throw new Error('dial8_set_workspace was not registered')
  return handler
}

describe('dial8_set_workspace persistence', () => {
  it('AWAITS onWorkspaceChanged before returning success', async () => {
    const order: string[] = []
    let releaseWrite!: () => void
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const onWorkspaceChanged = vi.fn(async () => {
      order.push('write-start')
      await writeGate
      order.push('write-commit')
    })

    const handler = getSetWorkspaceHandler({ onWorkspaceChanged })

    const resultPromise = handler({ workspace_id: 'ws-2' }).then((r) => {
      order.push('handler-returned')
      return r
    })

    // Let the write begin and confirm the handler has NOT returned yet — it must
    // be parked on the await, not racing ahead to a fire-and-forget success.
    await Promise.resolve()
    expect(order).toEqual(['write-start'])

    releaseWrite()
    const result = await resultPromise

    // The write committed strictly before the handler returned.
    expect(order).toEqual(['write-start', 'write-commit', 'handler-returned'])
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(result.content[0].text).success).toBe(true)
    expect(onWorkspaceChanged).toHaveBeenCalledWith('ws-2')
  })

  it('surfaces a failed write as isError, not a false success', async () => {
    const onWorkspaceChanged = vi.fn(async () => {
      throw new Error('Failed to persist active workspace: connection reset')
    })

    const handler = getSetWorkspaceHandler({ onWorkspaceChanged })
    const result = await handler({ workspace_id: 'ws-2' })

    expect(result.isError).toBe(true)
    const body = JSON.parse(result.content[0].text)
    expect(body.success).toBeUndefined()
    expect(body.error).toMatch(/failed to switch workspace/i)
    expect(body.error).toMatch(/connection reset/i)
  })

  it('rejects a workspace the user is not a member of (before any write)', async () => {
    const onWorkspaceChanged = vi.fn()
    const handler = getSetWorkspaceHandler({
      onWorkspaceChanged,
      membership: { data: null, error: { message: 'no rows' } },
    })

    const result = await handler({ workspace_id: 'ws-nope' })

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text).error).toMatch(/not a member/i)
    // No persistence attempt for a non-member switch.
    expect(onWorkspaceChanged).not.toHaveBeenCalled()
  })
})
