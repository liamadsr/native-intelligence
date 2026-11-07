import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import {
  reconcileProvenance,
  type ReconciledProvenance,
} from '@/lib/ai/tools/claims'
import { excludeClaimsHiddenFrom } from '@/lib/knowledge/claim-visibility'
import { NextResponse, type NextRequest } from 'next/server'
import { fetchAllRows, inChunks } from '@/lib/supabase/paging'

/**
 * GET /api/account/knowledge/entity-context?type=contact|project|company&id=<uuid>
 *
 * Read-side surface for the knowledge graph on the CRM detail panels
 * (plan items 20b + 20d, and the non-member-commitments surface of 22).
 *
 * For BOTH types it returns `claims`: the active, non-dismissed claims linked
 * to the entity via `entity_link` edges in EITHER direction and under ANY
 * relation (about / mentions / committed_to / …). This mirrors the entity
 * filter in `list_claims` (src/lib/ai/tools/claims.ts) — edges are
 * bidirectional, so we collect claim ids where the entity is the edge target
 * AND where it is the edge source, then union. `record_commitment` files an
 * external person's commitment as an `about`-edge claim, so a contact's claim
 * list IS where non-member commitments surface.
 *
 * Claims are ordered by `event_at` (real-world event time, migration 180) DESC
 * with NULLS LAST, capped at ~10, and each carries its top excerpt (reconciled
 * from claim_source + cites/about edges via the shared reconcileProvenance).
 *
 * For the ANCHOR types (`project`, `company`) it additionally returns `brief`:
 * the entity's compiled knowledge_brief row (scope_type=<type>, scope_id=<id>),
 * which the panel renders as markdown. Null when nothing is compiled yet.
 * `contact` gets no brief — it anchors claims but the weaver compiles no
 * per-contact brief.
 *
 * Workspace-scoped via the user session (RLS also enforces it). Read-only.
 */

const CLAIM_LIMIT = 10

// One excerpt-bearing provenance entry, shaped for the panel.
interface ClaimExcerpt {
  excerpt: string
  source_label: string | null
  source_type: string
}

interface ClaimRow {
  id: string
  text: string
  type: string
  confirmation: string
  status: string
  event_at: string | null
  created_at: string
}

interface EntityClaim {
  id: string
  text: string
  type: string
  confirmation: string
  status: string
  event_at: string | null
  created_at: string
  excerpt: ClaimExcerpt | null
}

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const { searchParams } = request.nextUrl
  const type = searchParams.get('type')
  const id = searchParams.get('id')

  if (type !== 'contact' && type !== 'project' && type !== 'company') {
    return badRequest('type must be "contact", "project", or "company"')
  }
  if (!id) {
    return badRequest('id is required')
  }

  // ── Claims linked to the entity (bidirectional, any relation) ──────────────
  // Same shape as list_claims' entity filter: an edge can be claim→entity OR
  // entity→claim, so union the two id sets. Paged: a busy hub carries more
  // than one 1000-row response of edges.
  const [outbound, inbound] = await Promise.all([
    // claim --(edge)--> entity
    fetchAllRows(() =>
      supabase
        .from('entity_link')
        .select('id, source_id')
        .eq('workspace_id', workspaceId)
        .eq('source_type', 'claim')
        .eq('target_type', type)
        .eq('target_id', id),
    ),
    // entity --(edge)--> claim
    fetchAllRows(() =>
      supabase
        .from('entity_link')
        .select('id, target_id')
        .eq('workspace_id', workspaceId)
        .eq('source_type', type)
        .eq('source_id', id)
        .eq('target_type', 'claim'),
    ),
  ])
  if (outbound.error) return serverError(outbound.error.message)
  if (inbound.error) return serverError(inbound.error.message)

  const claimIdSet = new Set<string>([
    ...outbound.data.map((l) => l.source_id as string),
    ...inbound.data.map((l) => l.target_id as string),
  ])

  let claims: EntityClaim[] = []
  if (claimIdSet.size > 0) {
    // Active, non-dismissed only — the panel surfaces live knowledge, not
    // superseded/dismissed rows. Order event_at DESC NULLS LAST so the most
    // recent real-world facts lead; unknown-time claims sink to the bottom
    // rather than being dropped. Cap to CLAIM_LIMIT for a compact section.
    // Chunked (hundreds of ids overflow one URL): each chunk returns its own
    // top CLAIM_LIMIT, and the merge below re-applies the order and the cap.
    const { data, error } = await inChunks([...claimIdSet], 200, (chunkIds) =>
      supabase
        .from('claim')
        .select('id, text, type, confirmation, status, event_at, created_at')
        .eq('workspace_id', workspaceId)
        .in('id', chunkIds)
        .neq('confirmation', 'dismissed')
        .eq('status', 'active')
        .order('event_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(CLAIM_LIMIT),
    )
    if (error) return serverError(error.message)

    const fetched = (data as ClaimRow[])
      .sort(
        (a, b) =>
          (b.event_at ?? '').localeCompare(a.event_at ?? '') ||
          b.created_at.localeCompare(a.created_at),
      )
      .slice(0, CLAIM_LIMIT)
    // A claim is readable only when one of its sources is; mail never is (341).
    const rows = await excludeClaimsHiddenFrom(supabase, fetched, user.id)

    // Attach the top excerpt per claim. reconcileProvenance batches evidence +
    // graph edges over all claim ids in two queries. We surface the first entry
    // that actually carries an excerpt (excerpt-bearing rows come from
    // claim_source), falling back to null when a claim has no evidence text.
    const provMap =
      rows.length > 0
        ? await reconcileProvenance(
            supabase,
            workspaceId,
            rows.map((r) => r.id),
          )
        : new Map<string, ReconciledProvenance[]>()

    claims = rows.map((r) => {
      const prov = provMap.get(r.id) ?? []
      const withExcerpt = prov.find(
        (p) => typeof p.excerpt === 'string' && p.excerpt.trim().length > 0,
      )
      const excerpt: ClaimExcerpt | null = withExcerpt
        ? {
            excerpt: withExcerpt.excerpt as string,
            source_label: null,
            source_type: withExcerpt.entity_type,
          }
        : null
      return {
        id: r.id,
        text: r.text,
        type: r.type,
        confirmation: r.confirmation,
        status: r.status,
        event_at: r.event_at,
        created_at: r.created_at,
        excerpt,
      }
    })
  }

  // ── Anchor brief (anchor types only) ───────────────────────────────────────
  // Every ANCHOR type gets the same treatment: its compiled knowledge_brief row
  // keyed by (scope_type, scope_id). `contact` is excluded deliberately —
  // contacts anchor claims (via `committed_to`) but the weaver compiles no
  // per-contact brief, so asking for one is a guaranteed miss.
  if (type === 'project' || type === 'company') {
    const { data: brief, error: briefErr } = await supabase
      .from('knowledge_brief')
      .select('content, claim_count, generated_at')
      .eq('workspace_id', workspaceId)
      .eq('scope_type', type)
      .eq('scope_id', id)
      .maybeSingle()
    if (briefErr) return serverError(briefErr.message)

    return NextResponse.json({
      type,
      brief: brief
        ? {
            content: brief.content as string,
            claim_count: (brief.claim_count as number) ?? 0,
            generated_at: brief.generated_at as string,
          }
        : null,
      claims,
    })
  }

  return NextResponse.json({ type, claims })
}
