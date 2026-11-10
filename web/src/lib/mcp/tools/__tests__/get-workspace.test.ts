import { describe, it, expect, vi } from 'vitest'
import { registerWorkspaceTools } from '../workspaces'

/**
 * ni_get_workspace reads a workspace, its teams (+ workflow states) and its
 * member roster by a CALLER-SUPPLIED id, on the MCP server's SERVICE-ROLE
 * Supabase client — RLS is bypassed, so the app-layer membership check is the
 * only gate. Without it, `{ workspace_id: <any uuid> }` dumped another tenant's
 * teams and member list.
 *
 * Locked in here: an explicit workspace_id is authorised (membership probe)
 * BEFORE any of the three payload reads, and a refusal is indistinguishable
 * from "workspace doesn't exist".
 */

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>
  isError?: boolean
}>

/** Same minimal fake McpServer as set-workspace.test.ts: the handler is always
 *  the LAST argument of the overloaded server.tool(). */
function captureHandlers() {
  const handlers = new Map<string, ToolHandler>()
  const server = {
    tool: (...registerArgs: unknown[]) => {
      const name = registerArgs[0] as string
      handlers.set(name, registerArgs[registerArgs.length - 1] as ToolHandler)
    },
  }
  return { server, handlers }
}

const ACTIVE_WS = 'ws-1'
const OWN_OTHER_WS = 'ws-2'
const FOREIGN_WS = 'ws-666'

/**
 * Filter-aware Supabase double. It records every read the handler actually
 * reaches, tagged by what it is — the membership PROBE and the member ROSTER
 * both hit `member`, and only the roster is a data leak.
 */
function makeSupabase(memberOf: string[]) {
  const reads: string[] = []
  const from = vi.fn((table: string) => {
    const filters: Record<string, unknown> = {}
    const result = () => {
      if (table === 'workspace') {
        reads.push('workspace')
        return { data: { id: filters['id'], name: 'Acme', slug: 'acme' }, error: null }
      }
      if (table === 'team') {
        reads.push('team')
        return { data: [{ id: 't-1', name: 'Eng', issue_prefix: 'ENG', workflow_state: [] }], error: null }
      }
      if (table === 'member') {
        // The probe is the only member read filtered by user_id; everything
        // else on this table is the roster (the payload).
        if ('user_id' in filters) {
          reads.push('member:probe')
          const ws = filters['workspace_id'] as string
          return memberOf.includes(ws)
            ? { data: { workspace_id: ws, role: 'member' }, error: null }
            : { data: null, error: { message: 'no rows returned' } }
        }
        reads.push('member:roster')
        return { data: [{ id: 'm-1', user_id: 'user-1', role: 'owner', display_name: 'Ada' }], error: null }
      }
      return { data: null, error: null }
    }
    const chain: Record<string, unknown> = {
      single: async () => result(),
      maybeSingle: async () => result(),
      then: (resolve: (r: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    }
    const proxy: Record<string, unknown> = new Proxy(chain, {
      get(target, prop: string) {
        if (prop in target) return target[prop]
        if (prop === 'eq') return (col: string, val: unknown) => ((filters[col] = val), proxy)
        return () => proxy
      },
    })
    return proxy
  })
  return { supabase: { from } as never, reads, from }
}

function getHandler(opts: { memberOf: string[] }) {
  const { server, handlers } = captureHandlers()
  const { supabase, reads, from } = makeSupabase(opts.memberOf)
  registerWorkspaceTools(server as never, 'user-1', supabase, ACTIVE_WS)
  const handler = handlers.get('ni_get_workspace')
  if (!handler) throw new Error('ni_get_workspace was not registered')
  return { handler, reads, from }
}

describe('ni_get_workspace — workspace scoping', () => {
  it('reads the ACTIVE workspace with no membership probe when workspace_id is omitted', async () => {
    const { handler, reads } = getHandler({ memberOf: [ACTIVE_WS] })

    const result = await handler({})

    expect(result.isError).toBeFalsy()
    // The active workspace came from the token — probing it again would be a
    // wasted round-trip on every single call.
    expect(reads).toEqual(['workspace', 'team', 'member:roster'])
    expect(JSON.parse(result.content[0].text).workspace.id).toBe(ACTIVE_WS)
  })

  it('serves another workspace the user IS a member of, after probing membership', async () => {
    const { handler, reads } = getHandler({ memberOf: [ACTIVE_WS, OWN_OTHER_WS] })

    const result = await handler({ workspace_id: OWN_OTHER_WS })

    expect(result.isError).toBeFalsy()
    expect(reads).toEqual(['member:probe', 'workspace', 'team', 'member:roster'])
    expect(JSON.parse(result.content[0].text).workspace.id).toBe(OWN_OTHER_WS)
  })

  it('refuses a workspace the user is not a member of and reads nothing from it', async () => {
    const { handler, reads, from } = getHandler({ memberOf: [ACTIVE_WS] })

    const result = await handler({ workspace_id: FOREIGN_WS })

    expect(result.isError).toBe(true)
    const body = JSON.parse(result.content[0].text)
    expect(body.error).toMatch(/not a member/i)
    // Identical to ni_set_workspace's refusal: it must not say whether the
    // workspace exists.
    expect(body.error).not.toMatch(new RegExp(FOREIGN_WS))
    // The probe is all that ran — no workspace row, no teams, no roster.
    expect(reads).toEqual(['member:probe'])
    expect(from).not.toHaveBeenCalledWith('workspace')
    expect(from).not.toHaveBeenCalledWith('team')
  })
})
