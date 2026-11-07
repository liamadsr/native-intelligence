import { requireWorkspace } from '@/lib/api-auth'
import { excludeClaimsHiddenFrom } from '@/lib/knowledge/claim-visibility'
import { serverError } from '@/lib/api-errors'

/**
 * GET /api/account/knowledge/review — the pending-review payload for the
 * in-app Review queue popup:
 *
 *   claims  — suggested (unconfirmed) active claims, newest first, each with
 *             its evidence sources inline
 *   drafts  — draft wiki pages awaiting publish
 *
 * This is the client-fetched sibling of the standalone /account/wiki/review
 * page (which loads the same data server-side). The popup uses this so the
 * user can review without leaving the dashboard.
 */

interface ClaimRow {
  id: string
  text: string
  type: string
  confidence: number | null
  created_at: string
}

interface SourceEntry {
  type: string
  id: string | null
  uri: string | null
  excerpt: string | null
}

export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  try {
    const { data: claimsRaw } = await supabase
      .from('claim')
      .select('id, text, type, confidence, created_at')
      .eq('workspace_id', workspaceId)
      .eq('confirmation', 'suggested')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(200)

    const suggested: ClaimRow[] = (claimsRaw || []) as ClaimRow[]

    // Sources for these claims, so the review UI shows evidence inline.
    const claimIds = suggested.map((c) => c.id)
    const sourcesByClaim = new Map<string, SourceEntry[]>()
    if (claimIds.length > 0) {
      const { data: sources, error: sourcesError } = await supabase
        .from('claim_source')
        .select('claim_id, source_type, source_id, source_uri, excerpt')
        .in('claim_id', claimIds)
      // Fail closed: without the sources a claim learned from mail can't be told apart.
      if (sourcesError) throw new Error(sourcesError.message)
      for (const s of sources || []) {
        const list = sourcesByClaim.get(s.claim_id as string) ?? []
        list.push({
          type: s.source_type as string,
          id: (s.source_id as string) ?? null,
          uri: (s.source_uri as string) ?? null,
          excerpt: (s.excerpt as string) ?? null,
        })
        sourcesByClaim.set(s.claim_id as string, list)
      }
    }
    // A claim is readable only when one of its sources is; mail never is
    // (migration 341). Fails closed: a failed check shows nothing.
    const claims = await excludeClaimsHiddenFrom(supabase, suggested, user.id)

    const { data: draftsRaw } = await supabase
      .from('document')
      .select('id, title, slug, type, updated_at')
      .eq('workspace_id', workspaceId)
      .eq('published_status', 'draft')
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(100)

    return Response.json({
      claims: claims.map((c) => ({
        ...c,
        sources: sourcesByClaim.get(c.id) ?? [],
      })),
      drafts: draftsRaw || [],
    })
  } catch (err) {
    console.error('[knowledge/review] failed:', err)
    return serverError('Failed to load review queue.')
  }
}
