import { NextResponse, type NextRequest } from 'next/server'
import { createStatelessClient } from '@/lib/supabase/stateless'
import { requireCronSecret } from '@/lib/api-auth'
import { runCanonFreshness } from '@/lib/documents/canon-freshness'
import { archiveStaleReports } from '@/lib/documents/report-archive'

/**
 * POST /api/cron/wiki-maintenance — daily wiki-health pass.
 *
 * Per workspace, surfaces:
 *  - **Stale claims**: confirmed claims whose last_verified_at is > 90 days old.
 *  - **Orphan documents**: published docs with no inbound entity_link rows and
 *    no edits in 60 days.
 *  - **Broken wikilinks**: published docs that contain `[[slug]]` pointing at
 *    slugs that don't exist in the workspace.
 *
 * And it acts (canon documents D3, documents-as-ground-truth.md §3.5):
 *  - **Canon freshness**: each canon document's section checks follow its
 *    text, so a section nobody has changed or confirmed in 90 days shows a
 *    quiet "not checked since" marker in its document. No card
 *    (src/lib/documents/canon-freshness.ts).
 *  - **Reports and preps archive themselves** (decision 18): one nobody
 *    changed or opened in 30 days and nothing links to is archived, hidden
 *    from lists and search, never deleted, still reachable by id from its
 *    flow's run history (src/lib/documents/report-archive.ts).
 *
 * The counts above are still only logged: a structured console.log line per
 * workspace, visible in the web container's logs (no notification type for them exists).
 *
 * Schedule: daily at 04:00 UTC. The server's cron always issues GET with
 * `Authorization: Bearer ${CRON_SECRET}`, so the handler is exported as GET.
 * POST is aliased below so manual curl-triggering still works.
 */

const STALE_DAYS = 90
const ORPHAN_DAYS = 60
const WIKILINK_RE = /\[\[([a-zA-Z0-9_\-./]+)(?:\|[^\]]+)?\]\]/g

interface WorkspaceSummary {
  workspace_id: string
  canon_documents: number
  canon_sections_synced: number
  reports_archived: number
  stale_claims: number
  orphan_documents: number
  broken_wikilinks: number
  examined_documents: number
  examined_claims: number
}

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const supabase = createStatelessClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const { data: workspaces } = await supabase.from('workspace').select('id')
  if (!workspaces || workspaces.length === 0) {
    return NextResponse.json({ workspaces: [], total: 0 })
  }

  const staleCutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const orphanCutoff = new Date(Date.now() - ORPHAN_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const summaries: WorkspaceSummary[] = []

  for (const ws of workspaces) {
    const workspaceId = ws.id as string
    const summary: WorkspaceSummary = {
      workspace_id: workspaceId,
      canon_documents: 0,
      canon_sections_synced: 0,
      reports_archived: 0,
      stale_claims: 0,
      orphan_documents: 0,
      broken_wikilinks: 0,
      examined_documents: 0,
      examined_claims: 0,
    }

    // 0. Canon freshness: section checks in step with the text (the
    //    document view's "not checked since" marker reads them). Never throws.
    const freshness = await runCanonFreshness(supabase, workspaceId)
    summary.canon_documents = freshness.documents
    summary.canon_sections_synced = freshness.synced
    // 0b. Decision 18: stale reports and preps leave the lists. Never throws.
    summary.reports_archived = await archiveStaleReports(supabase, workspaceId)

    // 1. Stale confirmed claims — never verified, or verified > 90d ago.
    const { count: staleCount } = await supabase
      .from('claim')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('confirmation', 'confirmed')
      .eq('status', 'active')
      .or(`last_verified_at.is.null,last_verified_at.lt.${staleCutoff}`)
    summary.stale_claims = staleCount ?? 0

    const { count: totalClaims } = await supabase
      .from('claim')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
    summary.examined_claims = totalClaims ?? 0

    // 2. Orphan published docs — no inbound entity_link rows AND no edits in 60d.
    const { data: docs } = await supabase
      .from('document')
      .select('id, content, updated_at')
      .eq('workspace_id', workspaceId)
      .eq('status', 'active')
      .eq('published_status', 'published')
      .lt('updated_at', orphanCutoff)
      .limit(500)

    summary.examined_documents = docs?.length ?? 0

    if (docs && docs.length > 0) {
      const docIds = docs.map((d) => d.id as string)
      const { data: inboundCounts } = await supabase
        .from('entity_link')
        .select('target_id')
        .eq('workspace_id', workspaceId)
        .eq('target_type', 'document')
        .in('target_id', docIds)

      const withInbound = new Set<string>()
      for (const row of inboundCounts || []) withInbound.add(row.target_id as string)
      summary.orphan_documents = docIds.filter((id) => !withInbound.has(id)).length
    }

    // 3. Broken wikilinks across all published docs.
    const { data: allPublished } = await supabase
      .from('document')
      .select('content')
      .eq('workspace_id', workspaceId)
      .eq('status', 'active')
      .eq('published_status', 'published')
      .limit(2000)

    const referencedSlugs = new Set<string>()
    for (const d of allPublished || []) {
      const body = (d.content as string | null) || ''
      if (!body.includes('[[')) continue
      WIKILINK_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = WIKILINK_RE.exec(body)) !== null) {
        referencedSlugs.add(m[1])
      }
    }

    if (referencedSlugs.size > 0) {
      const slugArray = Array.from(referencedSlugs)
      const { data: existing } = await supabase
        .from('document')
        .select('slug')
        .eq('workspace_id', workspaceId)
        .in('slug', slugArray)
      const existingSet = new Set<string>()
      for (const row of existing || []) {
        if (row.slug) existingSet.add(row.slug as string)
      }
      summary.broken_wikilinks = slugArray.filter((s) => !existingSet.has(s)).length
    }

    // Surface the per-workspace result in the web container's logs. No notification
    // fan-out exists yet, so this structured line is the only place the
    // health counts are visible until a digest is wired up.
    console.log('[wiki-maintenance] workspace summary', JSON.stringify(summary))

    summaries.push(summary)
  }

  return NextResponse.json({
    workspaces: summaries,
    total: summaries.length,
  })
}

// Allow manual curl-triggering via POST too (same handler, same bearer check).
export const POST = GET
