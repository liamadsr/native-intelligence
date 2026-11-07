/**
 * Verified cards for the connection changes the agent can't make on its own
 * word (flows-connectors F2 §2.1): disconnecting, and loosening a connected
 * app tool's access. Each is the existing approval machinery
 * (src/lib/safety/approvals.ts, migration 335), like the F1 flow cards
 * (src/lib/flows/flow-approvals.ts): a tool_approval row and an
 * attention_item card in the person's own queue, run once, as them, on their
 * own Accept, after every re-check there. The model can never accept one.
 *
 * The stored call is the tool itself (disconnect / set_tool_access),
 * replayed with `approvedCall` (src/lib/safety/approved-call.ts), and the
 * card records the connection's state hash: the replay refuses when the
 * connection changed after the card was made, so a card can't widen a tool
 * on a server that was re-listed or re-pointed since.
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ApprovedCall, ConnectionApprovalContext } from '@/lib/safety/approved-call'
import type { ApprovalContext } from '@/lib/safety/approvals'

/** JSON with sorted keys, so equal values hash equal. */
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
    }
    return v
  }
  return JSON.stringify(sort(value ?? null)) ?? 'null'
}

/** One hash for what a connection is, as the card saw it. */
export function connectionStateHash(state: unknown): string {
  return createHash('sha256').update(canonicalJson(state)).digest('hex')
}

/** The card a connection change raises. */
export interface ConnectionCardRequest {
  userId: string
  workspaceId: string
  toolName: 'disconnect' | 'set_tool_access'
  /** The tool's real input plus the card's display fields (the tool's schema strips those on replay). */
  input: Record<string, unknown>
  card: { title: string; why: string }
  context: ConnectionApprovalContext
  conversationId?: string | null
  sideEffect: 'delete' | 'automation-write'
  /** The chat door's re-check context (agent persona, surface, teammate): its ceiling applies at Accept. */
  approvalContext?: Omit<ApprovalContext, 'flow' | 'connection' | 'bots' | 'document'>
}

export interface ConnectionCardOutcome {
  ok: boolean
  approval_id: string | null
  error?: string
}

/**
 * Hold the change as the person's verified card. The approvals module is
 * loaded lazily: it imports createTools, which imports these tools.
 */
export async function raiseConnectionCard(service: SupabaseClient, request: ConnectionCardRequest): Promise<ConnectionCardOutcome> {
  const { createToolApproval } = await import('@/lib/safety/approvals')
  const held = await createToolApproval(service, {
    door: 'chat',
    userId: request.userId,
    workspaceId: request.workspaceId,
    toolName: request.toolName,
    sideEffect: request.sideEffect,
    input: request.input,
    conversationId: request.conversationId ?? null,
    context: { ...(request.approvalContext ?? {}), connection: request.context },
    reason: `connection_${request.context.kind}`,
    card: request.card,
  })
  return held.ok ? { ok: true, approval_id: held.approvalId } : { ok: false, approval_id: null, error: held.error }
}

/** The replay's check: is this the stored call of an accepted card for this connection and kind? */
export function approvedConnectionCard(
  approved: ApprovedCall | undefined,
  tool: ConnectionCardRequest['toolName'],
  kind: ConnectionApprovalContext['kind'],
  connectionId: string,
): ConnectionApprovalContext | null {
  if (!approved || approved.tool !== tool || !approved.connection) return null
  return approved.connection.kind === kind && approved.connection.connection_id === connectionId ? approved.connection : null
}
