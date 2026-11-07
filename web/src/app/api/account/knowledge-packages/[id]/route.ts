import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { fetchPackageClaims } from '@/lib/knowledge/brief'
import { excludeClaimsHiddenFrom } from '@/lib/knowledge/claim-visibility'

/**
 * Single knowledge package. RLS (mig 238's package_row_visible_to /
 * package_row_editable_by predicates) enforces visibility and edit rights —
 * an UPDATE/DELETE the caller isn't entitled to simply matches zero rows.
 *
 *   GET    → package + pinned items + rule-resolved claims (shared resolver) + brief
 *   PATCH  → name / description / visibility / team_id / rules
 *   DELETE → remove the package (items cascade; claims are untouched — a
 *            package is a view, never the storage)
 */

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: RouteContext) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params

  const { data: pkg, error } = await supabase
    .from('knowledge_package')
    .select('id, name, slug, description, visibility, team_id, rules, created_by, created_at, updated_at')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) return serverError(error.message)
  if (!pkg) return notFound('Package not found')

  const [{ data: items }, claims, { data: brief }] = await Promise.all([
    supabase
      .from('knowledge_package_item')
      .select('entity_type, entity_id, added_by, created_at')
      .eq('package_id', pkg.id)
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: true })
      .limit(200),
    // A claim is readable only when one of its sources is; mail never is (341).
    fetchPackageClaims(supabase, workspaceId, pkg.id, 60).then((rows) =>
      excludeClaimsHiddenFrom(supabase, rows, user.id),
    ),
    supabase
      .from('knowledge_brief')
      .select('content, generated_at, claim_count')
      .eq('workspace_id', workspaceId)
      .eq('scope_type', 'package')
      .eq('scope_id', pkg.id)
      .maybeSingle(),
  ])

  // Resolve display labels for pinned items so the UI never shows bare UUIDs.
  const LABEL_TABLES: Record<string, { table: string; column: string }> = {
    claim: { table: 'claim', column: 'text' },
    project: { table: 'projects', column: 'name' },
    document: { table: 'document', column: 'title' },
    capture: { table: 'captures', column: 'title' },
    contact: { table: 'contact', column: 'full_name' },
    action: { table: 'actions', column: 'title' },
  }
  const labels = new Map<string, string>()
  const byType = new Map<string, string[]>()
  for (const it of items ?? []) {
    const t = it.entity_type as string
    if (!LABEL_TABLES[t]) continue
    ;(byType.get(t) ?? byType.set(t, []).get(t)!).push(it.entity_id as string)
  }
  await Promise.all(
    [...byType.entries()].map(async ([type, ids]) => {
      const cfg = LABEL_TABLES[type]
      // Dynamic column names defeat supabase-js's literal-type parser; the
      // runtime shape is just { id, <column> } rows.
      const { data } = (await supabase
        .from(cfg.table)
        .select(`id, ${cfg.column}`)
        .eq('workspace_id', workspaceId)
        .in('id', ids)) as unknown as { data: Array<Record<string, unknown>> | null }
      for (const row of data ?? []) {
        labels.set(`${type}:${row.id as string}`, String(row[cfg.column] ?? '').slice(0, 140))
      }
    }),
  )

  return Response.json({
    package: pkg,
    items: (items ?? []).map((it) => ({
      ...it,
      label: labels.get(`${it.entity_type}:${it.entity_id}`) ?? null,
    })),
    claims,
    brief: brief ?? null,
    export_url: `/api/account/knowledge-packages/${pkg.id}/export`,
  })
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return badRequest('Invalid body')

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (typeof body.name === 'string' && body.name.trim()) updates.name = body.name.trim()
  if ('description' in body) updates.description = body.description ?? null
  if (typeof body.visibility === 'string') {
    if (!['personal', 'team', 'workspace'].includes(body.visibility)) {
      return badRequest('invalid visibility')
    }
    updates.visibility = body.visibility
  }
  if ('team_id' in body) updates.team_id = body.team_id ?? null
  if (body.rules && typeof body.rules === 'object') updates.rules = body.rules

  // Mirror the POST-side invariant on the RESULTING row: team visibility with
  // a null team makes the package visible to nobody but its creator/shares —
  // always a mistake. Needs the current row when only one of the two fields
  // is in the patch. (SELECT-visible ≠ editable; the UPDATE below still runs
  // under the edit RLS policy.)
  if ('visibility' in updates || 'team_id' in updates) {
    const { data: existing } = await supabase
      .from('knowledge_package')
      .select('visibility, team_id')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (!existing) return notFound('Package not found or not editable')
    const nextVisibility = (updates.visibility as string | undefined) ?? existing.visibility
    const nextTeamId = 'team_id' in updates ? updates.team_id : existing.team_id
    if (nextVisibility === 'team' && !nextTeamId) {
      return badRequest('team visibility requires team_id')
    }
  }

  const { data, error } = await supabase
    .from('knowledge_package')
    .update(updates)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select('id, name, slug, description, visibility, team_id, rules, updated_at')
    .maybeSingle()
  if (error) return serverError(error.message)
  if (!data) return notFound('Package not found or not editable')
  return Response.json({ package: data })
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params

  const { error, count } = await supabase
    .from('knowledge_package')
    .delete({ count: 'exact' })
    .eq('id', id)
    .eq('workspace_id', workspaceId)
  if (error) return serverError(error.message)
  if (!count) return notFound('Package not found or not deletable')
  return Response.json({ ok: true })
}
