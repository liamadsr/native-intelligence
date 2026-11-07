import { requireWorkspaceMember, requireWorkspaceFeature } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import {
  buildEntityQuery,
  applyFilters,
  applyCompletedFilter,
  applyEntityDefaults,
  applyTeamScope,
  applyOrdering,
  applyPagination,
  applySearch,
  groupResults,
  resolvePersonalScope,
  CATEGORY_ORDER,
  CATEGORY_LABELS,
  SEQUENCE_STATUS_ORDER,
  SEQUENCE_STATUS_LABELS,
  EVAL_OUTCOME_ORDER,
  EVAL_OUTCOME_LABELS,
  NoMatchSignal,
} from '@/lib/views/query-engine'
import type { ViewEntityType, ViewFilter, SortConfig, GroupConfig, GroupedResults, WorkspaceScope } from '@/lib/views/types'
import { DEFAULT_DISPLAY_PROPERTIES, NO_MATCH_FILTER_VALUE, defaultOrdering } from '@/lib/views/types'
import { countEntriesByList, emptyEntryCounts } from '@/lib/prospecting/lists'
import { fetchAllRows, inChunks } from '@/lib/supabase/paging'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/account/views/query
 *
 * Execute an ad-hoc view query without requiring a saved view.
 * Accepts the same config shape that useViewConfig manages client-side
 * and runs it through the query engine (filters, ordering, grouping, etc.).
 */
// Ids per `.in()` in the post-fetch enrichments: a grouped page holds up to
// 500 rows, and one `.in()` of that many uuids overflows the request URL.
const ENRICH_CHUNK = 100

