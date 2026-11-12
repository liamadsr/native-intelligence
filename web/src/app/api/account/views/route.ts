import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { DEFAULT_DISPLAY_PROPERTIES, DEFAULT_BOARD_GROUP_BY, defaultOrdering, isTableLayout } from '@/lib/views/types'
import { getTable } from '@/lib/tables/store'
import type { ViewEntityType, ViewVisibility } from '@/lib/views/types'
import { NextResponse, type NextRequest } from 'next/server'

// GET /api/account/views — List views
export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const { searchParams } = request.nextUrl
  const entityType = searchParams.get('entity_type') as ViewEntityType | null
  const teamId = searchParams.get('team_id')
  const visibility = searchParams.get('visibility') as ViewVisibility | null
  const favoritesOnly = searchParams.get('favorites_only') === 'true'
  const scopeType = searchParams.get('scope_type')
  const scopeId = searchParams.get('scope_id')

  // A table's views are listed only to someone who can read the table:
  // a workspace view of a private table names its filters' values.
  if (scopeType === 'data_table' && scopeId) {
    const table = await getTable(supabase, workspaceId, scopeId).catch(() => null)
    if (!table) return NextResponse.json({ views: [], total: 0 })
  }

  let query = supabase
    .from('view')
    .select('*', { count: 'exact' })
    .eq('workspace_id', workspaceId)

  if (entityType) query = query.eq('entity_type', entityType)
  if (teamId) query = query.eq('team_id', teamId)
  if (visibility) query = query.eq('visibility', visibility)
  // Scope: either "views scoped to X" (scope_type + scope_id provided) or
  // "global views" (no scope). Global queries also exclude scoped views to
  // keep them from leaking into the My Actions / Projects / etc. tabs.
  if (scopeType && scopeId) {
    query = query.eq('scope_type', scopeType).eq('scope_id', scopeId)
  } else {
    query = query.is('scope_type', null)
  }

  query = query
    .order('is_pinned', { ascending: false })
    .order('updated_at', { ascending: false })

  const { data, count, error } = await query

  if (error) {
    console.error('[views GET] Supabase error:', error.message, error.details, error.hint)
    return serverError(error.message)
  }

  // Fetch favorites separately to avoid PostgREST join issues with RLS
  const viewIds = (data || []).map((v) => v.id)
  let favoritedIds = new Set<string>()
  if (viewIds.length > 0) {
    const { data: favs } = await supabase
      .from('view_favorite')
      .select('view_id')
      .eq('user_id', user.id)
      .in('view_id', viewIds)
    favoritedIds = new Set((favs || []).map((f) => f.view_id))
  }

  let views = (data || []).map((v) => ({
    ...v,
    is_favorited: favoritedIds.has(v.id),
  }))

  if (favoritesOnly) {
    views = views.filter((v) => v.is_favorited)
  }

  return NextResponse.json({ views, total: favoritesOnly ? views.length : count })
}

// POST /api/account/views — Create view
/**
 * Entity types with a `graph` layout — i.e. a page that supplies a canvas for
 * UnifiedViewLayout's graph branch. Claims have the knowledge map; nothing else
 * does yet.
 */
const GRAPH_CAPABLE_ENTITIES = new Set<ViewEntityType>(['claim'])

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const body = await request.json()
  const {
    name,
    description,
    icon,
    color,
    entity_type,
    team_id,
    visibility,
    layout,
    filters,
    grouping,
    sub_grouping,
    ordering,
    display_properties,
    board_group_by,
    show_completed,
    completed_filter,
    show_sub_items,
    nested_sub_items,
    show_empty_groups,
    scope_type,
    scope_id,
    metadata,
  } = body

  if (!name?.trim()) return badRequest('Name is required')
  if (!entity_type) return badRequest('entity_type is required')

  // Team views require team_id
  if (visibility === 'team' && !team_id) {
    return badRequest('Team views require a team_id')
  }

  // `layout` is ONE global enum shared by every entity type, but `graph` draws
  // the knowledge map and only a claim has one. Without this check a view of
  // any entity — a CRM list, an Actions board — could be persisted asking for a
  // canvas that does not exist for it, and would silently render as a list
  // forever with a layout toggle that never matches what is on screen. Refused
  // at the door rather than coerced, so the caller learns that the combination
  // is not a thing rather than getting a view that is not what it asked for.
  if (layout === 'graph' && !GRAPH_CAPABLE_ENTITIES.has(entity_type as ViewEntityType)) {
    return badRequest(`The graph layout is not available for ${entity_type}`)
  }
  // A table's rows take the grid, board, calendar and gallery, and only they do.
  if (entity_type === 'data_row') {
    if (layout && !isTableLayout(layout)) return badRequest(`A table's view is a grid, a board, a calendar or a gallery`)
    if (scope_type !== 'data_table' || !scope_id) return badRequest(`A table's view names its table`)
  } else if (isTableLayout(layout) && layout !== 'board') {
    return badRequest(`The ${layout} layout is only for tables`)
  }

  // Board layout defaults. A graph view carries no board grouping: it is not a
  // board, and writing a default here would make a later switch to Board open
  // on a grouping the user never chose.
  const resolvedBoardGroupBy =
    layout === 'board'
      ? board_group_by || DEFAULT_BOARD_GROUP_BY[entity_type as ViewEntityType] || null
      : layout === 'graph'
        ? null
        : board_group_by || null

  const { data, error } = await supabase
    .from('view')
    .insert({
      workspace_id: workspaceId,
      team_id: team_id || null,
      created_by: user.id,
      name: name.trim(),
      description: description || null,
      icon: icon || null,
      color: color || null,
      entity_type,
      visibility: visibility || 'personal',
      layout: layout || (entity_type === 'data_row' ? 'grid' : 'list'),
      filters: filters || [],
      grouping: grouping || null,
      sub_grouping: sub_grouping || null,
      ordering: ordering || defaultOrdering(entity_type as ViewEntityType),
      display_properties: display_properties || DEFAULT_DISPLAY_PROPERTIES[entity_type as ViewEntityType] || [],
      board_group_by: resolvedBoardGroupBy,
      show_completed: show_completed ?? true,
      completed_filter: completed_filter || 'all',
      show_sub_items: show_sub_items ?? true,
      nested_sub_items: nested_sub_items ?? false,
      show_empty_groups: show_empty_groups ?? false,
      scope_type: scope_type || null,
      scope_id: scope_id || null,
      ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { metadata } : {}),
    })
    .select()
    .single()

  if (error) return serverError(error.message)

  return NextResponse.json({ view: data }, { status: 201 })
}
