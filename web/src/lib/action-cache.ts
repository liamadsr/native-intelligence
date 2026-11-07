// ── Shared action detail cache ─────────────────────────────────
// Module-level cache so action data survives unmount/remount (tab switch,
// closing and reopening the detail panel). List views seed it from row data
// on click/hover so the ActionDetailPanel renders instantly — no spinner,
// no network wait — and the panel's background refetch reconciles anything
// the list row didn't carry (links, fresh comment counts).

export interface ActionLink {
  url: string
  title?: string
}

export interface ActionLabel {
  id: string
  name: string
  color: string
}

export interface ActionDetail {
  id: string
  identifier: string
  title: string
  description: string | null
  status_id: string
  status_name: string
  status_category: string
  status_color: string
  team_id: string
  confirmation: string
  ai_confidence?: number | null
  auto_accepted?: boolean | null
  /** The capture this action was extracted from, when it came from a meeting.
   *  Optional: list-row seeds don't carry it, and roughly half of all actions
   *  are created directly and have no source capture at all. */
  source_capture_id?: string | null
  source_capture_title?: string | null
  priority: string
  due_at: string | null
  all_day: boolean
  links: ActionLink[] | null
  assignee_id: string | null
  assignee_name: string | null
  assignee_avatar: string | null
  assignees: { id: string; display_name: string; avatar_url: string | null }[]
  // Agent assignee (AI team member) — parallel to the human assignee. When set,
  // the action has no human assignee (mutually exclusive in the single slot).
  assignee_ai_member_id: string | null
  assignee_ai_member_name: string | null
  assignee_ai_member_avatar: string | null
  agent_run_status: string
  parent_id: string | null
  estimate: number | null
  project_id: string | null
  project_name: string | null
  milestone_id: string | null
  milestone_name: string | null
  cycle_id: string | null
  cycle_name: string | null
  cycle_number: number | null
  created_at: string
  updated_at: string
  labels: ActionLabel[]
  comment_count?: number
}

const actionDetailCache = new Map<string, ActionDetail>()
const ACTION_CACHE_MAX = 100

// IDs whose cache entry was seeded from a list row rather than the detail
// endpoint — these still want a full fetch (e.g. for `links`).
const seededIds = new Set<string>()

// In-flight detail fetches, keyed by action id, so hover-prefetch and the
// panel's mount fetch share one request instead of firing twice.
const inflightDetail = new Map<string, Promise<ActionDetail | null>>()

export function readActionCache(id: string): ActionDetail | undefined {
  return actionDetailCache.get(id)
}

export function hasActionCache(id: string): boolean {
  return actionDetailCache.has(id)
}

export function writeActionCache(id: string, data: ActionDetail) {
  seededIds.delete(id)
  actionDetailCache.set(id, data)
  evictIfNeeded()
}

export function deleteActionCache(id: string) {
  seededIds.delete(id)
  actionDetailCache.delete(id)
}

function evictIfNeeded() {
  if (actionDetailCache.size > ACTION_CACHE_MAX) {
    const oldest = actionDetailCache.keys().next().value
    if (oldest) {
      actionDetailCache.delete(oldest)
      seededIds.delete(oldest)
    }
  }
}

// List rows come in two shapes:
//   - /api/account/views/query rows: nested joins (workflow_state object,
//     labels as [{ label: {...} }], assignees as [{ member: {...} }])
//   - /api/account/actions rows: pre-flattened (status_name, assignee_name,
//     labels already unwrapped)
// The readers below accept either.
type Row = Record<string, unknown>

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function unwrapLabels(row: Row): ActionLabel[] {
  const raw = row.labels
  if (!Array.isArray(raw)) return []
  return raw
    .map((l) => {
      const candidate = (l && typeof l === 'object' && 'label' in l)
        ? (l as { label: unknown }).label
        : l
      const lab = candidate as { id?: string; name?: string; color?: string } | null
      return lab?.id && lab?.name ? { id: lab.id, name: lab.name, color: lab.color || '#6b7280' } : null
    })
    .filter((l): l is ActionLabel => l !== null)
}

function unwrapAssignees(row: Row): ActionDetail['assignees'] {
  const raw = row.assignees
  if (!Array.isArray(raw)) return []
  return raw
    .map((a) => {
      const candidate = (a && typeof a === 'object' && 'member' in a)
        ? (a as { member: unknown }).member
        : a
      const m = candidate as { id?: string; display_name?: string; avatar_url?: string | null } | null
      return m?.id ? { id: m.id, display_name: m.display_name || '', avatar_url: m.avatar_url ?? null } : null
    })
    .filter((m): m is ActionDetail['assignees'][number] => m !== null)
}

