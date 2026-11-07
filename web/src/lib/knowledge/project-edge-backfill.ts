/**
 * Mechanical `about→project` edge backfill (knowledge-recall plan item 15).
 *
 * Historical damage this repairs: for a long window, document-sourced claims
 * never got an `about→project` edge (a straight bug — the document fetch didn't
 * select `project_id`; fixed forward in claim-extraction.ts), and any capture/
 * attachment processed before its source had a project assigned also missed the
 * edge. A claim with no `about→project` edge is invisible to the project-scoped
 * recall query (`list_claims entity_type='project'`), so "what's new on project
 * X" silently undercounts.
 *
 * This backfill is the MECHANICAL tier only: it links a claim to a project ONLY
 * when the claim's own `claim_source` points at a capture / document / attachment
 * that carries a resolvable `project_id`. It writes nothing for email /
 * conversation / external_url sources (they structurally have no project to
 * inherit — that's the weaver judge's job, a separate track). It is idempotent:
 * every edge is upserted against entity_link's unique constraint, so re-running
 * is a no-op for edges that already exist.
 *
 * The decision logic (which claims → which edges) is a PURE function
 * (`computeProjectEdgePlan`) so it is unit-testable without a database. The
 * `runProjectEdgeBackfill` orchestrator does the paging + IO and supports a
 * dry-run mode that only counts. The `scripts/backfill-claim-project-edges.ts`
 * runner is a thin wrapper over `runProjectEdgeBackfill`.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** Source types that can carry a mechanically-inheritable project_id. */
export const PROJECT_BEARING_SOURCE_TYPES = ['capture', 'document', 'attachment'] as const
export type ProjectBearingSourceType = (typeof PROJECT_BEARING_SOURCE_TYPES)[number]

export interface CandidateClaim {
  id: string
  workspace_id: string
}

/** A (source_type, source_id) pointer from claim_source, for one claim. */
export interface ClaimSourceRef {
  claim_id: string
  source_type: string
  source_id: string | null
}

/** The edge row this backfill writes — matches attachClaimProvenance's shape. */
export interface ProjectEdge {
  workspace_id: string
  source_type: 'claim'
  source_id: string
  target_type: 'project'
  target_id: string
  relation: 'about'
}

export interface EdgePlan {
  /** Edges to upsert (idempotent). One per claim that has a resolvable project. */
  edges: ProjectEdge[]
  /** Claim ids that had a candidate source but no source resolved to a project. */
  unresolvedClaimIds: string[]
  /** Claim ids whose earliest resolvable source pointed at >1 distinct project. */
  ambiguousClaimIds: string[]
}

const entityKey = (type: string, id: string) => `${type}:${id}`

/**
 * PURE: decide which `about→project` edges to write for a batch of candidate
 * claims. No IO — the caller supplies the resolved inputs.
 *
 * @param claims           candidate claims (already filtered to active + zero
 *                         about→project edge)
 * @param sources          claim_source rows for those claims (capture/document/
 *                         attachment only; other source types are ignored here)
 * @param projectByEntity  map "sourceType:sourceId" → project_id for the sources
 *                         whose parent entity carries a project_id (null/absent
 *                         means "no project on that entity")
 *
 * For each claim we pick the FIRST source (in the given order) that resolves to
 * a project and write a single `about→project` edge — mirroring the extraction
 * path, which writes exactly one `about→project` edge from the source's project.
 * If a claim's sources resolve to more than one distinct project the claim is
 * additionally flagged `ambiguous` (we still write the first, deterministically,
 * so the run stays idempotent).
 */
export function computeProjectEdgePlan(
  claims: CandidateClaim[],
  sources: ClaimSourceRef[],
  projectByEntity: Map<string, string>,
): EdgePlan {
  const workspaceByClaim = new Map<string, string>()
  for (const c of claims) workspaceByClaim.set(c.id, c.workspace_id)

  // claim_id → ordered list of resolvable project ids (from its sources)
  const projectsByClaim = new Map<string, string[]>()
  for (const s of sources) {
    if (!workspaceByClaim.has(s.claim_id)) continue // not a candidate
    if (!s.source_id) continue
    if (!PROJECT_BEARING_SOURCE_TYPES.includes(s.source_type as ProjectBearingSourceType)) continue
    const projectId = projectByEntity.get(entityKey(s.source_type, s.source_id))
    if (!projectId) continue
    const list = projectsByClaim.get(s.claim_id) ?? []
    list.push(projectId)
    projectsByClaim.set(s.claim_id, list)
  }

  const edges: ProjectEdge[] = []
  const unresolvedClaimIds: string[] = []
  const ambiguousClaimIds: string[] = []

  for (const claim of claims) {
    const projects = projectsByClaim.get(claim.id)
    if (!projects || projects.length === 0) {
      unresolvedClaimIds.push(claim.id)
      continue
    }
    if (new Set(projects).size > 1) ambiguousClaimIds.push(claim.id)
    edges.push({
      workspace_id: claim.workspace_id,
      source_type: 'claim',
      source_id: claim.id,
      target_type: 'project',
      target_id: projects[0], // first resolvable, deterministic
      relation: 'about',
    })
  }

  return { edges, unresolvedClaimIds, ambiguousClaimIds }
}

