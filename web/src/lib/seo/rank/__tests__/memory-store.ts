/**
 * An in-memory RankRunStore that behaves like the Supabase one (../store.ts)
 * over migration 594, for the engine's tests. The SQL functions are mirrored
 * rule for rule:
 *
 *   beginPost        seo_rank_post_begin: 'inactive' unless the run is
 *                    running; 'go' the first time a key is claimed; after
 *                    that 'posted' with the recorded tasks, or 'unknown'
 *                    when none were recorded.
 *   recordPost       seo_rank_post_record: the batch's tasks and cost, and
 *                    the run's cost as the sum of its batches.
 *   writeSnapshots   seo_rank_write_snapshots: a new id goes in as it is; an
 *                    existing one changes only for a non-null position better
 *                    than the stored one.
 *   dropUnconfirmedMisses  seo_rank_drop_unconfirmed_misses: a null-position
 *                    row of this run whose keyword and device had a position
 *                    in the tracker's previous completed run is removed.
 *
 * The run's compare-and-sets are held too (claim, finish, fail).
 */
import type {
  PostedTask,
  RankRunStore,
  RunRecord,
  SnapshotWrite,
  StoredSnapshot,
  TrackerRecord,
} from '../engine'

export interface MemoryRun extends RunRecord {
  keywords_total: number
  checks_total: number
  keywords_checked: number
  checks_collected: number
  estimate_usd: number
  cost_usd: number
  error_code: string | null
  error_detail: string | null
  started_at: string | null
  completed_at: string | null
}

export interface MemorySnapshot extends StoredSnapshot {
  run_id: string
  keyword: string
  serp_features: string[]
  writes: number
}

