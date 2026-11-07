/**
 * usePickerContext — fetches the lookup data required to render inline
 * property pickers in list rows (members, projects, initiatives, companies,
 * labels, workflow states per team).
 *
 * Cached in module scope per workspace so switching views doesn't refetch.
 * Revalidates when the `dial8:entity-created` event fires for any kind of
 * entity that lives in the context (matches the existing pattern in
 * `unified-view-layout.tsx:121`).
 */

'use client'

import * as React from 'react'
import type { ViewEntityType } from '@/lib/views/types'
import type {
  PickerContext, MemberOption, ProjectOption, InitiativeOption, CompanyOption,
  LabelOption, WorkflowStateOption,
} from '@/components/views/properties/types'

// ── Which context fields each entity needs ─────────────────

type ContextKey = 'members' | 'projects' | 'initiatives' | 'companies' | 'labels' | 'workflowStates'

const ENTITY_CONTEXT_REQUIREMENTS: Record<ViewEntityType, ContextKey[]> = {
  agent: [],
  skill: [],
  action: ['members', 'projects', 'labels', 'workflowStates'],
  project: ['members', 'initiatives', 'labels', 'workflowStates'],
  initiative: ['members', 'labels'],
  capture: ['projects', 'members'],
  contact: ['companies'],
  company: [],
  document: ['members', 'projects'],
  email_thread: ['labels'],
  flow: [],
  // No inline pickers: every sequence cell is read-only (status transitions
  // go through the detail page's lifecycle actions, counts are derived).
  sequence: [],
  // Nothing on a list row is inline-editable (see DISPLAY_PROPERTIES) and no
  // filterable field is a workspace lookup — purpose / status /
  // exclude_contacted are static enums.
  prospect_list: [],
  // `stage` is the only editable cell and it is a static enum — no workspace
  // lookup data to fetch. Every FIT cell is read-only by design (a machine's
  // score is not a field a human overrules in place), so nothing else here.
  prospect_list_entry: [],
  // `suite_kind` is the only editable cell and it is a static enum — nothing
  // to fetch. The three summary columns are trigger-owned, so no picker.
  eval_suite: [],
  // `polarity` is the only editable cell and it is a static enum. Everything
  // else is either trigger-owned (last_outcome / last_run_at, migration 257)
  // or refused by UpdateCaseSchema (visibility) — no workspace lookup either
  // way. `created_by` is auth.users-backed, so no member fetch.
  eval_case: [],
  // A run is immutable: nothing on the row is editable at all.
  eval_run: [],
  // `confirmation` is the only editable cell and it is a static enum, so no
  // lookup is needed to EDIT. Both entries here are for READING: the Project
  // cell resolves an id the query route attaches from `entity_link`, and the
  // Creator cell resolves a `member.id`, so without them both would render
  // raw UUIDs.
  claim: ['members', 'projects'],
}

// ── Module-level cache (keyed by workspace; invalidated on entity-created) ──
// Using module scope rather than React state so multiple rows sharing the same
// workspace don't each trigger parallel fetches.

interface WorkspaceCache {
  members?: Promise<MemberOption[]>
  projects?: Promise<ProjectOption[]>
  initiatives?: Promise<InitiativeOption[]>
  companies?: Promise<CompanyOption[]>
  labels?: Promise<LabelOption[]>
  /** Workflow states fetched per team_id */
  workflowStatesByTeam: Map<string, Promise<WorkflowStateOption[]>>
}

const cache = new Map<string, WorkspaceCache>()

function getCache(key: string): WorkspaceCache {
  let c = cache.get(key)
  if (!c) {
    c = { workflowStatesByTeam: new Map() }
    cache.set(key, c)
  }
  return c
}

function invalidate(key: string, field?: ContextKey) {
  const c = cache.get(key)
  if (!c) return
  if (!field) {
    cache.delete(key)
    return
  }
  if (field === 'workflowStates') c.workflowStatesByTeam.clear()
  else delete c[field]
}

// ── Fetchers ───────────────────────────────────────────────

/**
 * A failed lookup (an error status, or the network) reads as an empty list
 * for now, but is evicted rather than cached for the session: the next mount
 * or refresh asks again. Never rejects, so the Promise.all below always settles.
 */
function evictOnFailure<T>(promise: Promise<T[]>, evict: (failed: Promise<T[]>) => void): Promise<T[]> {
  const settled: Promise<T[]> = promise.catch(() => {
    evict(settled)
    return [] as T[]
  })
  return settled
}

async function fetchMembers(): Promise<MemberOption[]> {
  const res = await fetch('/api/account/workspace')
  if (!res.ok) throw new Error(`lookup failed: ${res.status}`)
  const d = await res.json()
  const humans: MemberOption[] = (d.members || []).map((m: { id: string; display_name: string; avatar_url: string | null }) => ({
    id: m.id,
    display_name: m.display_name,
    avatar_url: m.avatar_url,
    kind: 'member' as const,
  }))
  // AI team members (agents) are assignable alongside humans. They use `name`
  // (not display_name) and persist to a separate column, flagged via `kind`.
  const agents: MemberOption[] = (d.aiMembers || []).map((m: { id: string; name: string; avatar_url: string | null }) => ({
    id: m.id,
    display_name: m.name,
    avatar_url: m.avatar_url,
    kind: 'ai' as const,
  }))
  return [...humans, ...agents]
}

