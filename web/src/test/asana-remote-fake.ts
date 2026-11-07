/**
 * Filter-aware Supabase fake for the task-provider read-back and config tests.
 *
 * Named for Asana because that is what it was built for, but the mechanism is
 * provider-agnostic Supabase plumbing and the Jira suite uses it unchanged —
 * same tables, same CAS, same keyset cursor. Rename it when a third provider
 * makes the name actively misleading rather than merely historical.
 *
 * The generic createSupabaseMock resolves every chain to one canned result,
 * which can't express what these paths actually depend on: the link CAS is
 * `update(...).eq('id').neq('completed', remote).select('id')` and its ROW COUNT
 * is the entire idempotency/loop-breaking mechanism; the reconcile sweep
 * keyset-pages with an `.or(...)` cursor; and the webhook-secret CAS in
 * asana-config is `update(...).not('webhook_pending_at','is',null).gt(...)`,
 * where the filters ARE the security boundary. All of them need a fake that
 * reads the filters and mutates state, so it lives here and is shared rather
 * than re-typed in every test.
 *
 * It also records the SELECT column list per query, which is how the
 * asana-config tests assert that only loadAsanaWebhookAuth ever asks the
 * database for `webhook_secret`.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface FakeLinkRow {
  id: string
  action_id: string
  external_id: string
  completed: boolean
  created_at?: string
  last_push_error?: unknown
  /**
   * Set for the Jira read-back, which routes by issue id ACROSS workspaces (one
   * global receiver URL, so a delivery names an issue and nothing else) and has
   * to group the results itself. The Asana paths are handed a workspace and
   * leave this unset.
   */
  workspace_id?: string
  /** The real provider status name. Jira writes it; Asana leaves it null. */
  external_state_label?: string | null
  /**
   * Deep link to the task in the provider. Only the Linear read-back paths
   * refresh it: Linear rewrites an issue's identifier — and its canonical URL —
   * when the issue moves team, so the re-fetch has to absorb that drift.
   */
  external_url?: string | null
  /**
   * Provider-scoped container the external id belongs to (migration 216). Jira
   * stores the Atlassian cloudId, because issue ids are per-SITE sequences that
   * every site starts at 10000 — the id alone identifies nothing. Asana gids are
   * global, so its rows leave this null.
   */
  external_scope?: string | null
}

export interface FakeActionRow {
  id: string
  status_id: string | null
  team_id: string | null
  category: string | null
}

/** workflow_state ids a team resolves to, per lookup kind. */
export interface FakeTeamStates {
  completed?: string | null
  default?: string | null
  unstarted?: string | null
  /**
   * JIRA ONLY. Where a remote reopen lands when the provider reports the issue
   * is in an `indeterminate` status — Asana's boolean lifecycle cannot express
   * "reopened INTO in-progress", so its paths never ask for this.
   */
  started?: string | null
  /**
   * JIRA ONLY. Where a remote cancellation lands. Asana has no cancellation at
   * all (see asanaWriteForBucket), so again only the Jira paths ask.
   */
  canceled?: string | null
}

/** A task_sync_state row. Every nullable column defaults to null, not absent. */
export interface FakeSyncStateRow {
  /** Open-ended so the fake can filter/project by arbitrary column name. */
  [column: string]: unknown
  id: string
  workspace_id?: string
  account_id?: string
  user_id?: string
  provider?: string
  config?: unknown
  webhook_gid?: string | null
  webhook_secret?: string | null
  webhook_registered_at?: string | null
  webhook_pending_at?: string | null
  last_reconcile_at?: string | null
  created_at?: string
  updated_at?: string
}

