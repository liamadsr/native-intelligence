/**
 * The verified card for deleting a document for good (GEN-1169,
 * delete_document). A hard delete can't be undone, so the agent never makes
 * it on its own word: it is the existing approval machinery
 * (src/lib/safety/approvals.ts, migration 335), like the F1 flow delete card
 * (src/lib/flows/flow-approvals.ts) and the F2 connection cards
 * (src/lib/connections/connection-cards.ts). A tool_approval row and an
 * attention_item card in the person's own queue, run once, as them, on their
 * own Accept, after every re-check there. The model can never accept one.
 *
 * The stored call is delete_document itself, replayed with `approvedCall`
 * (src/lib/safety/approved-call.ts). The card records the document's revision:
 * the replay refuses when the document's text changed after the card was made,
 * so a card can't delete something other than what it showed.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ApprovedCall, DocumentApprovalContext } from '@/lib/safety/approved-call'
import type { ApprovalContext } from '@/lib/safety/approvals'

export interface DocumentDeleteCardRequest {
  userId: string
  workspaceId: string
  /** The tool's real input (the card's words carry the title and history). */
  input: Record<string, unknown>
  card: { title: string; why: string }
  context: DocumentApprovalContext
  conversationId?: string | null
  /** The chat door's re-check context (agent persona, surface, teammate): its ceiling applies at Accept. */
  approvalContext?: Omit<ApprovalContext, 'flow' | 'connection' | 'bots' | 'document'>
}

export interface DocumentDeleteCardOutcome {
  ok: boolean
  approval_id: string | null
  error?: string
}

/**
 * Hold the delete as the person's verified card. The approvals module is
 * loaded lazily: it imports createTools, which imports the document tools.
 */
export async function raiseDocumentDeleteCard(service: SupabaseClient, request: DocumentDeleteCardRequest): Promise<DocumentDeleteCardOutcome> {
  const { createToolApproval } = await import('@/lib/safety/approvals')
  const held = await createToolApproval(service, {
    door: 'chat',
    userId: request.userId,
    workspaceId: request.workspaceId,
    toolName: 'delete_document',
    sideEffect: 'delete',
    input: request.input,
    conversationId: request.conversationId ?? null,
    context: { ...(request.approvalContext ?? {}), document: request.context },
    reason: 'document_delete',
    card: request.card,
  })
  return held.ok ? { ok: true, approval_id: held.approvalId } : { ok: false, approval_id: null, error: held.error }
}

/** The replay's check: is this the stored call of an accepted delete card for this document? */
export function approvedDocumentDelete(approved: ApprovedCall | undefined, documentId: string): DocumentApprovalContext | null {
  if (!approved || approved.tool !== 'delete_document' || !approved.document) return null
  return approved.document.kind === 'delete' && approved.document.document_id === documentId ? approved.document : null
}
