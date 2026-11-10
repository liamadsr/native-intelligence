import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { entityInWorkspace, LINKABLE_ENTITY_TYPES } from '@/lib/ai/tools/claims'
import { canonicalEntityTypeInput } from '@/lib/knowledge/entity-registry'
import { fetchAllRows } from '@/lib/supabase/paging'

/**
 * Knowledge packages collection.
 *
 * Runs under the user's JWT client, so RLS (migrations 124 + 127) enforces
 * visibility — personal/team/workspace plus individual/team shares — without
 * re-implementing the checks here.
 *
 *   GET  → list visible packages with pinned-item counts
 *   POST → create; accepts rules + pins so "promote to package" is one call
 */

const VISIBILITIES = new Set(['personal', 'team', 'workspace'])
const LINKABLE = new Set<string>(LINKABLE_ENTITY_TYPES)

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, '-')
      .slice(0, 60) || 'package'
  )
}

export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { data: packages, error } = await supabase
    .from('knowledge_package')
    .select('id, name, slug, description, visibility, team_id, rules, created_by, created_at, updated_at')
    .eq('workspace_id', workspaceId)
    .order('updated_at', { ascending: false })
    .limit(100)
  if (error) return serverError(error.message)

  const counts = new Map<string, number>()
  if (packages?.length) {
    // Paged: `.limit(5000)` was capped at 1000 rows by PostgREST, which
    // under-counted (or zeroed) pins once the listed packages held more.
    const { data: items, error: itemsError } = await fetchAllRows(
      () =>
        supabase
          .from('knowledge_package_item')
          .select('package_id')
          .in('package_id', packages.map((p) => p.id))
          // No id column: order by the primary key for stable pages.
          .order('package_id')
          .order('entity_type')
          .order('entity_id'),
      { orderBy: null },
    )
    if (itemsError) return serverError(itemsError.message)
    for (const it of items) {
      counts.set(it.package_id as string, (counts.get(it.package_id as string) ?? 0) + 1)
    }
  }

  return Response.json({
    packages: (packages ?? []).map((p) => ({
      ...p,
      pinned_items: counts.get(p.id as string) ?? 0,
    })),
  })
}

export async function POST(request: Request) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const body = await request.json().catch(() => null)
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    return badRequest('name is required')
  }
  const visibility = typeof body.visibility === 'string' ? body.visibility : 'workspace'
  if (!VISIBILITIES.has(visibility)) return badRequest('invalid visibility')
  if (visibility === 'team' && !body.team_id) {
    return badRequest('team visibility requires team_id')
  }
  // A retired kind name (an older client's `email`) is read as its successor.
  const pins: Array<{ entity_type: string; entity_id: string }> = Array.isArray(body.pins)
    ? body.pins
        .slice(0, 50)
        .map((pin: unknown) =>
          pin && typeof pin === 'object'
            ? { ...(pin as Record<string, unknown>), entity_type: canonicalEntityTypeInput((pin as Record<string, unknown>).entity_type) }
            : pin,
        )
    : []
  for (const pin of pins) {
    if (!LINKABLE.has(pin?.entity_type) || typeof pin?.entity_id !== 'string') {
      return badRequest(`invalid pin: ${JSON.stringify(pin)}`)
    }
  }

  let slug = slugify(body.name)
  let created: { id: string; name: string; slug: string; visibility: string } | null = null
  for (let attempt = 0; attempt < 2 && !created; attempt++) {
    const { data, error } = await supabase
      .from('knowledge_package')
      .insert({
        workspace_id: workspaceId,
        name: body.name.trim(),
        slug,
        description: typeof body.description === 'string' ? body.description : null,
        visibility,
        team_id: visibility === 'team' ? body.team_id : null,
        rules: body.rules && typeof body.rules === 'object' ? body.rules : {},
        created_by: user.id,
      })
      .select('id, name, slug, visibility')
      .single()
    if (!error && data) {
      created = data
      break
    }
    if (error?.code === '23505') {
      slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`
      continue
    }
    return serverError(error?.message ?? 'Failed to create package')
  }
  if (!created) return serverError('Could not allocate a unique slug')

  let pinned = 0
  for (const pin of pins) {
    const ok = await entityInWorkspace(
      supabase,
      workspaceId,
      pin.entity_type as (typeof LINKABLE_ENTITY_TYPES)[number],
      pin.entity_id,
    )
    if (!ok) continue
    const { error } = await supabase.from('knowledge_package_item').upsert(
      {
        package_id: created.id,
        workspace_id: workspaceId,
        entity_type: pin.entity_type,
        entity_id: pin.entity_id,
        added_by: user.id,
      },
      { onConflict: 'package_id,entity_type,entity_id', ignoreDuplicates: true },
    )
    if (!error) pinned += 1
  }

  return Response.json({ package: created, pinned }, { status: 201 })
}
