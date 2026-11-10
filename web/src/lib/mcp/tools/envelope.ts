/**
 * The MCP response envelope — shared by the tool registrar and the dispatcher.
 *
 * These three were private to ./index.ts until `ni_call_tool` needed to
 * return results and errors that are INDISTINGUISHABLE from a direct call:
 * same `active_workspace` stamp, same error categories, same shape. A second
 * copy would have drifted the first time one of them changed, so they live
 * here and both callers import them.
 */
import { withoutToolImage } from '@/lib/ai/tools/tool-image'

/** Said in place of an image a tool returned: it is not sent over MCP. */
export const MCP_IMAGE_NOT_SENT = 'An image, not sent over MCP.'

/**
 * A tool result as MCP sends it: an image under the internal keys
 * (read_chat_file on a photo, get_attachment_content on an image) is left
 * out, with a note. As base64 text it is ~100K tokens for the client's model.
 */
export function withoutMcpImage(result: unknown): unknown {
  return withoutToolImage(result, MCP_IMAGE_NOT_SENT)
}

/**
 * Merge `active_workspace: { id, name }` into the response of every tool call.
 *
 * Why: agents (Codex, Claude Code, the Native Intelligence live agent) routinely misroute
 * tool calls when they're unsure which workspace they're in. The server-level
 * `instructions` blob tells them once at connect; this injection acts as a
 * constant in-band reminder so the active workspace is visible on every
 * single tool result.
 *
 * Behavior:
 *   - Only merges when the underlying tool returned a plain object. Arrays,
 *     strings, null, etc. are returned untouched (no surprise wrapping).
 *   - Does NOT overwrite an `active_workspace` key the tool set itself —
 *     workspace-management tools may already shape the response carefully.
 *   - Runs whether or not the tool actually used the workspace (cheap and
 *     consistent is better than clever and selective).
 */
export function withActiveWorkspace(
  result: unknown,
  active: { id: string; name: string | null },
): unknown {
  if (
    result === null ||
    typeof result !== 'object' ||
    Array.isArray(result)
  ) {
    return result
  }
  const obj = result as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(obj, 'active_workspace')) {
    return obj
  }
  return {
    ...obj,
    active_workspace: {
      id: active.id,
      name: active.name,
    },
  }
}

/**
 * Categorise an unknown thrown value into a structured MCP error payload.
 *
 * Returns the three fields that callers (MCP clients / AI agents) need to
 * decide what to do next:
 *
 *   - `error`      – human-readable message (never "Unknown error")
 *   - `error_type` – machine-readable category for programmatic branching
 *   - `retryable`  – true when the same request is likely to succeed on retry
 *
 * Recognised patterns (checked in priority order — timeout wins over network):
 *   timeout_error  – request/query exceeded its deadline; always worth a retry
 *   network_error  – fetch/socket failures; almost always transient
 *   db_error       – Supabase/Postgres failures; may be transient or RLS
 *   execution_error – anything else (logic bug, missing data, …)
 */
export function categoriseMcpError(err: unknown): {
  error: string
  error_type: 'network_error' | 'db_error' | 'timeout_error' | 'execution_error'
  retryable: boolean
} {
  // JSON.stringify(undefined) returns undefined (not a string), so we fall
  // back to String(err) for the undefined / non-serialisable cases.
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : JSON.stringify(err)
  const message = raw ?? String(err)

  const lower = message.toLowerCase()

  const isNetwork =
    lower.includes('fetch failed') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('network error') ||
    lower.includes('socket hang up')

  const isDb =
    lower.includes('permission denied') ||
    lower.includes('row-level security') ||
    lower.includes('connection reset') ||
    lower.includes('deadlock') ||
    lower.includes('could not connect to server')

  const isTimeout =
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('deadline exceeded')

  if (isTimeout) return { error: message, error_type: 'timeout_error', retryable: true }
  if (isNetwork) return { error: message, error_type: 'network_error', retryable: true }
  if (isDb) return { error: message, error_type: 'db_error', retryable: false }
  return { error: message, error_type: 'execution_error', retryable: false }
}

/**
 * Build the structured error content block returned to the MCP client when a
 * tool handler throws.
 *
 * Stamping `active_workspace` means the caller always knows which workspace
 * the failing call was scoped to — useful when debugging cross-workspace
 * agent sessions.
 */
export function buildMcpErrorContent(
  err: unknown,
  toolName: string,
  active: { id: string; name: string | null },
): { content: [{ type: 'text'; text: string }]; isError: true } {
  const { error, error_type, retryable } = categoriseMcpError(err)
  console.error(`[MCP] Tool "${toolName}" error (${error_type}):`, error)
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ error, error_type, retryable, active_workspace: active }),
    }],
    isError: true,
  }
}


/**
 * Handoff channel for the AUDIT target workspace.
 *
 * The problem: `installMcpGuard` (../guard.ts) wraps `server.tool`, so by the
 * time it writes the audit row all it holds is the MCP content block — a string
 * of JSON. The one fact worth auditing about a target-routed write (WHICH
 * workspace it actually landed in) lives in the result OBJECT, one layer below,
 * and re-parsing that JSON in the guard would mean JSON.parse on every tool
 * result in the catalog, including the megabyte-scale ones.
 *
 * So the registrar, which still has the object, attaches the id to the content
 * block under this symbol and the guard reads it back. Non-enumerable and
 * symbol-keyed: it never reaches the wire, never shows up in a JSON.stringify
 * of the block, and an older guard (or a hand-written registrar that doesn't
 * attach it) simply reads `null`.
 */
const TARGET_WORKSPACE = Symbol('ni.mcp.targetWorkspace')

/**
 * Pull the workspace a tool result claims to have acted in.
 *
 * `workspace` is the create-tool echo (`workspaceEcho` in
 * @/lib/ai/tools/_shared); `workspace_id` is the row-level tag Phase 1 put on
 * every list/get row and on single-entity results. Reads are expected to answer
 * null — nothing was routed, so there is nothing to record.
 *
 * Deliberately NOT `active_workspace`: that is the session default the envelope
 * stamps on everything, so recording it would make every audit row look routed
 * and hide the mis-routes this column exists to surface.
 */
export function targetWorkspaceOf(result: unknown): string | null {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null
  const obj = result as { workspace?: unknown; workspace_id?: unknown }
  const echoed = obj.workspace as { id?: unknown } | null | undefined
  if (echoed && typeof echoed === 'object' && typeof echoed.id === 'string') return echoed.id
  return typeof obj.workspace_id === 'string' ? obj.workspace_id : null
}

/**
 * Attach the target workspace to an MCP content block on its way out, for the
 * guard to audit. Returns the same object (mutated) so it can wrap a return
 * expression directly.
 */
export function withTargetWorkspace<T extends object>(content: T, workspaceId: string | null): T {
  if (!workspaceId) return content
  Object.defineProperty(content, TARGET_WORKSPACE, {
    value: workspaceId,
    enumerable: false,
    configurable: true,
  })
  return content
}

/** Read back what {@link withTargetWorkspace} attached. Null when absent. */
export function readTargetWorkspace(content: unknown): string | null {
  if (content === null || typeof content !== 'object') return null
  const v = (content as Record<symbol, unknown>)[TARGET_WORKSPACE]
  return typeof v === 'string' ? v : null
}