/** claim_source rows per read (PostgREST's default row cap). */
const SOURCE_PAGE = 1000

export interface BackfillOptions {
  /** false = dry-run (count only, write nothing). Default false. */
  apply?: boolean
  /** Restrict to a single workspace. */
  workspaceId?: string | null
  /** claim page size. Default 200. */
  pageSize?: number
  /** Optional progress logger (defaults to no-op). */
  log?: (msg: string) => void
}

export interface BackfillSummary {
  /** active claims scanned (all, before the zero-edge filter). */
  scanned: number
  /** claims that had zero about→project edge (candidates). */
  candidates: number
  /** edges that would be / were written. */
  edgesPlanned: number
  /** edges actually upserted (0 in dry-run). */
  edgesWritten: number
  /** candidates whose sources never resolved to a project (left for the judge). */
  unresolved: number
  /** candidates whose sources resolved to >1 distinct project. */
  ambiguous: number
  applied: boolean
}

/**
 * Orchestrate the mechanical backfill: page over active claims, find those with
 * zero `about→project` edge, resolve each candidate's capture/document/attachment
 * source project_ids, and (when `apply`) idempotently upsert the missing edges.
 *
 * Requires a service-role client (RLS would otherwise hide cross-user rows and
 * silently write nothing). Dry-run by default.
 */
export async function runProjectEdgeBackfill(
  supabase: SupabaseClient,
  opts: BackfillOptions = {},
): Promise<BackfillSummary> {
  const apply = opts.apply ?? false
  const workspaceFilter = opts.workspaceId ?? null
  // 200, not 1000: each page's ids go into `.in()` filters (URL length — see
  // graph-map/source.ts's 300-id chunks) and its edge probe is read unranged.
  const pageSize = opts.pageSize ?? 200
  const log = opts.log ?? (() => {})

  const summary: BackfillSummary = {
    scanned: 0,
    candidates: 0,
    edgesPlanned: 0,
    edgesWritten: 0,
    unresolved: 0,
    ambiguous: 0,
    applied: apply,
  }

  for (let offset = 0; ; offset += pageSize) {
    // 1. Page of active claims.
    let claimQuery = supabase
      .from('claim')
      .select('id, workspace_id')
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      // Deterministic tiebreaker: created_at is not unique, so ties can shuffle
      // across page boundaries and silently skip (or duplicate) rows. Order by
      // id as the secondary key to make paging stable.
      .order('id', { ascending: true })
      .range(offset, offset + pageSize - 1)
    if (workspaceFilter) claimQuery = claimQuery.eq('workspace_id', workspaceFilter)
    const { data: claimPage, error: claimErr } = await claimQuery
    if (claimErr) throw new Error(`claim page @${offset}: ${claimErr.message}`)
    const page = (claimPage ?? []) as CandidateClaim[]
    if (page.length === 0) break
    summary.scanned += page.length

    const pageIds = page.map((c) => c.id)

    // 2. Which of these already have an about→project edge? Exclude them.
    const { data: existing, error: existingErr } = await supabase
      .from('entity_link')
      .select('source_id')
      .eq('source_type', 'claim')
      .eq('target_type', 'project')
      .eq('relation', 'about')
      .in('source_id', pageIds)
    if (existingErr) throw new Error(`entity_link probe @${offset}: ${existingErr.message}`)
    const hasEdge = new Set((existing ?? []).map((e) => e.source_id as string))
    const candidates = page.filter((c) => !hasEdge.has(c.id))
    summary.candidates += candidates.length
    if (candidates.length === 0) {
      if (page.length < pageSize) break
      continue
    }

    // 3. Fetch the candidates' capture/document/attachment sources.
    //    Paged: PostgREST caps an unranged read at 1000 rows, and a page of
    //    claims can carry more sources than that.
    const candidateIds = candidates.map((c) => c.id)
    const sources: ClaimSourceRef[] = []
    for (let from = 0; ; from += SOURCE_PAGE) {
      const { data: sourceRows, error: sourceErr } = await supabase
        .from('claim_source')
        .select('claim_id, source_type, source_id')
        .in('claim_id', candidateIds)
        .in('source_type', [...PROJECT_BEARING_SOURCE_TYPES])
        .not('source_id', 'is', null)
        .order('id', { ascending: true })
        .range(from, from + SOURCE_PAGE - 1)
      if (sourceErr) throw new Error(`claim_source @${offset}: ${sourceErr.message}`)
      const rows = (sourceRows ?? []) as ClaimSourceRef[]
      sources.push(...rows)
      if (rows.length < SOURCE_PAGE) break
    }

    // 4. Resolve project_id per (source_type, source_id) — one query per table.
    const projectByEntity = await resolveSourceProjects(supabase, sources)

    // 5. PURE planning.
    const plan = computeProjectEdgePlan(candidates, sources, projectByEntity)
    summary.edgesPlanned += plan.edges.length
    summary.unresolved += plan.unresolvedClaimIds.length
    summary.ambiguous += plan.ambiguousClaimIds.length
    log(
      `page @${offset}: ${candidates.length} candidate(s), ` +
        `${plan.edges.length} edge(s) to write, ${plan.unresolvedClaimIds.length} unresolved, ` +
        `${plan.ambiguousClaimIds.length} ambiguous`,
    )

    // 6. Write (idempotent upsert) unless dry-run.
    if (apply && plan.edges.length > 0) {
      const { error: upsertErr } = await supabase.from('entity_link').upsert(
        plan.edges.map((e) => ({ ...e, created_by: null })),
        {
          onConflict: 'workspace_id,source_type,source_id,target_type,target_id,relation',
          ignoreDuplicates: true,
        },
      )
      if (upsertErr) throw new Error(`entity_link upsert @${offset}: ${upsertErr.message}`)
      summary.edgesWritten += plan.edges.length
    }

    if (page.length < pageSize) break
  }

  return summary
}