async function fetchProjects(): Promise<ProjectOption[]> {
  const res = await fetch('/api/account/projects')
  if (!res.ok) throw new Error(`lookup failed: ${res.status}`)
  const d = await res.json()
  return (d.projects || []).map((p: { id: string; name: string; icon: string | null; team_id?: string }) => ({
    id: p.id, name: p.name, icon: p.icon ?? null, team_id: p.team_id,
  }))
}

async function fetchInitiatives(): Promise<InitiativeOption[]> {
  const res = await fetch('/api/account/initiatives')
  if (!res.ok) throw new Error(`lookup failed: ${res.status}`)
  const d = await res.json()
  return (d.initiatives || []).map((i: { id: string; name: string; icon: string | null }) => ({
    id: i.id, name: i.name, icon: i.icon ?? null,
  }))
}

async function fetchCompanies(): Promise<CompanyOption[]> {
  const res = await fetch('/api/account/companies')
  if (!res.ok) throw new Error(`lookup failed: ${res.status}`)
  const d = await res.json()
  return (d.companies || []).map((c: { id: string; name: string; domain: string | null; logo_url: string | null }) => ({
    id: c.id, name: c.name, domain: c.domain ?? null, logo_url: c.logo_url ?? null,
  }))
}

async function fetchLabels(): Promise<LabelOption[]> {
  const res = await fetch('/api/account/labels')
  if (!res.ok) throw new Error(`lookup failed: ${res.status}`)
  const d = await res.json()
  return (d.labels || []).map((l: { id: string; name: string; color: string }) => ({
    id: l.id, name: l.name, color: l.color,
  }))
}

async function fetchWorkflowStates(teamId: string): Promise<WorkflowStateOption[]> {
  const res = await fetch(`/api/account/workflow-states?team_id=${teamId}`)
  if (!res.ok) throw new Error(`lookup failed: ${res.status}`)
  const d = await res.json()
  // The API returns `{ states: [...] }`. Don't rename to `workflow_states`.
  return (d.states || []).map((s: { id: string; name: string; category: string; color: string | null }) => ({
    id: s.id, name: s.name, category: s.category, color: s.color ?? null, team_id: teamId,
  }))
}

// ── Hook ───────────────────────────────────────────────────

const EMPTY: PickerContext = {
  members: [],
  projects: [],
  initiatives: [],
  companies: [],
  labels: [],
  workflowStatesByTeam: {},
  loading: true,
}

/**
 * Returns the picker context for the given entity type. Only the required
 * fields for the entity are populated — the rest are empty arrays.
 *
 * @param entityType which entity the rows belong to
 * @param teamIds list of team IDs that appear in the current view; workflow
 *   states are fetched lazily for each. Pass [] if the entity doesn't have
 *   workflow states.
 * @param workspaceKey a stable per-workspace key; workspace switching
 *   invalidates the cache.
 */
