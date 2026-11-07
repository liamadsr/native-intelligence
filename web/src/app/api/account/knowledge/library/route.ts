import { requireWorkspace } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'

// PostgREST caps a response at 1000 rows regardless of .limit(), so the
// claims, edges and package-item pulls are paged with .range() until a short
// page (same as knowledge/route.ts). `cap` keeps each pull bounded.
const PAGE_SIZE = 1000

async function fetchAll<T>(
  makeQuery: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  cap: number,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const rows: T[] = []
  for (let from = 0; from < cap; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE, cap) - 1
    const { data, error } = await makeQuery(from, to)
    if (error) return { data: rows, error }
    const page = data ?? []
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  return { data: rows, error: null }
}

/**
 * GET /api/account/knowledge/library — one call powering the knowledge
 * library view (the brief-first sibling of the graph):
 *
 *   workspace_brief — the compiled workspace world model
 *   projects        — every project with knowledge: claim counts, open
 *                     questions, last activity, its compiled brief, and its
 *                     reference-wiki index docs
 *   packages        — the curated, gated scopes (RLS already filters to what
 *                     the caller may see)
 *
 * Counts are computed from one bounded claims pull + one edges pull (claims
 * are ranked/capped the same way everywhere else in the system; at the
 * current scale this is two indexed queries).
 */
export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const [briefsRes, claimsRes, edgesRes, projectsRes, specsRes, packagesRes] =
    await Promise.all([
      supabase
        .from('knowledge_brief')
        .select('scope_type, scope_id, content, generated_at, claim_count')
        .eq('workspace_id', workspaceId),
      fetchAll(
        (from, to) =>
          supabase
            .from('claim')
            .select('id, type, confirmation, updated_at')
            .eq('workspace_id', workspaceId)
            .eq('status', 'active')
            .neq('confirmation', 'dismissed')
            .order('id')
            .range(from, to),
        5000,
      ),
      fetchAll(
        (from, to) =>
          supabase
            .from('entity_link')
            .select('source_id, target_id')
            .eq('workspace_id', workspaceId)
            .eq('source_type', 'claim')
            .eq('target_type', 'project')
            .order('id')
            .range(from, to),
        10000,
      ),
      supabase
        .from('projects')
        .select('id, name, status')
        .eq('workspace_id', workspaceId)
        .limit(200),
      supabase
        .from('document')
        .select('id, slug, title, project_id')
        .eq('workspace_id', workspaceId)
        .eq('type', 'spec')
        .eq('status', 'active')
        .contains('frontmatter', { page_kind: 'index' })
        .limit(50),
      supabase
        .from('knowledge_package')
        .select('id, name, slug, description, visibility, team_id, rules, created_by, updated_at')
        .eq('workspace_id', workspaceId)
        .order('updated_at', { ascending: false })
        .limit(100),
    ])

  const firstError =
    briefsRes.error ?? claimsRes.error ?? edgesRes.error ?? projectsRes.error ?? specsRes.error ?? packagesRes.error
  if (firstError) return serverError(firstError.message)

  const briefs = briefsRes.data ?? []
  const claims = claimsRes.data ?? []
  const edges = edgesRes.data ?? []
  const projects = projectsRes.data ?? []
  const specs = specsRes.data ?? []
  const packages = packagesRes.data ?? []

  const claimById = new Map(claims.map((c) => [c.id as string, c]))

  // Per-project rollups from the about-edges.
  interface ProjectStats {
    claim_count: number
    confirmed: number
    open_questions: number
    last_claim_at: string | null
  }
  const stats = new Map<string, ProjectStats>()
  for (const e of edges) {
    const claim = claimById.get(e.source_id as string)
    if (!claim) continue
    const pid = e.target_id as string
    const s =
      stats.get(pid) ??
      ({ claim_count: 0, confirmed: 0, open_questions: 0, last_claim_at: null } as ProjectStats)
    s.claim_count += 1
    if (claim.confirmation === 'confirmed') s.confirmed += 1
    if (claim.type === 'open_question') s.open_questions += 1
    if (!s.last_claim_at || (claim.updated_at as string) > s.last_claim_at) {
      s.last_claim_at = claim.updated_at as string
    }
    stats.set(pid, s)
  }

  const briefFor = (scopeType: string, scopeId: string | null) =>
    briefs.find(
      (b) => b.scope_type === scopeType && (b.scope_id ?? null) === scopeId,
    ) ?? null

  const specsByProject = new Map<string, Array<{ id: string; slug: string; title: string }>>()
  for (const d of specs) {
    const pid = (d.project_id as string | null) ?? ''
    if (!pid) continue
    ;(specsByProject.get(pid) ?? specsByProject.set(pid, []).get(pid)!).push({
      id: d.id as string,
      slug: d.slug as string,
      title: d.title as string,
    })
  }

  // Pinned-item counts per package.
  const itemCounts = new Map<string, number>()
  if (packages.length) {
    const { data: items } = await fetchAll(
      (from, to) =>
        supabase
          .from('knowledge_package_item')
          .select('package_id')
          .in('package_id', packages.map((p) => p.id))
          // No id column: order by the primary key for stable pages.
          .order('package_id')
          .order('entity_type')
          .order('entity_id')
          .range(from, to),
      5000,
    )
    for (const it of items) {
      itemCounts.set(it.package_id as string, (itemCounts.get(it.package_id as string) ?? 0) + 1)
    }
  }

  const workspaceBrief = briefFor('workspace', null)

  return Response.json({
    workspace_brief: workspaceBrief
      ? { content: workspaceBrief.content, generated_at: workspaceBrief.generated_at }
      : null,
    total_claims: claims.length,
    suggested_claims: claims.filter((c) => c.confirmation === 'suggested').length,
    projects: projects
      .map((p) => {
        const s = stats.get(p.id as string)
        const brief = briefFor('project', p.id as string)
        const specDocs = specsByProject.get(p.id as string) ?? []
        return {
          id: p.id,
          name: p.name,
          status: p.status,
          claim_count: s?.claim_count ?? 0,
          confirmed: s?.confirmed ?? 0,
          open_questions: s?.open_questions ?? 0,
          last_claim_at: s?.last_claim_at ?? null,
          brief: brief ? { content: brief.content, generated_at: brief.generated_at } : null,
          spec_docs: specDocs,
        }
      })
      .filter((p) => p.claim_count > 0 || p.spec_docs.length > 0)
      .sort((a, b) => (b.last_claim_at ?? '').localeCompare(a.last_claim_at ?? '')),
    packages: packages.map((p) => ({
      ...p,
      pinned_items: itemCounts.get(p.id as string) ?? 0,
      has_brief: !!briefFor('package', p.id as string),
    })),
  })
}
