import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readTargetWorkspace } from './tools/envelope'
import { resolveMcpToolSideEffect } from './tool-side-effects'
import { isReadShapedName } from './read-names'

/**
 * MCP guard — token-scope enforcement + audit logging for every tool exposed
 * by the Native Intelligence MCP server.
 *
 * The OAuth token table has carried a `scopes` field since migration 065, but
 * nothing ever enforced it: every token was full read-write over the whole
 * workspace. This module is the single choke point that fixes that:
 *
 *   - read-only tokens (scopes = ['read']) get every read tool and workspace
 *     navigation, and a structured "forbidden" error for anything that writes;
 *   - every call (allowed, blocked, or failed) lands in mcp_audit_log.
 *
 * Enforcement wraps `server.tool` itself, so it covers ALL registration paths
 * (AI-SDK adapter, workspace tools, GitHub tools, library tools, future ones)
 * without per-registrar plumbing.
 *
 * Scope semantics:
 *   []                → legacy/unscoped token: full access (tokens issued
 *                        before enforcement shipped; revoke to rotate)
 *   ['read']          → read-only
 *   ['read','write']  → full access
 */

export type McpToolAccess = 'read' | 'write'

// Write-capable tools that remain allowed under a read-only token: they
// navigate the session (which workspace tool calls run in) rather than
// mutating workspace data.
//
// `call_tool` is the dispatcher (tools/discovery.ts), and it is here for a
// different reason: classified by its own name it is a write, which would deny
// a read-only token the ONE tool that lets it reach anything missing from its
// cached catalog. So the guard lets it through and the dispatcher re-runs
// `classifyToolAccess` on the name it was asked to invoke — fail-closed, same
// forbidden payload. That check is load-bearing: without it a read-only token
// could write through the dispatcher. See the comment at that call site.
const READ_ALLOWED_WRITES = new Set(['set_workspace', 'call_tool'])

/**
 * Classify a tool by name. Fail-closed: anything that doesn't match a known
 * read shape is treated as a write, so a future tool can't accidentally leak
 * write access to read-only tokens by being misnamed.
 */
export function classifyToolAccess(toolName: string): McpToolAccess {
  const bare = toolName.replace(/^dial8_/, '')
  if (READ_ALLOWED_WRITES.has(bare)) return 'read'
  // The classification is the source of truth (registry class, then the
  // MCP-only map — Sequence step 2); the name regex below is the fallback for
  // a tool neither knows, and it fails closed.
  const cls = resolveMcpToolSideEffect(bare)
  if (cls !== undefined) return cls === 'read' ? 'read' : 'write'
  if (isReadShapedName(bare)) return 'read'
  return 'write'
}

/** True when the token's scopes grant read but not write. */
export function isReadOnlyToken(scopes: string[] | null | undefined): boolean {
  if (!scopes || scopes.length === 0) return false
  return scopes.includes('read') && !scopes.includes('write')
}

/**
 * `targetWorkspaceId` — the workspace the call actually ACTED IN, when that is
 * knowable and different from the connection's own. `workspace_id` on this row
 * records where the SESSION was pointed; now that writes route by the entity's
 * (or the create's) workspace rather than the session's, those two can legally
 * differ, and the gap between them is the only record of a cross-workspace
 * write. Null for reads and for anything that didn't route.
 */
export type McpAuditFn = (
  toolName: string,
  ok: boolean,
  durationMs: number,
  errorType?: string,
  targetWorkspaceId?: string | null,
) => void

export interface McpGuardOptions {
  readOnly: boolean
  audit?: McpAuditFn
}

/**
 * Fire-and-forget audit writer. Never throws, never blocks the tool call —
 * audit loss is preferable to tool latency/failure.
 */
export function createMcpAuditLogger(
  supabase: SupabaseClient,
  ctx: { tokenId: string | null; userId: string; workspaceId: string | null },
): McpAuditFn {
  return (toolName, ok, durationMs, errorType, targetWorkspaceId) => {
    try {
      void supabase
        .from('mcp_audit_log')
        .insert({
          token_id: ctx.tokenId,
          user_id: ctx.userId,
          workspace_id: ctx.workspaceId,
          // Migration 271. Nullable and unread by anything on the hot path —
          // this is forensics for "who filed my ticket in the wrong workspace".
          target_workspace_id: targetWorkspaceId ?? null,
          tool_name: toolName,
          ok,
          error_type: errorType ?? null,
          duration_ms: Math.max(0, Math.round(durationMs)),
        })
        .then(
          () => {},
          () => {},
        )
    } catch {
      // Swallow — auditing must never break a tool call.
    }
  }
}

/**
 * Wrap `server.tool` so every subsequently-registered tool handler is guarded
 * and audited. Must be installed BEFORE any tools are registered.
 */
export function installMcpGuard(server: McpServer, opts: McpGuardOptions): void {
  const original = server.tool.bind(server) as (...args: unknown[]) => unknown

  const wrapped = (...args: unknown[]): unknown => {
    const name = typeof args[0] === 'string' ? (args[0] as string) : ''
    const cbIndex = args.length - 1
    const cb = args[cbIndex]
    if (typeof cb === 'function') {
      const handler = cb as (...cbArgs: unknown[]) => unknown
      args[cbIndex] = async (...cbArgs: unknown[]) => {
        if (opts.readOnly && classifyToolAccess(name) === 'write') {
          opts.audit?.(name, false, 0, 'forbidden_read_only')
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: `This access token is read-only and "${name}" modifies workspace data. Re-authorize with write scope to use it.`,
                  error_type: 'forbidden',
                  retryable: false,
                }),
              },
            ],
            isError: true,
          }
        }
        const t0 = Date.now()
        try {
          const result = await handler(...cbArgs)
          const isErr = !!(
            result &&
            typeof result === 'object' &&
            (result as { isError?: boolean }).isError
          )
          // The registrar attached this (symbol-keyed, non-enumerable) because
          // only IT still had the result object; by here it is JSON in a content
          // block. Absent → null, so a hand-written registrar that never routes
          // costs nothing. See ./tools/envelope.ts.
          opts.audit?.(
            name,
            !isErr,
            Date.now() - t0,
            isErr ? 'execution_error' : undefined,
            readTargetWorkspace(result),
          )
          return result
        } catch (err) {
          opts.audit?.(name, false, Date.now() - t0, 'execution_error')
          throw err
        }
      }
    }
    return original(...args)
  }

  ;(server as unknown as { tool: (...args: unknown[]) => unknown }).tool = wrapped
}