export function usePickerContext(
  entityType: ViewEntityType,
  teamIds: string[],
  workspaceKey: string | null,
): PickerContext {
  const [ctx, setCtx] = React.useState<PickerContext>(EMPTY)
  // Bumped whenever an entity event clears a cache bucket. Feeding it into the
  // fetch effect's deps is what actually re-runs the lazy fetch — a bare
  // setCtx re-render doesn't, since none of the effect's other deps change.
  const [refreshKey, setRefreshKey] = React.useState(0)

  const required = ENTITY_CONTEXT_REQUIREMENTS[entityType]
  const needsMembers = required.includes('members')
  const needsProjects = required.includes('projects')
  const needsInitiatives = required.includes('initiatives')
  const needsCompanies = required.includes('companies')
  const needsLabels = required.includes('labels')
  const needsWorkflow = required.includes('workflowStates')

  // Stable team IDs key to avoid re-running on array identity changes.
  const teamIdsKey = React.useMemo(() => [...teamIds].sort().join(','), [teamIds])

  // Reset to loading state when workspace changes so pickers don't flash
  // "no options" while the new workspace's data loads.
  const prevWorkspaceRef = React.useRef(workspaceKey)
  if (prevWorkspaceRef.current !== workspaceKey) {
    prevWorkspaceRef.current = workspaceKey
    if (ctx !== EMPTY) setCtx(EMPTY)
  }

  React.useEffect(() => {
    if (!workspaceKey) return
    const c = getCache(workspaceKey)

    // Kick off fetches lazily (Promise memoization)
    if (needsMembers && !c.members) c.members = evictOnFailure(fetchMembers(), (p) => { if (c.members === p) delete c.members })
    if (needsProjects && !c.projects) c.projects = evictOnFailure(fetchProjects(), (p) => { if (c.projects === p) delete c.projects })
    if (needsInitiatives && !c.initiatives) c.initiatives = evictOnFailure(fetchInitiatives(), (p) => { if (c.initiatives === p) delete c.initiatives })
    if (needsCompanies && !c.companies) c.companies = evictOnFailure(fetchCompanies(), (p) => { if (c.companies === p) delete c.companies })
    if (needsLabels && !c.labels) c.labels = evictOnFailure(fetchLabels(), (p) => { if (c.labels === p) delete c.labels })

    const wfTeamPromises: Array<Promise<{ teamId: string; states: WorkflowStateOption[] }>> = []
    if (needsWorkflow) {
      for (const tid of teamIds) {
        let p = c.workflowStatesByTeam.get(tid)
        if (!p) {
          p = evictOnFailure(fetchWorkflowStates(tid), (failed) => {
            if (c.workflowStatesByTeam.get(tid) === failed) c.workflowStatesByTeam.delete(tid)
          })
          c.workflowStatesByTeam.set(tid, p)
        }
        wfTeamPromises.push(p.then(states => ({ teamId: tid, states })))
      }
    }

    let cancelled = false
    Promise.all([
      needsMembers ? c.members : Promise.resolve([] as MemberOption[]),
      needsProjects ? c.projects : Promise.resolve([] as ProjectOption[]),
      needsInitiatives ? c.initiatives : Promise.resolve([] as InitiativeOption[]),
      needsCompanies ? c.companies : Promise.resolve([] as CompanyOption[]),
      needsLabels ? c.labels : Promise.resolve([] as LabelOption[]),
      Promise.all(wfTeamPromises),
    ]).then(([members, projects, initiatives, companies, labels, wf]) => {
      if (cancelled) return
      const workflowStatesByTeam: Record<string, WorkflowStateOption[]> = {}
      for (const { teamId, states } of wf) workflowStatesByTeam[teamId] = states
      setCtx({
        members: members ?? [],
        projects: projects ?? [],
        initiatives: initiatives ?? [],
        companies: companies ?? [],
        labels: labels ?? [],
        workflowStatesByTeam,
        loading: false,
      })
    })

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceKey, entityType, teamIdsKey, needsMembers, needsProjects, needsInitiatives, needsCompanies, needsLabels, needsWorkflow, refreshKey])

  // Invalidate the matching cache bucket on create/update/delete of any entity
  // the context caches, so pickers reflect the change without a manual reload:
  // a new option appears, a rename updates its label, a delete drops it.
  React.useEffect(() => {
    if (!workspaceKey) return
    // Coalesce the fetch re-run. Caches are cleared synchronously per event (so
    // no stale data survives), but the refreshKey bump that actually refetches
    // is debounced — an event burst (e.g. a batch MCP create firing N INSERTs,
    // or a workspace-wide reweave) otherwise re-fetches every mounted bucket N
    // times. One timer per hook instance, cleared on unmount.
    let bumpTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleBump = () => {
      if (bumpTimer) clearTimeout(bumpTimer)
      bumpTimer = setTimeout(() => {
        bumpTimer = null
        setRefreshKey(k => k + 1)
      }, 500)
    }
    const handler = (e: Event, kind: 'created' | 'updated' | 'deleted') => {
      const detail = (e as CustomEvent).detail as { entityType: string }
      const et = detail.entityType
      switch (et) {
        case 'project': invalidate(workspaceKey, 'projects'); break
        case 'initiative': invalidate(workspaceKey, 'initiatives'); break
        case 'company': invalidate(workspaceKey, 'companies'); break
        // A contact create/delete can add or remove an auto-created company, so
        // refresh the company list. A contact UPDATE never changes the set of
        // companies — skip it to avoid refetching on every contact edit.
        case 'contact':
          if (kind === 'updated') return
          invalidate(workspaceKey, 'companies')
          break
        case 'label': invalidate(workspaceKey, 'labels'); break
        case 'member': invalidate(workspaceKey, 'members'); break
        case 'workflow_state': invalidate(workspaceKey, 'workflowStates'); break
        default: return
      }
      // Debounced bump so the fetch effect re-runs once after a burst and
      // re-fetches the cleared bucket. (A bare setCtx re-render wouldn't — the
      // effect's other deps are all unchanged.)
      scheduleBump()
    }
    const onCreated = (e: Event) => handler(e, 'created')
    const onUpdated = (e: Event) => handler(e, 'updated')
    const onDeleted = (e: Event) => handler(e, 'deleted')
    window.addEventListener('dial8:entity-created', onCreated)
    window.addEventListener('dial8:entity-updated', onUpdated)
    window.addEventListener('dial8:entity-deleted', onDeleted)
    return () => {
      if (bumpTimer) clearTimeout(bumpTimer)
      window.removeEventListener('dial8:entity-created', onCreated)
      window.removeEventListener('dial8:entity-updated', onUpdated)
      window.removeEventListener('dial8:entity-deleted', onDeleted)
    }
  }, [workspaceKey])

  return ctx
}
