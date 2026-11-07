import { authenticateUser } from '@/lib/ai/auth'
import { embed } from '@/lib/ai/embeddings'
import { getCurrentWorkspaceId } from '@/lib/workspace'

/**
 * POST /api/ai/rag
 * Performs RAG search: embeds query, searches capture_chunks via pgvector, returns ranked results.
 *
 * Body: { query: string, projectIds?: string[], captureIds?: string[], limit?: number, threshold?: number }
 * Also accepts legacy { noteIds } for backwards compatibility.
 * Response: { chunks: Array<{ capture_id, chunk_text, similarity, capture_title?, project_id? }> }
 */
export async function POST(req: Request) {
  try {
    const { user, supabase } = await authenticateUser(req)
    const workspaceId = await getCurrentWorkspaceId()

    const body = await req.json()
    const {
      query,
      projectIds,
      captureIds,
      noteIds,
      limit = 10,
      threshold = 0.3,
    } = body as {
      query: string
      projectIds?: string[]
      captureIds?: string[]
      noteIds?: string[]
      limit?: number
      threshold?: number
    }

    if (!query) {
      return Response.json({ error: 'query is required' }, { status: 400 })
    }

    // 1. Embed the query
    const queryEmbedding = await embed(query, user.id)

    // 2. Vector search via rag_search RPC (param names kept for backwards compat with DB function)
    const { data, error } = await supabase.rpc('rag_search', {
      p_user_id: user.id,
      p_project_ids: projectIds || [],
      p_note_ids: captureIds || noteIds || [],
      p_embedding: JSON.stringify(queryEmbedding),
      p_limit: limit,
      p_threshold: threshold,
      p_workspace_id: workspaceId || null,
    })

    if (error) {
      console.error('RAG search error:', error)
      return Response.json({ error: error.message }, { status: 500 })
    }

    return Response.json({ chunks: data || [], count: data?.length || 0 })
  } catch (error) {
    if (error instanceof Response) return error

    console.error('RAG route error:', error)
    return Response.json({ error: 'Search failed' }, { status: 500 })
  }
}