export interface AsanaRemoteFakeOptions {
  links?: FakeLinkRow[]
  actions?: FakeActionRow[]
  /** teamId → the ids its workflow_state lookups resolve to. */
  states?: Record<string, FakeTeamStates>
  /** Return the embedded workflow_state as an array (PostgREST sometimes does). */
  embedAsArray?: boolean
  /** Make the link CAS fail with a DB error (must propagate, not read as "no-op"). */
  linkUpdateError?: { message: string }
  /** task_sync_state rows for the asana-config tests. */
  syncStates?: FakeSyncStateRow[]
  /** Make every task_sync_state read/write fail with a DB error. */
  syncStateError?: { message: string }
}

interface Filter {
  op: 'eq' | 'neq' | 'in' | 'is' | 'gt' | 'not'
  col: string
  val: unknown
  /** For `not(col, op, val)` — the operator being negated (only 'is' is used). */
  notOp?: string
}

export interface AsanaRemoteFake {
  client: SupabaseClient
  /** Link rows as they stand now — the CAS mutates them in place. */
  links: FakeLinkRow[]
  /** Successful compare-and-swap writes on action_external_task. */
  casUpdates: Array<{ linkId: string | null; patch: Record<string, unknown> }>
  /** Non-CAS link writes carrying a failure marker (task_deleted). */
  markerUpdates: Array<{ linkId: string | null; patch: Record<string, unknown> }>
  /** Every OTHER non-CAS link write — today, Jira's status-label refresh. */
  linkUpdates: Array<{ linkId: string | null; patch: Record<string, unknown> }>
  /** actions writes (status transitions). */
  statusUpdates: Array<{ actionId: string | null; patch: Record<string, unknown> }>
  /** Every action_external_task READ, with its filters — for query assertions. */
  linkQueries: Array<{ filters: Filter[]; limit: number | null; or: string | null }>
  /** task_sync_state rows as they stand now — writes mutate them in place. */
  syncStates: FakeSyncStateRow[]
  /** Every task_sync_state READ: the SELECT column list and the filters. */
  syncStateQueries: Array<{ columns: string[]; filters: Filter[] }>
  /** Every task_sync_state WRITE, with the rows its filters actually matched. */
  syncStateUpdates: Array<{
    patch: Record<string, unknown>
    filters: Filter[]
    matchedIds: string[]
  }>
}

/** Value of the first filter matching op+col, or undefined. */
function filterValue(filters: Filter[], op: Filter['op'], col: string): unknown {
  return filters.find((f) => f.op === op && f.col === col)?.val
}

/**
 * Apply the filters, but ONLY for columns the fake row actually carries.
 * Scoping columns (workspace_id, provider) aren't modeled on link rows; tests
 * assert those through `linkQueries` instead of by row filtering. task_sync_state
 * rows ARE fully modeled (see normalizeSyncState), so every filter bites there.
 */
function matches(row: Record<string, unknown>, filters: Filter[]): boolean {
  for (const f of filters) {
    if (!(f.col in row)) continue
    const value = row[f.col]
    if (f.op === 'eq' && value !== f.val) return false
    if (f.op === 'neq' && value === f.val) return false
    if (f.op === 'in' && !(f.val as unknown[]).includes(value)) return false
    if (f.op === 'is' && value !== f.val) return false
    // Postgres: a comparison against NULL is NULL, i.e. the row does not match.
    if (f.op === 'gt' && !(value !== null && value !== undefined && (value as string) > (f.val as string))) {
      return false
    }
    if (f.op === 'not') {
      // Only `.not(col, 'is', null)` is used — "column IS NOT NULL".
      if (f.notOp === 'is' && f.val === null && (value === null || value === undefined)) {
        return false
      }
    }
  }
  return true
}

/** Column names out of a PostgREST select list ('*' / absent → every column). */
function selectedColumns(select: string | null): string[] {
  if (!select || select.trim() === '*') return []
  return select
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
}

/** Hand back only what was SELECTed, so an omitted column really is absent. */
function project(
  row: Record<string, unknown>,
  columns: string[],
): Record<string, unknown> {
  if (columns.length === 0) return { ...row }
  const out: Record<string, unknown> = {}
  for (const col of columns) if (col in row) out[col] = row[col]
  return out
}

