import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { excludeClaimsHiddenFrom } from '@/lib/knowledge/claim-visibility'
import { getCurrentWorkspaceIdSafe } from '@/lib/workspace'
import { ReviewClient } from './review-client'

export const dynamic = 'force-dynamic'

interface ClaimRow {
  id: string
  text: string
  type: string
  confidence: number | null
  created_at: string
}

interface DraftDocRow {
  id: string
  title: string
  slug: string | null
  type: string
  updated_at: string
}

interface SourceEntry {
  type: string
  id: string | null
  uri: string | null
  excerpt: string | null
}

export default async function WikiReviewPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const workspaceId = await getCurrentWorkspaceIdSafe()
  if (!workspaceId) {
    return <div className="p-8 text-sm text-muted-foreground">No workspace selected.</div>
  }

  const { data: claimsRaw } = await supabase
    .from('claim')
    .select('id, text, type, confidence, created_at')
    .eq('workspace_id', workspaceId)
    .eq('confirmation', 'suggested')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(200)

  const suggested: ClaimRow[] = (claimsRaw || []) as ClaimRow[]

  // Pull sources for these claims so the review UI shows evidence inline.
  const claimIds = suggested.map((c) => c.id)
  const sourcesByClaim = new Map<string, SourceEntry[]>()
  let sourcesRead = true
  if (claimIds.length > 0) {
    const { data: sources, error: sourcesError } = await supabase
      .from('claim_source')
      .select('claim_id, source_type, source_id, source_uri, excerpt')
      .in('claim_id', claimIds)
    if (sourcesError) sourcesRead = false
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
  // (migration 341). Fail closed: a failed read shows nothing.
  const claims = sourcesRead ? await excludeClaimsHiddenFrom(supabase, suggested, user.id) : []

  const { data: draftsRaw } = await supabase
    .from('document')
    .select('id, title, slug, type, updated_at')
    .eq('workspace_id', workspaceId)
    .eq('published_status', 'draft')
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(100)

  const drafts: DraftDocRow[] = (draftsRaw || []) as DraftDocRow[]

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Review</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pending knowledge from captures, ingested sources, and the agent.
          </p>
        </div>
        <Link href="/account/wiki" className="text-xs text-muted-foreground hover:underline">
          ← Wiki
        </Link>
      </div>

      <ReviewClient
        initialClaims={claims.map((c) => ({
          ...c,
          sources: sourcesByClaim.get(c.id) ?? [],
        }))}
        initialDrafts={drafts}
      />
    </div>
  )
}