/**
 * Seed the cache from a list/board row so the detail panel can render
 * instantly on click. No-ops when a (fuller) entry already exists — a seed
 * must never clobber data that came from the detail endpoint. The panel's
 * own background refetch fills in fields the row doesn't carry.
 */
export function seedActionCacheFromListItem(row: Row) {
  const id = str(row.id)
  const title = str(row.title)
  if (!id || title === null) return
  if (actionDetailCache.has(id)) return

  const ws = row.workflow_state as { id?: string; name?: string; category?: string; color?: string } | null
  const assignee = row.assignee as { id?: string; display_name?: string; avatar_url?: string | null } | null
  const project = row.project as { id?: string; name?: string } | null
  const milestone = row.milestone as { id?: string; name?: string } | null
  const cycle = row.cycle as { id?: string; name?: string; number?: number } | null
  const aiAssignee = row.assignee_ai_member as { id?: string; name?: string; avatar_url?: string | null } | null
  const assignees = unwrapAssignees(row)
  const primaryAssignee = assignees[0] || (assignee?.id
    ? { id: assignee.id, display_name: assignee.display_name || '', avatar_url: assignee.avatar_url ?? null }
    : null)

  const seeded: ActionDetail = {
    id,
    identifier: str(row.identifier) || '',
    title,
    description: str(row.description),
    status_id: str(row.status_id) || ws?.id || '',
    status_name: ws?.name ?? str(row.status_name) ?? '',
    status_category: ws?.category ?? str(row.status_category) ?? '',
    status_color: ws?.color ?? str(row.status_color) ?? '#6b7280',
    team_id: str(row.team_id) || '',
    confirmation: str(row.confirmation) || 'confirmed',
    priority: str(row.priority) || 'none',
    due_at: str(row.due_at),
    all_day: row.all_day === true,
    links: null,
    assignee_id: primaryAssignee?.id ?? str(row.assignee_id),
    assignee_name: primaryAssignee?.display_name ?? str(row.assignee_name),
    assignee_avatar: primaryAssignee?.avatar_url ?? str(row.assignee_avatar),
    assignees,
    assignee_ai_member_id: aiAssignee?.id ?? str(row.assignee_ai_member_id),
    assignee_ai_member_name: aiAssignee?.name ?? str(row.assignee_ai_member_name),
    assignee_ai_member_avatar: aiAssignee?.avatar_url ?? str(row.assignee_ai_member_avatar),
    agent_run_status: str(row.agent_run_status) || 'idle',
    parent_id: str(row.parent_id),
    estimate: typeof row.estimate === 'number' ? row.estimate : null,
    project_id: str(row.project_id),
    project_name: project?.name ?? str(row.project_name),
    milestone_id: str(row.milestone_id),
    milestone_name: milestone?.name ?? str(row.milestone_name),
    cycle_id: str(row.cycle_id),
    cycle_name: cycle?.name ?? str(row.cycle_name),
    cycle_number: cycle?.number ?? (typeof row.cycle_number === 'number' ? row.cycle_number : null),
    created_at: str(row.created_at) || new Date().toISOString(),
    updated_at: str(row.updated_at) || str(row.created_at) || new Date().toISOString(),
    labels: unwrapLabels(row),
    comment_count: typeof row.comment_count === 'number' ? row.comment_count : undefined,
  }

  actionDetailCache.set(id, seeded)
  seededIds.add(id)
  evictIfNeeded()
}

/**
 * Fetch the full action detail into the cache, deduping concurrent calls.
 * Used for hover-prefetch from list rows and by the panel's mount fetch.
 * Resolves with the detail (or null on failure) — failures are swallowed
 * since prefetching is best-effort and the panel retries on open.
 */
export function prefetchActionDetail(id: string): Promise<ActionDetail | null> {
  // Already have full (non-seeded) data — entity events keep it patched and
  // the panel revalidates on open, so hovering again shouldn't refetch.
  if (actionDetailCache.has(id) && !seededIds.has(id)) {
    return Promise.resolve(actionDetailCache.get(id) ?? null)
  }
  const existing = inflightDetail.get(id)
  if (existing) return existing

  const promise = fetch(`/api/account/actions/${id}`)
    .then((res) => (res.ok ? res.json() : null))
    .then((data: { action?: ActionDetail } | null) => {
      if (data?.action) {
        writeActionCache(id, data.action)
        return data.action
      }
      return null
    })
    .catch(() => null)
    .finally(() => {
      inflightDetail.delete(id)
    })

  inflightDetail.set(id, promise)
  return promise
}

/** The in-flight detail fetch for an id, if any — lets the panel await an
 *  already-running hover-prefetch instead of issuing a duplicate request. */
export function getInflightActionDetail(id: string): Promise<ActionDetail | null> | undefined {
  return inflightDetail.get(id)
}