/**
 * Resolve project_id for each distinct (source_type, source_id) among the given
 * sources. capture/document read their direct `project_id` column; attachment
 * reads its direct column first, falling back to attachment_chunks.project_id
 * (which is how claim-extraction inherits an attachment's project). One query
 * per table over the distinct ids in that type.
 */
async function resolveSourceProjects(
  supabase: SupabaseClient,
  sources: ClaimSourceRef[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const idsByType = new Map<ProjectBearingSourceType, Set<string>>()
  for (const s of sources) {
    if (!s.source_id) continue
    if (!PROJECT_BEARING_SOURCE_TYPES.includes(s.source_type as ProjectBearingSourceType)) continue
    const t = s.source_type as ProjectBearingSourceType
    ;(idsByType.get(t) ?? idsByType.set(t, new Set()).get(t)!).add(s.source_id)
  }

  const resolveTable = async (
    sourceType: ProjectBearingSourceType,
    table: string,
    ids: string[],
  ) => {
    if (ids.length === 0) return
    const { data, error } = await supabase
      .from(table)
      .select('id, project_id')
      .in('id', ids)
    if (error) throw new Error(`${table} project_id resolve: ${error.message}`)
    for (const row of (data ?? []) as Array<{ id: string; project_id: string | null }>) {
      if (row.project_id) out.set(entityKey(sourceType, row.id), row.project_id)
    }
  }

  await Promise.all([
    resolveTable('capture', 'captures', [...(idsByType.get('capture') ?? [])]),
    resolveTable('document', 'document', [...(idsByType.get('document') ?? [])]),
    resolveTable('attachment', 'attachments', [...(idsByType.get('attachment') ?? [])]),
  ])

  // Attachment fallback: any attachment id that didn't resolve to a direct
  // project_id may still have one via its chunks (that's the path
  // claim-extraction inherits from). Fill only the still-missing ones.
  const attachmentIds = [...(idsByType.get('attachment') ?? [])]
  const missing = attachmentIds.filter((id) => !out.has(entityKey('attachment', id)))
  if (missing.length > 0) {
    const { data, error } = await supabase
      .from('attachment_chunks')
      .select('attachment_id, project_id')
      .in('attachment_id', missing)
      .not('project_id', 'is', null)
    if (error) throw new Error(`attachment_chunks project_id resolve: ${error.message}`)
    for (const row of (data ?? []) as Array<{ attachment_id: string; project_id: string | null }>) {
      const key = entityKey('attachment', row.attachment_id)
      if (row.project_id && !out.has(key)) out.set(key, row.project_id)
    }
  }

  return out
}
