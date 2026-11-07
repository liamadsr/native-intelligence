import { authenticateUser, checkUsageLimits } from '@/lib/ai/auth'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { indexCaptureFinished } from '@/lib/ai/index-capture-finished'

export const maxDuration = 60

/**
 * POST /api/ai/index-content
 * Indexes a capture's content: chunks text, generates embeddings, stores in capture_chunks.
 *
 * Body: { captureId: string, title?: string, content?: string, summary?: string, project_id?: string,
 *         capture_processed?: boolean }
 * Also accepts legacy { noteId } for backwards compatibility.
 *
 * `capture_processed: true` says the record is final and no batch pass will
 * run (a live-mode capture whose live agent wrote the notes): the helper then
 * emits flow/capture.processed and stamps batch_processed_at, as the batch
 * finalize does. See indexCaptureFinished.
 *
 * Proposed changes (action items, decisions, etc.) are fetched server-side
 * and included in the indexed text so semantic search can find them.
 *
 * Response: { chunksCreated: number }
 */
export async function POST(req: Request) {
  try {
    const { user, supabase } = await authenticateUser(req)
    // Opted in to the ChatGPT free tier: the claim extraction this sends runs
    // on a free user's own plan (claim-extraction.ts); the embeddings are
    // Dial8's, fractions of a cent, as for every capture.
    await checkUsageLimits(user.id, undefined, { chatgptPlan: true })

    const body = await req.json()
    const { captureId, noteId, title, content, summary, ai_summary, project_id, capture_processed } =
      body as {
        captureId?: string
        noteId?: string
        title?: string
        content?: string
        summary?: string
        ai_summary?: string
        project_id?: string
        capture_processed?: boolean
        // NOTE: a client-supplied workspace_id is intentionally ignored. It
        // must never override the capture row's real workspace — doing so
        // mislabels capture_chunks.workspace_id and misroutes claim
        // extraction. Parsing stays tolerant of its presence in the body.
        workspace_id?: string
      }

    const id = captureId || noteId
    if (!id) {
      return Response.json({ error: 'captureId is required' }, { status: 400 })
    }

    // Resolve the capture row server-side. The client payload can omit
    // project_id / ai_summary even when the row has them — trusting the
    // payload alone is what produced the PROD-only 23502 (NULL project_id
    // into capture_chunks, migration 188) and left extraction blind to the
    // row's real summary.
    const { data: captureRow } = await supabase
      .from('captures')
      .select('workspace_id, project_id, ai_summary, content, metadata, is_eval')
      .eq('id', id)
      .maybeSingle()

    // Resolve workspace from the capture row FIRST (the source of truth) and
    // fall back to the caller's cookie workspace. Never trust a body-supplied
    // workspace_id here.
    const wsId = captureRow?.workspace_id || (await getCurrentWorkspaceId())

    // Extraction send (BEFORE indexing) + capture indexing live in a shared
    // helper so the index-reconciler cron can re-run the identical logic
    // against captures that missed indexing due to the summary-timing race.
    const result = await indexCaptureFinished({
      supabase,
      captureId: id,
      captureRow,
      userId: user.id,
      workspaceId: wsId,
      title,
      content,
      summary,
      ai_summary,
      project_id,
      captureProcessed: capture_processed === true,
    })

    return Response.json(result)
  } catch (error) {
    if (error instanceof Response) return error

    console.error('Index content error:', error)
    return Response.json(
      { error: 'Failed to index content' },
      { status: 500 },
    )
  }
}