/** Every nullable column present, so filters on unset columns still apply. */
function normalizeSyncState(row: FakeSyncStateRow): FakeSyncStateRow {
  return {
    provider: 'asana',
    config: {},
    webhook_gid: null,
    webhook_secret: null,
    webhook_registered_at: null,
    webhook_pending_at: null,
    last_reconcile_at: null,
    ...row,
  }
}

/** Parse the keyset `.or()` clause the sweep builds into a cursor predicate. */
function keysetPredicate(clause: string | null): (row: FakeLinkRow) => boolean {
  if (!clause) return () => true
  const gt = /created_at\.gt\.([^,]+)/.exec(clause)?.[1]
  const eq = /created_at\.eq\.([^,)]+)/.exec(clause)?.[1]
  const idGt = /id\.gt\.([^,)]+)/.exec(clause)?.[1]
  return (row) => {
    const created = row.created_at ?? ''
    if (gt && created > gt) return true
    if (eq && idGt && created === eq && row.id > idGt) return true
    return false
  }
}

export function createAsanaRemoteFake(options: AsanaRemoteFakeOptions = {}): AsanaRemoteFake {
  const links: FakeLinkRow[] = (options.links ?? []).map((l) => ({ ...l }))
  const actions = options.actions ?? []
  const states = options.states ?? {}
  const syncStates: FakeSyncStateRow[] = (options.syncStates ?? []).map(normalizeSyncState)

  const fake: AsanaRemoteFake = {
    client: null as unknown as SupabaseClient,
    links,
    casUpdates: [],
    markerUpdates: [],
    linkUpdates: [],
    statusUpdates: [],
    linkQueries: [],
    syncStates,
    syncStateQueries: [],
    syncStateUpdates: [],
  }

  function builder(table: string) {
    const filters: Filter[] = []
    let patch: Record<string, unknown> | null = null
    let limit: number | null = null
    let orClause: string | null = null
    let select: string | null = null

    /** `single` distinguishes `.maybeSingle()` from an awaited (list) query. */
    function resolve(single: boolean): { data: unknown; error: { message: string } | null } {
      // ---- task_sync_state -------------------------------------------------
      if (table === 'task_sync_state') {
        if (options.syncStateError) return { data: null, error: options.syncStateError }

        if (patch) {
          const matched = syncStates.filter((r) => matches(r as Record<string, unknown>, filters))
          for (const row of matched) Object.assign(row, patch)
          fake.syncStateUpdates.push({
            patch,
            filters: [...filters],
            matchedIds: matched.map((r) => r.id),
          })
          // PostgREST only returns rows when the write asked for them.
          return { data: select ? matched.map((r) => ({ id: r.id })) : null, error: null }
        }

        const columns = selectedColumns(select)
        fake.syncStateQueries.push({ columns, filters: [...filters] })
        const rows = syncStates
          .filter((r) => matches(r as Record<string, unknown>, filters))
          // The only ordering any reader asks for is created_at ascending.
          .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
          .map((r) => project(r as Record<string, unknown>, columns))
        const page = limit ? rows.slice(0, limit) : rows
        return { data: single ? (page[0] ?? null) : page, error: null }
      }

      // ---- action_external_task ------------------------------------------
      if (table === 'action_external_task') {
        if (patch) {
          const linkId = (filterValue(filters, 'eq', 'id') as string | undefined) ?? null
          const casTarget = filters.find((f) => f.op === 'neq' && f.col === 'completed')

          if (casTarget) {
            if (options.linkUpdateError) {
              return { data: null, error: options.linkUpdateError }
            }
            const row = links.find((l) => l.id === linkId)
            // The CAS only matches when the stored state DIFFERS — the whole
            // idempotency guard.
            if (!row || row.completed === casTarget.val) return { data: [], error: null }
            row.completed = patch.completed as boolean
            fake.casUpdates.push({ linkId, patch })
            return { data: [{ id: linkId }], error: null }
          }

          // Any non-CAS write: apply the whole patch, then file it by kind so a
          // test can tell "stamped a failure marker" apart from "refreshed the
          // status label" without inspecting patch keys itself.
          const row = links.find((l) => l.id === linkId)
          if (row) Object.assign(row, patch)
          if ('last_push_error' in patch) fake.markerUpdates.push({ linkId, patch })
          else fake.linkUpdates.push({ linkId, patch })
          return { data: null, error: null }
        }

        fake.linkQueries.push({ filters: [...filters], limit, or: orClause })
        const cursor = keysetPredicate(orClause)
        const rows = links
          .filter((l) => matches(l as unknown as Record<string, unknown>, filters))
          .filter(cursor)
          .sort((a, b) =>
            (a.created_at ?? '') === (b.created_at ?? '')
              ? a.id.localeCompare(b.id)
              : (a.created_at ?? '').localeCompare(b.created_at ?? ''),
          )
        return { data: limit ? rows.slice(0, limit) : rows, error: null }
      }

      // ---- actions ---------------------------------------------------------
      if (table === 'actions') {
        if (patch) {
          fake.statusUpdates.push({
            actionId: (filterValue(filters, 'eq', 'id') as string | undefined) ?? null,
            patch,
          })
          return { data: null, error: null }
        }
        const id = filterValue(filters, 'eq', 'id') as string | undefined
        const row = actions.find((a) => a.id === id)
        if (!row) return { data: null, error: null }
        const embedded = { category: row.category }
        return {
          data: {
            id: row.id,
            status_id: row.status_id,
            team_id: row.team_id,
            workflow_state: options.embedAsArray ? [embedded] : embedded,
          },
          error: null,
        }
      }

      // ---- workflow_state --------------------------------------------------
      if (table === 'workflow_state') {
        const teamId = filterValue(filters, 'eq', 'team_id') as string | undefined
        const team = (teamId && states[teamId]) || {}
        let id: string | null | undefined
        if (filterValue(filters, 'eq', 'is_default') === true) id = team.default
        else {
          const category = filterValue(filters, 'eq', 'category') as string | undefined
          if (category === 'completed') id = team.completed
          else if (category === 'unstarted') id = team.unstarted
          else if (category === 'started') id = team.started
          else if (category === 'canceled') id = team.canceled
        }
        return { data: id ? { id } : null, error: null }
      }

      return { data: null, error: null }
    }

    const api: Record<string, unknown> = {
      select: (cols?: string) => {
        select = cols ?? '*'
        return api
      },
      update: (p: Record<string, unknown>) => {
        patch = p
        return api
      },
      eq: (col: string, val: unknown) => {
        filters.push({ op: 'eq', col, val })
        return api
      },
      neq: (col: string, val: unknown) => {
        filters.push({ op: 'neq', col, val })
        return api
      },
      in: (col: string, val: unknown) => {
        filters.push({ op: 'in', col, val })
        return api
      },
      is: (col: string, val: unknown) => {
        filters.push({ op: 'is', col, val })
        return api
      },
      gt: (col: string, val: unknown) => {
        filters.push({ op: 'gt', col, val })
        return api
      },
      not: (col: string, notOp: string, val: unknown) => {
        filters.push({ op: 'not', col, val, notOp })
        return api
      },
      or: (clause: string) => {
        orClause = clause
        return api
      },
      order: () => api,
      limit: (n: number) => {
        limit = n
        return api
      },
      maybeSingle: async () => resolve(true),
      single: async () => resolve(true),
      then: (res: (v: unknown) => unknown) => Promise.resolve(resolve(false)).then(res),
    }
    return api
  }

  fake.client = { from: (table: string) => builder(table) } as unknown as SupabaseClient
  return fake
}
