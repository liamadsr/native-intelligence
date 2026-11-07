import { requireWorkspace } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { claimIdsHiddenInWorkspace, isMailSourceType } from '@/lib/knowledge/claim-visibility'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * GET /api/account/knowledge
 *
 * Feeds the Knowledge Graph page (/account → Knowledge view). Returns the
 * claims graph in one payload:
 *   - claims:   active, non-dismissed claim nodes
 *   - edges:    entity_link rows where a claim is the source (claim→claim and
 *               claim→entity), with resolved target labels
 *   - sources:  claim_source rows grouped per claim, with resolved labels, so
 *               the Source view can bucket claims by where they came from
 *   - entities: label lookup for any non-claim node referenced by an edge or
 *               source (capture/project/contact/document/attachment)
 *
 * Read-only. Workspace-scoped via the user session (RLS also enforces it).
 *
 * A claim is readable only when one of its sources is (migration 341): one
 * with any email source (Dial8 doesn't learn from mail), or taken only from
 * other people's private captures, is dropped with its edges and sources, and
 * no email is ever a node or a label. RLS hides the same rows once 341 is
 * applied; this holds before it.
 *
 * Query params:
 *   ?limit=N          cap on claims returned (default 10000, max 20000). The
 *                     default is intentionally high so the graph shows the whole
 *                     knowledge base — partial windows drop edges whose other
 *                     endpoint falls outside the window, which reads as an
 *                     unconnected graph.
 *   ?confirmation=... filter (suggested|confirmed). Default: both (exclude dismissed)
 */

const CITABLE = [
  'capture',
  'attachment',
  'document',
  'project',
  'contact',
  'action',
] as const

/** Coerce an unknown column value to a trimmed string ('' if null/non-string). */
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

// PostgREST caps a single response at (by default) 1000 rows regardless of
// .limit(), so a workspace with thousands of claims/edges would silently
// truncate — which is exactly what made the prod graph look unconnected
// (edges past row 1000 never arrived). Page through .range() until a short
// page signals the end. `cap` bounds total work so a pathological dataset
// can't loop unbounded.
const PAGE_SIZE = 1000

async function fetchAll<T>(
  makeQuery: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  cap: number,
): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = []
  for (let from = 0; from < cap; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE, cap) - 1
    const { data, error } = await makeQuery(from, to)
    if (error) return { rows, error: error.message }
    const page = data ?? []
    rows.push(...page)
    if (page.length < PAGE_SIZE) break // short page → no more rows
  }
  return { rows, error: null }
}

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const { searchParams } = request.nextUrl
  const limit = Math.min(Number(searchParams.get('limit')) || 10000, 20000)
  const confirmation = searchParams.get('confirmation') // 'suggested' | 'confirmed' | null

  // 1. Claims (nodes). Exclude dismissed; keep suggested + confirmed.
  //    Paged so we get the whole base, not just PostgREST's first 1000 rows.
  type ClaimRow = {
    id: string
    text: string
    type: string
    confidence: number | null
    confirmation: string
    status: string
    scope: string | null
    subject_member_id: string | null
    auto_accepted: boolean | null
    created_at: string
    last_verified_at: string | null
  }
  const { rows: allClaims, error: claimsErr } = await fetchAll<ClaimRow>(
    (from, to) => {
      let q = supabase
        .from('claim')
        .select(
          'id, text, type, confidence, confirmation, status, scope, subject_member_id, auto_accepted, created_at, last_verified_at',
        )
        .eq('workspace_id', workspaceId)
        .neq('confirmation', 'dismissed')
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .range(from, to)
      if (confirmation === 'suggested' || confirmation === 'confirmed') {
        q = q.eq('confirmation', confirmation)
      }
      return q.overrideTypes<ClaimRow[]>()
    },
    limit,
  )
  if (claimsErr)
    return serverError(claimsErr)

  // A claim is readable only when one of its sources is: never one learned
  // from mail, never one taken only from someone else's private capture.
  // Fail closed: if the check can't be read, nothing is shown.
  const hiddenClaims = await claimIdsHiddenInWorkspace(supabase, workspaceId, user.id)
  if (!hiddenClaims) return serverError('Could not read the knowledge graph')
  const claims = allClaims.filter((c) => !hiddenClaims.has(c.id))

  const claimIds = claims.map((c) => c.id)
  if (claimIds.length === 0) {
    return NextResponse.json({
      claims: [],
      edges: [],
      sources: [],
      entities: {},
    })
  }
  const claimIdSet = new Set(claimIds)

  // 2. Edges + 3. Sources (run in parallel), both paged past the 1000-row cap.
  //
  //    Edges: fetch every claim-sourced link in the workspace, then keep only
  //    those whose source is a claim we loaded. This avoids a multi-thousand-id
  //    `.in()` (URL-length blowout) — we filter source membership in memory.
  //
  //    Sources: `claim_source` has no workspace_id, so it must be scoped by
  //    claim_id. We chunk the id list to keep each `.in()` URL bounded and page
  //    within each chunk.
  type EdgeRow = {
    id: string
    source_type: string
    source_id: string
    target_type: string
    target_id: string
    relation: string
    weight: number | null
  }
  type SourceRow = {
    claim_id: string
    source_type: string
    source_id: string | null
    source_uri: string | null
    excerpt: string | null
  }

  const CHUNK = 400 // ids per `.in()` to keep request URLs well under limits

  const edgesPromise = fetchAll<EdgeRow>(
    (from, to) =>
      supabase
        .from('entity_link')
        .select(
          'id, source_type, source_id, target_type, target_id, relation, weight',
        )
        .eq('workspace_id', workspaceId)
        .eq('source_type', 'claim')
        .order('id', { ascending: true })
        .range(from, to)
        .overrideTypes<EdgeRow[]>(),
    // Bound by the total claim-sourced edge space; one edge per row.
    20000,
  ).then(({ rows }) =>
    rows.filter(
      (e) => claimIdSet.has(e.source_id) && !isMailSourceType(e.target_type),
    ),
  )

  // claim_source now carries workspace_id (migration 117), so we fetch the
  // whole workspace's sources in one paged scan and filter to in-scope claims
  // in memory — the same shape as the edges query. This replaces the old
  // CHUNK=400 id-batched loop (many round-trips because the table lacked a
  // workspace_id column).
  const sourcesPromise = fetchAll<SourceRow>(
    (from, to) =>
      supabase
        .from('claim_source')
        .select('claim_id, source_type, source_id, source_uri, excerpt')
        .eq('workspace_id', workspaceId)
        .order('claim_id', { ascending: true })
        .range(from, to)
        .overrideTypes<SourceRow[]>(),
    // A claim can have multiple sources; bound generously across the workspace.
    20000,
  ).then(({ rows }) =>
    rows.filter(
      (s) => claimIdSet.has(s.claim_id) && !isMailSourceType(s.source_type),
    ),
  )

  const [edges, sources] = await Promise.all([edgesPromise, sourcesPromise])

  // 4. Resolve labels for every non-claim entity referenced by an edge target
  //    or a source. Group ids by type, then one query per table.
  const byType: Record<string, Set<string>> = {}
  const note = (type: string, id: string | null | undefined) => {
    if (!id) return
    if (type === 'claim') return // claim labels come from the claims list
    if (!CITABLE.includes(type as (typeof CITABLE)[number])) return
    ;(byType[type] ??= new Set()).add(id)
  }
  for (const e of edges) note(e.target_type, e.target_id)
  for (const s of sources) note(s.source_type, s.source_id)

  const entities: Record<string, { type: string; label: string }> = {}
  // Map each citable type to its table, the columns to select, and how to read
  // a display label from a row. Table + column names are fixed literals (never
  // user input), so the dynamic `.select()` below is not an injection vector.
  const TABLE: Record<
    string,
    {
      table: string
      columns: string
      label: (r: Record<string, unknown>) => string
    }
  > = {
    capture: {
      table: 'captures',
      columns: 'title',
      label: (r) => str(r.title),
    },
    document: {
      table: 'document',
      columns: 'title',
      label: (r) => str(r.title),
    },
    project: { table: 'projects', columns: 'name', label: (r) => str(r.name) },
    contact: {
      // CRM table is `contact` (singular). `full_name` is the canonical display
      // column (migration 033); first/last are also present but full_name is
      // always populated. (The old 'contacts'/first_name+last_name mapping
      // queried a non-existent table, so contact nodes showed "(untitled)".)
      table: 'contact',
      columns: 'full_name',
      label: (r) => str(r.full_name),
    },
    action: { table: 'actions', columns: 'title', label: (r) => str(r.title) },
    attachment: {
      table: 'attachments',
      columns: 'file_name',
      label: (r) => str(r.file_name),
    },
  }
  await Promise.all(
    Object.entries(byType).map(async ([type, idSet]) => {
      const cfg = TABLE[type]
      if (!cfg) return
      const ids = [...idSet]
      // Chunk the id list so each request URL stays bounded and no single
      // response is clipped at the 1000-row cap.
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK)
        // The selected columns are computed at runtime, which defeats the typed
        // query builder's column inference — query through an untyped view.
        const { data: rows } = await supabase
          .from(cfg.table)
          .select(`id, ${cfg.columns}`)
          .eq('workspace_id', workspaceId)
          .in('id', chunk)
          .overrideTypes<Array<Record<string, unknown>>>()
        for (const r of rows ?? []) {
          const rec = r as Record<string, unknown>
          entities[`${type}:${rec.id as string}`] = {
            type,
            label: cfg.label(rec) || '(untitled)',
          }
        }
      }
    }),
  )

  // Keep only edges whose target is either another in-scope claim or a
  // resolved entity (drop edges pointing at claims we didn't load / orphans).
  const keptEdges = edges.filter((e) => {
    if (e.target_type === 'claim') return claimIdSet.has(e.target_id)
    return !!entities[`${e.target_type}:${e.target_id}`]
  })

  return NextResponse.json({
    claims,
    edges: keptEdges,
    sources,
    entities,
  })
}
