/**
 * `mcp_audit_log.target_workspace_id` (migration 271) — the audit half of
 * target-routed writes.
 *
 * `workspace_id` on an audit row records where the SESSION was pointed. Now
 * that a write routes by the entity's own workspace and a create routes by an
 * explicit `workspace_id`, those two can legally differ — and the gap between
 * them is the ONLY record that a call crossed a tenant boundary, which is
 * exactly the question asked after "who filed my ticket in the wrong
 * workspace?".
 *
 * The handoff is awkward on purpose: the guard wraps `server.tool`, so by the
 * time it writes the row it holds a JSON string, not the result object. The
 * registrar attaches the id to the content block under a non-enumerable symbol
 * (./tools/envelope.ts) and the guard reads it back — no JSON.parse of every
 * result in a ~165-tool catalog.
 *
 * Pinned here: the id survives that handoff, it never reaches the wire, and a
 * handler that attaches nothing audits NULL rather than inventing a default.
 */
import { describe, it, expect, vi } from 'vitest'
import { createMcpAuditLogger, installMcpGuard, type McpAuditFn } from '../guard'
import { targetWorkspaceOf, withTargetWorkspace } from '../tools/envelope'

const USER = 'user-1'
const WS_SESSION = 'ws-1'
const WS_TARGET = 'ws-2'

/** Captures every `.insert()` payload written to mcp_audit_log. */
function auditSupabase() {
  const inserts: Array<Record<string, unknown>> = []
  const supabase = {
    from: (table: string) => ({
      insert: (payload: Record<string, unknown>) => {
        if (table === 'mcp_audit_log') inserts.push(payload)
        return { then: (ok: () => void) => Promise.resolve().then(ok) }
      },
    }),
  } as never
  return { supabase, inserts }
}

/** Minimal McpServer: `server.tool` is overloaded, so the handler is always last. */
function captureHandlers() {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
  const server = {
    tool: (...args: unknown[]) => {
      handlers.set(args[0] as string, args[args.length - 1] as never)
    },
  }
  return { server, handlers }
}

describe('createMcpAuditLogger', () => {
  it('writes target_workspace_id alongside the session workspace_id', () => {
    const { supabase, inserts } = auditSupabase()
    const audit = createMcpAuditLogger(supabase, {
      tokenId: 'tok-1',
      userId: USER,
      workspaceId: WS_SESSION,
    })

    audit('ni_create_action', true, 42, undefined, WS_TARGET)

    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({
      token_id: 'tok-1',
      user_id: USER,
      workspace_id: WS_SESSION,
      target_workspace_id: WS_TARGET,
      tool_name: 'ni_create_action',
      ok: true,
      duration_ms: 42,
    })
  })

  it('writes NULL — not the session workspace — when nothing routed', () => {
    // Defaulting this to workspace_id would make every read look routed and
    // hide the mis-routes the column exists to surface.
    const { supabase, inserts } = auditSupabase()
    const audit = createMcpAuditLogger(supabase, {
      tokenId: null,
      userId: USER,
      workspaceId: WS_SESSION,
    })

    audit('ni_list_actions', true, 7)

    expect(inserts[0].target_workspace_id).toBeNull()
  })
})

describe('targetWorkspaceOf', () => {
  it('prefers the create echo, then falls back to the row-level tag', () => {
    expect(targetWorkspaceOf({ success: true, workspace: { id: WS_TARGET, name: 'Beta' } })).toBe(
      WS_TARGET,
    )
    expect(targetWorkspaceOf({ success: true, workspace_id: WS_TARGET })).toBe(WS_TARGET)
    expect(
      targetWorkspaceOf({ workspace: { id: WS_TARGET }, workspace_id: 'ignored' }),
    ).toBe(WS_TARGET)
  })

  it('ignores the active_workspace stamp the envelope puts on everything', () => {
    expect(targetWorkspaceOf({ items: [], active_workspace: { id: WS_SESSION, name: 'A' } })).toBeNull()
  })

  it('answers null for anything that is not a plain object', () => {
    for (const v of [null, undefined, 'x', 3, [{ workspace_id: WS_TARGET }]]) {
      expect(targetWorkspaceOf(v)).toBeNull()
    }
  })
})

describe('installMcpGuard target handoff', () => {
  const guarded = async (result: unknown) => {
    const audit = vi.fn() as McpAuditFn & ReturnType<typeof vi.fn>
    const { server, handlers } = captureHandlers()
    installMcpGuard(server as never, { readOnly: false, audit })
    server.tool('ni_create_action', 'desc', {}, async () => result)
    await handlers.get('ni_create_action')!({})
    return audit
  }

  it('reads the id the registrar attached to the content block', async () => {
    const content = withTargetWorkspace(
      { content: [{ type: 'text' as const, text: '{"success":true}' }] },
      WS_TARGET,
    )
    const audit = await guarded(content)

    expect(audit).toHaveBeenCalledWith('ni_create_action', true, expect.any(Number), undefined, WS_TARGET)
  })

  it('never lets the marker reach the wire', () => {
    const content = withTargetWorkspace(
      { content: [{ type: 'text' as const, text: '{"success":true}' }] },
      WS_TARGET,
    )
    // Symbol-keyed AND non-enumerable: invisible to serialisation, to Object.keys,
    // and to any client that receives the block.
    expect(JSON.parse(JSON.stringify(content))).toEqual({
      content: [{ type: 'text', text: '{"success":true}' }],
    })
    expect(Object.keys(content)).toEqual(['content'])
  })

  it('audits null for a handler that attaches nothing (hand-written registrars)', async () => {
    const audit = await guarded({ content: [{ type: 'text', text: '{}' }] })

    expect(audit).toHaveBeenCalledWith('ni_create_action', true, expect.any(Number), undefined, null)
  })

  it('leaves a blocked read-only write auditing null', async () => {
    const audit = vi.fn() as McpAuditFn & ReturnType<typeof vi.fn>
    const { server, handlers } = captureHandlers()
    installMcpGuard(server as never, { readOnly: true, audit })
    server.tool('ni_create_action', 'desc', {}, async () => {
      throw new Error('handler must never run')
    })

    const res = (await handlers.get('ni_create_action')!({})) as { isError?: boolean }
    expect(res.isError).toBe(true)
    // Nothing was written, so there is no target to record.
    expect(audit).toHaveBeenCalledWith('ni_create_action', false, 0, 'forbidden_read_only')
  })
})