export function createMemoryRankStore(seed: {
  tracker: TrackerRecord
  keywords: Array<{ id: string; keyword: string }>
  runs: MemoryRun[]
  snapshots?: MemorySnapshot[]
  spent?: number
}) {
  const runs = new Map(seed.runs.map((r) => [r.id, { ...r }]))
  const trackers = new Map([
    [
      seed.tracker.id,
      { ...seed.tracker, last_checked_at: null as string | null },
    ],
  ])
  const keywords = [...seed.keywords]
  const snapshots = new Map((seed.snapshots ?? []).map((s) => [s.id, { ...s }]))
  const posts = new Map<string, { tasks: PostedTask[] | null; cost: number }>()
  let spent = seed.spent ?? 0
  const calls = { writeSnapshots: 0, finishRun: 0 }

  const store: RankRunStore = {
    async claimRun(runId, workspaceId) {
      const run = runs.get(runId)
      if (!run || run.workspace_id !== workspaceId) return false
      if (run.status === 'queued') {
        run.status = 'running'
        run.started_at = new Date().toISOString()
        return true
      }
      return run.status === 'running'
    },
    async getRun(runId) {
      const run = runs.get(runId)
      return run
        ? {
            id: run.id,
            tracker_id: run.tracker_id,
            workspace_id: run.workspace_id,
            trigger: run.trigger,
            status: run.status,
            started_by: run.started_by,
            estimate_usd: run.estimate_usd,
          }
        : null
    },
    async getTracker(trackerId) {
      const t = trackers.get(trackerId)
      return t ? { ...t } : null
    },
    async listKeywords() {
      return keywords.map((k) => ({ ...k }))
    },
    async updateRun(runId, patch) {
      const run = runs.get(runId)
      if (run && run.status === 'running') Object.assign(run, patch)
    },
    async finishRun(runId, patch) {
      calls.finishRun++
      const run = runs.get(runId)
      if (!run || run.status !== 'running') return false
      Object.assign(run, patch, { completed_at: new Date().toISOString() })
      return true
    },
    async failRun(runId, code, message) {
      const run = runs.get(runId)
      if (!run || (run.status !== 'queued' && run.status !== 'running'))
        return false
      Object.assign(run, {
        status: 'failed',
        error_code: code,
        error_detail: message,
        completed_at: new Date().toISOString(),
      })
      return true
    },
    async beginPost(runId, key) {
      const run = runs.get(runId)
      if (!run || run.status !== 'running')
        return { state: 'inactive', tasks: null }
      const k = `${runId}|${key}`
      const existing = posts.get(k)
      if (!existing) {
        posts.set(k, { tasks: null, cost: 0 })
        return { state: 'go', tasks: null }
      }
      return existing.tasks === null
        ? { state: 'unknown', tasks: null }
        : { state: 'posted', tasks: existing.tasks }
    },
    async recordPost(runId, key, tasks, costUsd) {
      const k = `${runId}|${key}`
      const existing = posts.get(k)
      if (existing) {
        existing.tasks = tasks
        existing.cost = Math.max(0, costUsd)
      }
      const run = runs.get(runId)
      if (run)
        run.cost_usd = [...posts.entries()]
          .filter(([key]) => key.startsWith(`${runId}|`))
          .reduce((sum, [, p]) => sum + p.cost, 0)
    },
    async writeSnapshots(runId, rows: SnapshotWrite[]) {
      calls.writeSnapshots++
      // Like the SQL: a check that doesn't exist (deleted with its tracker) gets nothing.
      if (!runs.has(runId)) return
      for (const row of rows) {
        const stored = snapshots.get(row.id)
        if (!stored) {
          snapshots.set(row.id, { ...row, run_id: runId, writes: 1 })
          continue
        }
        if (
          row.position !== null &&
          (stored.position === null || row.position < stored.position)
        ) {
          Object.assign(stored, {
            position: row.position,
            url: row.url,
            serp_features: row.serp_features,
            writes: stored.writes + 1,
          })
        }
      }
    },
    async runSnapshots(runId) {
      return [...snapshots.values()]
        .filter((s) => s.run_id === runId)
        .map(({ id, keyword_id, device, position, url }) => ({
          id,
          keyword_id,
          device,
          position,
          url,
        }))
    },
    async dropUnconfirmedMisses(runId) {
      const run = runs.get(runId)
      if (!run) return 0
      const previous = [...runs.values()]
        .filter(
          (r) =>
            r.tracker_id === run.tracker_id &&
            r.status === 'completed' &&
            r.id !== runId,
        )
        .sort((a, b) =>
          (b.completed_at ?? '').localeCompare(a.completed_at ?? ''),
        )[0]
      if (!previous) return 0
      let removed = 0
      for (const [id, s] of snapshots) {
        if (s.run_id !== runId || s.position !== null) continue
        const confirmedBefore = [...snapshots.values()].some(
          (p) =>
            p.run_id === previous.id &&
            p.keyword_id === s.keyword_id &&
            p.device === s.device &&
            p.position !== null,
        )
        if (confirmedBefore) {
          snapshots.delete(id)
          removed++
        }
      }
      return removed
    },
    async setSnapshotUrls(rows) {
      for (const { id, url } of rows) {
        const s = snapshots.get(id)
        if (s) s.url = url
      }
    },
    async markTrackerChecked(trackerId, at) {
      const t = trackers.get(trackerId)
      if (t) t.last_checked_at = at
    },
    async monthlySpend() {
      return spent
    },
  }

  return {
    store,
    runs,
    trackers,
    snapshots,
    posts,
    calls,
    setSpent: (n: number) => {
      spent = n
    },
  }
}

export function memoryRun(
  overrides: Partial<MemoryRun> &
    Pick<MemoryRun, 'id' | 'tracker_id' | 'workspace_id'>,
): MemoryRun {
  return {
    trigger: 'manual',
    status: 'queued',
    started_by: '00000000-0000-4000-8000-0000000000aa',
    keywords_total: 0,
    checks_total: 0,
    keywords_checked: 0,
    checks_collected: 0,
    estimate_usd: 0,
    cost_usd: 0,
    error_code: null,
    error_detail: null,
    started_at: null,
    completed_at: null,
    ...overrides,
  }
}
