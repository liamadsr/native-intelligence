import { inngest } from '@/lib/inngest/client'

type Send = (event: { name: string; id: string; ts?: number; data: Record<string, unknown> }) => Promise<unknown>

/** How long after a create its loops run: long enough for the person to have written something. */
export const DOCUMENT_CREATED_DELAY_MS = 5 * 60 * 1000

/**
 * Emit `flow/document.created` for a document a PERSON just created, once per
 * document (the event id is keyed on it), delivered DOCUMENT_CREATED_DELAY_MS
 * later (Inngest `ts`) so the run reads what they wrote rather than an empty
 * "Untitled". Called only from the documents route's plain create
 * (src/app/api/account/documents/route.ts): an agent's create_document
 * (src/lib/ai/tools/documents.ts, the MCP bridge's too), reference ingest and
 * canon templates never emit. flowDispatchOnDocumentCreated skips a document
 * deleted or archived by then. Ids only. Never throws.
 */
export async function emitDocumentCreated(
  args: { workspaceId: string; documentId: string; now?: number },
  deps: { send?: Send } = {},
): Promise<boolean> {
  const now = args.now ?? Date.now()
  try {
    await (deps.send ?? ((e) => inngest.send(e as never)))({
      name: 'flow/document.created',
      id: `document-created:${args.documentId}`,
      ts: now + DOCUMENT_CREATED_DELAY_MS,
      data: { workspace_id: args.workspaceId, document_id: args.documentId, created_at: new Date(now).toISOString() },
    })
    return true
  } catch (err) {
    console.error('[flows] document created inngest.send failed', err instanceof Error ? err.message : 'unknown')
    return false
  }
}