export async function POST(request: NextRequest) {
  // requireWorkspaceMember resolves user + workspace + member row in one member
  // query (vs the old getUser → getCurrentWorkspaceId → per-entity member
  // lookup chain, which cost 2 extra GoTrue round trips per request).
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId, member } = auth

  const body = await request.json()
  const {
    entity_type,
    filters = [],
    // No literal default here: the per-entity fallback needs `entity_type`,
    // which is not bound yet inside this destructure. Resolved just below.
    ordering: orderingInput,
    grouping = null,
    sub_grouping = null,
    team_id = null,
    page = 1,
    per_page = 50,
    show_completed = true,
    completed_filter = 'all',
    action_scope = null,
    crm_scope = null,
    capture_scope = null,
    workspace_scope = null,
    search = null,
  } = body as {
    entity_type: ViewEntityType
    filters?: ViewFilter[]
    ordering?: SortConfig[]
    grouping?: GroupConfig | null
    sub_grouping?: GroupConfig | null
    team_id?: string | null
    page?: number
    per_page?: number
    show_completed?: boolean
    completed_filter?: 'all' | 'recent' | 'none'
    action_scope?: 'assigned' | 'created' | 'all' | null
    crm_scope?: 'internal' | 'external' | null
    capture_scope?: 'mine' | 'shared' | null
    workspace_scope?: WorkspaceScope | null
    search?: string | null
  }

  if (!entity_type) {
    return badRequest('entity_type is required')
  }

  // Absent (or null, the shape the sibling scope fields use) means the active
  // workspace. Anything else is VALIDATED rather than coerced: silently
  // falling back would answer a request for the cross-workspace list with a
  // single-workspace one that looks right and is wrong.
  const workspaceScope: WorkspaceScope = workspace_scope ?? 'workspace'
  if (workspaceScope !== 'workspace' && workspaceScope !== 'all') {
    return badRequest("workspace_scope must be 'workspace' or 'all'")
  }

  // Evals is a hidden, per-workspace feature and every other route in its REST
  // surface is gated. Without this check, this generic route would be the one
  // way to list a workspace's suites with Evals off.
  if (entity_type === 'eval_suite' || entity_type === 'eval_case' || entity_type === 'eval_run') {
    const gated = await requireWorkspaceFeature(auth, 'evals')
    if (gated) return gated
  }

  // The sort an unsaved view opens on. Per-entity, not a universal
  // `created_at desc`: a prospect list is a working surface that gets run
  // again and again, so the one touched last belongs at the top.
  const ordering: SortConfig[] = orderingInput ?? defaultOrdering(entity_type)

  try {
    // When grouping is active, fetch more items so groups are complete
    const perPage = grouping ? Math.min(per_page, 500) : Math.min(per_page, 200)

    // Member ID for action scoping and @me filter resolution — already resolved
    // by requireWorkspaceMember, so no extra member query. Kept undefined for
    // non-action entities to preserve the old behavior exactly.
    const memberId: string | undefined =
      entity_type === 'action' ? member.id : undefined

    // Check if filters already handle user scoping (contains @me)
    const hasUserScopeFilter = filters.some(f =>
      f.value === '@me' && (f.field === 'assignee_id' || f.field === 'created_by' || f.field === 'user_id')
    )

    const effectiveScope = hasUserScopeFilter ? undefined : (action_scope ?? undefined)

    // Personal scope — every workspace the caller belongs to (the workspace
    // menu's "Show all workspaces" switch). The request asks for the SCOPE; the
    // server resolves WHICH workspaces from the `member` table, so the body can
    // never name one. Actions and projects only, so no other entity pays for
    // the extra read.
    const personalScope =
      workspaceScope === 'all' && (entity_type === 'action' || entity_type === 'project')
        ? await resolvePersonalScope(supabase, user.id)
        : undefined
    // What every workspace-scoped helper below matches against: the resolved
    // set in personal scope, the single active workspace otherwise.
    const scopeWorkspaceIds = personalScope?.workspaceIds ?? workspaceId

    // A cross-team board collapses its columns by workflow category (see
    // groupResults). Personal scope is cross-team by construction — the
    // workspaces don't share a single workflow_state row, let alone a
    // sort_order — so it merges by category whatever team_id says.
    const crossTeam = !team_id || workspaceScope === 'all'

    // Minimal query logging
    console.log('[views/query]', { entity_type, filterCount: filters.length, grouping: !!grouping })

    // Build base query — skip actionScope if filters already handle scoping
    const query = buildEntityQuery(supabase, entity_type, workspaceId, user.id, {
      memberId,
      actionScope: effectiveScope,
      workspaceScope,
      personalScope,
    })

    // Apply filters. A filter that provably matches nothing (e.g. a contact
    // with zero captures sending a `{ field: 'id', value: '__no_match__' }`
    // scope filter, or a label/status-category resolving to zero rows) throws
    // NoMatchSignal. We short-circuit to the normal empty success shape WITHOUT
    // hitting the DB — this is what stops the sentinel from reaching Postgres
    // and raising a 22P02 uuid-cast error. Grouping an empty array flows through
    // groupResults naturally; the empty-column injection (which needs the DB) is
    // intentionally skipped since there's nothing to place.
    if (filters.length > 0) {
      try {
        await applyFilters(query, entity_type, filters, supabase, scopeWorkspaceIds, {
          memberId,
          userId: user.id,
        })
      } catch (err) {
        if (err instanceof NoMatchSignal) {
          const validSubGrouping = sub_grouping && sub_grouping.field ? sub_grouping : null
          const emptyGrouped = grouping ? groupResults([], grouping, validSubGrouping, crossTeam) : null
          return NextResponse.json({
            data: emptyGrouped || [],
            total: 0,
            page,
            per_page: perPage,
            display_properties: DEFAULT_DISPLAY_PROPERTIES[entity_type],
          })
        }
        throw err
      }
    }

    // Filter-dependent per-entity defaults. MUST run after applyFilters and
    // OUTSIDE the `filters.length > 0` guard above: an unfiltered prospect-list
    // index is exactly the case that still has to hide archived lists.
    applyEntityDefaults(query, entity_type, filters)

    // Full-text search (name/email for contacts, name for companies, title elsewhere)
    if (search) {
      applySearch(query, entity_type, search)
    }

    // CRM internal/external scope — filter contacts by member_id presence
    if (entity_type === 'contact' && crm_scope === 'internal') {
      query.not('member_id', 'is', null)
    } else if (entity_type === 'contact' && crm_scope === 'external') {
      query.is('member_id', null)
    }

    // Capture mine/shared scope — user_id is the capture's OWNER (an auth
    // user id, not a member id). RLS already hides other members' private
    // captures, so 'mine' (my captures, both visibilities) and 'shared'
    // (teammates' workspace-visible captures) partition the visible set.
    if (entity_type === 'capture' && capture_scope === 'mine') {
      query.eq('user_id', user.id)
    } else if (entity_type === 'capture' && capture_scope === 'shared') {
      query.eq('visibility', 'workspace').neq('user_id', user.id)
    }

    // Action-specific completed filter
    if (entity_type === 'action') {
      await applyCompletedFilter(supabase, query, completed_filter, show_completed, scopeWorkspaceIds)
    }

    // Team scope
    if (team_id) {
      applyTeamScope(query, entity_type, team_id)
    }

    // Ordering. Personal scope adds a total-order tie-break: `identifier` is
    // only unique per workspace, so two workspaces' ENG-1 rows would otherwise
    // tie and paging could show one twice.
    applyOrdering(query, ordering, entity_type, { tieBreakOnId: workspaceScope === 'all' })

    // Pagination
    applyPagination(query, page, perPage)

    const { data, count, error } = await query

    if (error) throw error

    let items = (data || []) as Record<string, unknown>[]

    // Enrich items with project names when not already joined
    // (captures don't have a FK join to projects, so resolve separately)
    const firstItem = items.length > 0 ? items[0] : null
    const needsProjectEnrichment = firstItem !== null
      && 'project_id' in firstItem
      && !(firstItem.project && typeof firstItem.project === 'object' && 'name' in (firstItem.project as Record<string, unknown>))
    if (needsProjectEnrichment) {
      const projectIds = [...new Set(items.map(i => i.project_id).filter(Boolean))] as string[]
      if (projectIds.length > 0) {
        // Chunked: a grouped page holds up to 500 rows, and one `.in()` of
        // that many ids overflows the URL (the same for every block below).
        const { data: projects, error: projError } = await inChunks(projectIds, ENRICH_CHUNK, (chunkIds) =>
          supabase
            .from('projects')
            .select('id, name')
            .in('id', chunkIds),
        )
        if (projError) console.error('[views/query] project enrichment error:', projError.message)
        const projectMap = new Map((projects as { id: string; name: string }[]).map(p => [p.id, p.name]))
        items = items.map(item => {
          if (!item.project_id) return { ...item, project: null }
          const projName = projectMap.get(item.project_id as string)
          // Show __default__ project as "General" instead of hiding it
          const displayName = projName === '__default__' ? 'General' : (projName || null)
          return {
            ...item,
            project: { id: item.project_id, name: displayName },
          }
        })
      }
    }

    // Enrich actions with has_children hint so list-view tree toggles
    // can render a chevron without a per-row fetch.
    if (entity_type === 'action' && items.length > 0) {
      const parentIds = items.map(i => i.id as string)
      const { data: childRows, error: childError } = await inChunks(parentIds, ENRICH_CHUNK, (chunkIds) =>
        fetchAllRows(() =>
          supabase
            .from('actions')
            .select('id, parent_id')
            .in('parent_id', chunkIds),
        ),
      )
      if (childError) console.error('[views/query] has_children enrichment error:', childError.message)
      const withChildren = new Set<string>()
      for (const r of childRows as { parent_id: string | null }[]) {
        if (r.parent_id) withChildren.add(r.parent_id)
      }
      items = items.map(item => ({ ...item, has_children: withChildren.has(item.id as string) }))
    }

    // Enrich companies with contact counts
    if (entity_type === 'company' && items.length > 0) {
      const companyIds = items.map(i => i.id as string)
      // Paged: PostgREST caps an unpaged read at 1000 rows, which would
      // undercount (or zero) companies past the cut.
      let counts: { company_id: string }[] | null = null
      const contactRes = await inChunks(companyIds, ENRICH_CHUNK, (chunkIds) =>
        fetchAllRows(() =>
          supabase
            .from('contact')
            .select('id, company_id')
            .in('company_id', chunkIds),
        ),
      )
      if (contactRes.error) {
        // Leave contact_count off rather than fail the page.
        console.error('[views/query] company contact counts error:', contactRes.error.message)
      } else {
        counts = contactRes.data as { company_id: string }[]
      }

      if (counts) {
        const countMap = new Map<string, number>()
        for (const row of counts) {
          countMap.set(row.company_id, (countMap.get(row.company_id) || 0) + 1)
        }
        items = items.map(item => ({
          ...item,
          contact_count: countMap.get(item.id as string) || 0,
        }))
      }
    }

    // Enrich prospect lists with per-stage entry tallies. Same idiom as the
    // company contact_count block above and the sequence block below: "count
    // entries by stage per list" is an aggregate over a child table that no
    // PostgREST embed expresses without pulling every entry row onto the page,
    // so it is merged here, one paged read per page of lists.
    //
    // `countEntriesByList` is THE implementation, shared with `listLists` (the
    // prospecting API's own index) so the two surfaces cannot disagree about
    // how many candidates a list holds — and it is paged, because this read
    // spans every entry in every list on the page and PostgREST truncates at
    // 1000 rows silently.
    //
    // A failure degrades to zeros rather than 500ing the page: the counts are
    // two chips on a row, and losing the whole list index because a tally read
    // timed out trades a small wrong for a total one. It is logged.
    if (entity_type === 'prospect_list' && items.length > 0) {
      const listIds = items.map(i => i.id as string)
      let byList = new Map<string, ReturnType<typeof emptyEntryCounts>>()
      try {
        byList = await countEntriesByList(supabase, { workspaceId, listIds })
      } catch (err) {
        console.error('[views/query] prospect list entry counts error:', err)
      }
      items = items.map(item => ({
        ...item,
        entry_counts: byList.get(item.id as string) ?? emptyEntryCounts(),
      }))
    }

    // Enrich prospect COMPANY entries with the people found at them, as inline
    // `children` (plus `has_children` for the list's tree walk). The list page
    // renders people NESTED under their company rather than on a tab of their
    // own (Liam, 2026-09-05). The views engine returns one kind per query —
    // the page scopes `kind = company` — so the people are read here, one
    // query per page: at most a few per company, so a page of a hundred
    // companies stays well under PostgREST's 1000-row default. A failed read
    // degrades to companies with no children rather than 500ing the page.
    if (entity_type === 'prospect_list_entry' && items.length > 0) {
      const companyIds = items.filter((i) => i.kind === 'company').map((i) => i.id as string)
      if (companyIds.length > 0) {
        const byParent = new Map<string, Record<string, unknown>[]>()
        // Chunked by parent: a company's people all land in one chunk, so each
        // bucket keeps its created_at order.
        const { data: people, error: peopleError } = await inChunks(companyIds, ENRICH_CHUNK, (chunkIds) =>
          supabase
            .from('prospect_list_entry')
            .select('*')
            .eq('workspace_id', workspaceId)
            .eq('kind', 'person')
            .in('parent_entry_id', chunkIds)
            .order('created_at', { ascending: true }),
        )
        if (peopleError) {
          console.error('[views/query] prospect entry children error:', peopleError.message)
        }
        for (const person of people as Array<Record<string, unknown>>) {
          const parentId = person.parent_entry_id
          if (typeof parentId !== 'string') continue
          const bucket = byParent.get(parentId) ?? []
          bucket.push(person)
          byParent.set(parentId, bucket)
        }
        items = items.map((item) => {
          if (item.kind !== 'company') return item
          const children = byParent.get(item.id as string) ?? []
          return { ...item, children, has_children: children.length > 0 }
        })
      }
    }

    // Enrich sequences with enrollment headline counts (enrolled / active /
    // replied — the row cells and reply rate derive from these). Same idiom as
    // the company contact_count block above: aggregates over a child table
    // don't fit the PostgREST embed the query engine builds, so they're merged
    // here, one grouped count query per page. Shape matches GET
    // /api/account/sequences so both list surfaces agree.
    if (entity_type === 'sequence' && items.length > 0) {
      const sequenceIds = items.map(i => i.id as string)
      // Paged: PostgREST caps an unpaged read at 1000 rows.
      let enrollmentRows: { sequence_id: string; status: string; exit_reason: string | null }[] = []
      const enrollmentRes = await inChunks(sequenceIds, ENRICH_CHUNK, (chunkIds) =>
        fetchAllRows(() =>
          supabase
            .from('sequence_enrollment')
            .select('id, sequence_id, status, exit_reason')
            .in('sequence_id', chunkIds),
        ),
      )
      if (enrollmentRes.error) {
        // The counts fall back to zero as before.
        console.error('[views/query] sequence enrollment counts error:', enrollmentRes.error.message)
      } else {
        enrollmentRows = enrollmentRes.data as typeof enrollmentRows
      }
      const countMap = new Map<string, { total: number; active: number; replied: number }>()
      for (const row of enrollmentRows) {
        const entry = countMap.get(row.sequence_id) ?? { total: 0, active: 0, replied: 0 }
        entry.total += 1
        if (row.status === 'active') entry.active += 1
        if (row.exit_reason === 'replied') entry.replied += 1
        countMap.set(row.sequence_id, entry)
      }
      items = items.map(item => ({
        ...item,
        enrollment_counts: countMap.get(item.id as string) ?? { total: 0, active: 0, replied: 0 },
      }))

      // Contact-scoped embed (contact detail panel → Sequences): the internal
      // enrolled_contact_id scope filter names the contact, so merge THAT
      // contact's own enrollment onto each row as `contact_enrollment` —
      // status / progress / next send, rendered by the row's 'enrollment'
      // display property. Global lists never send the field, so the key stays
      // absent there and the cell renders nothing.
      const contactScope = filters.find(
        (f) => f.field === 'enrolled_contact_id' && f.operator === 'is',
      )
      const scopedContactId =
        typeof contactScope?.value === 'string' && contactScope.value !== NO_MATCH_FILTER_VALUE
          ? contactScope.value
          : null
      if (scopedContactId) {
        const [enrollRes, stepRes] = await Promise.all([
          // Chunked by sequence: each sequence's rows stay in one chunk, so the
          // created_at-desc order the first-seen rule below needs holds.
          inChunks(sequenceIds, ENRICH_CHUNK, (chunkIds) =>
            supabase
              .from('sequence_enrollment')
              .select('sequence_id, status, exit_reason, current_step_order, next_send_at, created_at')
              .eq('workspace_id', workspaceId)
              .eq('contact_id', scopedContactId)
              .in('sequence_id', chunkIds)
              .order('created_at', { ascending: false }),
          ),
          // Active-step counts per sequence, for "Step X of N" (same shape as
          // GET /api/account/sequences/enrollments/by-contact).
          inChunks(sequenceIds, ENRICH_CHUNK, (chunkIds) =>
            supabase
              .from('sequence_step')
              .select('sequence_id')
              .in('sequence_id', chunkIds)
              .eq('is_active', true),
          ),
        ])
        if (enrollRes.error) console.error('[views/query] contact enrollment merge error:', enrollRes.error.message)
        if (stepRes.error) console.error('[views/query] contact step counts error:', stepRes.error.message)

        const stepCounts = new Map<string, number>()
        for (const s of (stepRes.data ?? []) as { sequence_id: string }[]) {
          stepCounts.set(s.sequence_id, (stepCounts.get(s.sequence_id) ?? 0) + 1)
        }
        // One enrollment per sequence row: the active one wins; otherwise the
        // most recent (rows arrive created_at desc, so first-seen is latest).
        type EnrollmentRow = {
          sequence_id: string
          status: string
          exit_reason: string | null
          current_step_order: number
          next_send_at: string | null
          created_at: string
        }
        const bySequence = new Map<string, EnrollmentRow>()
        for (const row of (enrollRes.data ?? []) as EnrollmentRow[]) {
          const existing = bySequence.get(row.sequence_id)
          if (!existing || (row.status === 'active' && existing.status !== 'active')) {
            bySequence.set(row.sequence_id, row)
          }
        }
        items = items.map(item => {
          const e = bySequence.get(item.id as string)
          return {
            ...item,
            contact_enrollment: e
              ? {
                  status: e.status,
                  exit_reason: e.exit_reason,
                  current_step_order: e.current_step_order,
                  next_send_at: e.next_send_at,
                  created_at: e.created_at,
                  step_count: stepCounts.get(e.sequence_id) ?? 0,
                }
              : null,
          }
        })
      }
    }

    // Group if configured
    let grouped: GroupedResults[] | null = null
    if (grouping) {
      // Only apply sub_grouping if it has a valid field — prevents emptying items arrays
      const validSubGrouping = sub_grouping && sub_grouping.field ? sub_grouping : null

      // A board scoped to a single team (team_id present) orders its columns by
      // that team's own workflow sort_order. A cross-team board ("My Actions",
      // team_id null) instead collapses all teams' states into ONE column per
      // category — modelled on Linear, whose cross-team boards group by
      // workflow-state type. This is the fix for columns reverting on reload:
      // the old code merged by `category::name` across teams and ordered by the
      // first-seen sort_order, which was non-deterministic when teams shared
      // sort_order values (the default), so the order flipped between fetches.
      // `crossTeam` is resolved above — personal scope forces it on.
      grouped = groupResults(items, grouping, validSubGrouping, crossTeam)

      // Inject empty groups for all workflow states when grouped by status_id
      if (grouping.field === 'status_id' && entity_type === 'action') {
        // Collect all team_ids from items, or fall back to workspace teams
        let teamIds: string[] = [...new Set(items.map(i => i.team_id as string).filter(Boolean))]
        if (teamIds.length === 0 && team_id) {
          teamIds = [team_id]
        }
        if (teamIds.length === 0) {
          // Fetch all teams in workspace to get their states
          const { data: teams } = await supabase
            .from('team')
            .select('id')
            .eq('workspace_id', workspaceId)
          teamIds = (teams || []).map(t => t.id)
        }

        if (teamIds.length > 0) {
          const { data: allStates } = await supabase
            .from('workflow_state')
            .select('id, name, category, sort_order, team_id')
            .in('team_id', teamIds)
            // Deterministic order: by category, then sort_order, then id. The
            // tie-break on id is what stops the cross-team column order from
            // flipping between fetches when teams share sort_order values.
            .order('category', { ascending: true })
            .order('sort_order', { ascending: true })
            .order('id', { ascending: true })

          if (allStates) {
            // Group member state IDs by board column key. For a cross-team board
            // the key is the category alone (one column per category); for a
            // single-team board it's `category::name`.
            const keyFor = (s: { category: string; name: string }) =>
              crossTeam ? s.category : `${s.category}::${s.name}`

            const stateIdsByKey = new Map<string, string[]>()
            // Per-key map of team_id → that team's state id. The board uses this
            // to move a dropped card to ITS OWN team's state rather than an
            // arbitrary first-team state — without it, dragging a card into a
            // merged column reassigns it to another team's workflow_state,
            // corrupting status and breaking team-scoped Flow triggers. For a
            // category column we keep the FIRST state per team (lowest
            // sort_order, deterministic) as that team's target in the category.
            const stateIdByTeamByKey = new Map<string, Record<string, string>>()
            const labelByKey = new Map<string, string>()
            for (const state of allStates) {
              const key = keyFor(state)
              const ids = stateIdsByKey.get(key)
              if (ids) ids.push(state.id)
              else stateIdsByKey.set(key, [state.id])
              const byTeam = stateIdByTeamByKey.get(key)
              if (byTeam) {
                if (!byTeam[state.team_id]) byTeam[state.team_id] = state.id
              } else {
                stateIdByTeamByKey.set(key, { [state.team_id]: state.id })
              }
              if (!labelByKey.has(key)) {
                labelByKey.set(key, crossTeam ? CATEGORY_LABELS[state.category] ?? state.category : state.name)
              }
            }

            // Inject empty columns for states/categories that have no items
            const existingKeys = new Set(grouped.map(g => g.key))
            for (const state of allStates) {
              const key = keyFor(state)
              if (!existingKeys.has(key)) {
                existingKeys.add(key)
                grouped.push({ key, label: labelByKey.get(key) ?? state.name, items: [] })
              }
            }

            // Attach all member state IDs to every status group (populated and
            // empty alike) so the client can move cards (and, on single-team
            // boards, reorder columns) as a unit. Also set a single status_id
            // (first member) for backward compatibility with scalar consumers.
            for (const group of grouped) {
              const ids = stateIdsByKey.get(group.key)
              if (ids) {
                group.metadata = {
                  ...group.metadata,
                  status_ids: ids,
                  status_id: ids[0],
                  status_id_by_team: stateIdByTeamByKey.get(group.key) ?? {},
                }
              }
            }

            // Re-sort columns. Cross-team: fixed canonical category order.
            // Single-team: that team's workflow sort_order.
            const sortKeyFor = (key: string): number => {
              if (crossTeam) return CATEGORY_ORDER[key] ?? 999
              const cat = key.split('::')[0]
              const member = allStates.find(s => `${s.category}::${s.name}` === key)
              return member?.sort_order ?? CATEGORY_ORDER[cat] ?? 999
            }
            grouped.sort((a, b) => {
              if (a.key === '__none__') return 1
              if (b.key === '__none__') return -1
              const orderA = sortKeyFor(a.key)
              const orderB = sortKeyFor(b.key)
              return grouping.direction === 'asc' ? orderA - orderB : orderB - orderA
            })
          }
        }
      }

      // Sequence lifecycle board: inject an (empty) column per status so the
      // whole lifecycle is always visible, give every column its display
      // label (the raw group key is the enum value, e.g. 'draft'), and order
      // columns draft → active → paused → archived. Mirrors the action
      // status_id injection above; statuses are a fixed enum, so no DB
      // lookup is needed.
      if (grouping.field === 'status' && entity_type === 'sequence') {
        const existingKeys = new Set(grouped.map(g => g.key))
        for (const status of Object.keys(SEQUENCE_STATUS_ORDER)) {
          if (!existingKeys.has(status)) {
            grouped.push({ key: status, label: SEQUENCE_STATUS_LABELS[status], items: [] })
          }
        }
        for (const group of grouped) {
          const label = SEQUENCE_STATUS_LABELS[group.key]
          if (label) group.label = label
        }
        grouped.sort((a, b) => {
          if (a.key === '__none__') return 1
          if (b.key === '__none__') return -1
          const orderA = SEQUENCE_STATUS_ORDER[a.key] ?? 999
          const orderB = SEQUENCE_STATUS_ORDER[b.key] ?? 999
          return grouping.direction === 'asc' ? orderA - orderB : orderB - orderA
        })
      }

      // Eval outcome board: one column per verdict, always, in best → worst
      // order with `errored` last (a harness failure is not a worse grade).
      // Same injection as the sequence lifecycle above — the outcomes are a
      // fixed CHECK-constrained set (migration 255), so no DB lookup. Rows
      // with no settled run stay in the '__none__' column, labelled 'Never
      // run' by the grouper, which sorts to the end.
      //
      // The SAME board serves the two Evals CHILDREN, whose group-by fields
      // hold a verdict from the same vocabulary: `eval_case.last_outcome`
      // (the case's last settled trial, migration 257) and `eval_run.outcome`.
      //
      // eval_run is the one place the vocabulary is NARROWER: migration 252's
      // CHECK on eval_run.outcome allows only passed/scored/failed — a run
      // that broke is `status = 'failed'`, not an 'errored' outcome — so
      // injecting an Errored column here would produce a column no run can
      // ever land in. The keys are therefore filtered against what the entity
      // can actually hold rather than taken from EVAL_OUTCOME_ORDER whole.
      const outcomeBoard =
        (grouping.field === 'last_outcome' &&
          (entity_type === 'eval_suite' || entity_type === 'eval_case')) ||
        (grouping.field === 'outcome' && entity_type === 'eval_run')
      if (outcomeBoard) {
        const allowed =
          entity_type === 'eval_run'
            ? Object.keys(EVAL_OUTCOME_ORDER).filter(o => o !== 'errored')
            : Object.keys(EVAL_OUTCOME_ORDER)
        const existingKeys = new Set(grouped.map(g => g.key))
        for (const outcome of allowed) {
          if (!existingKeys.has(outcome)) {
            grouped.push({ key: outcome, label: EVAL_OUTCOME_LABELS[outcome], items: [] })
          }
        }
        for (const group of grouped) {
          const label = EVAL_OUTCOME_LABELS[group.key]
          if (label) group.label = label
        }
        grouped.sort((a, b) => {
          if (a.key === '__none__') return 1
          if (b.key === '__none__') return -1
          const orderA = EVAL_OUTCOME_ORDER[a.key] ?? 999
          const orderB = EVAL_OUTCOME_ORDER[b.key] ?? 999
          return grouping.direction === 'asc' ? orderA - orderB : orderB - orderA
        })
      }
    }

    return NextResponse.json({
      data: grouped || items,
      total: count ?? 0,
      page,
      per_page: perPage,
      display_properties: DEFAULT_DISPLAY_PROPERTIES[entity_type],
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Query execution failed'
    console.error('[views/query POST] Error:', message, err)
    return serverError(message)
  }
}
