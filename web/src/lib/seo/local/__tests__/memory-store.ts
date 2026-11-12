/**
 * An in-memory LocalScanStore for the engine's tests: the same rules as the
 * database (migration 597) where the engine relies on them. The post marker
 * says 'go' once; seeded points never overwrite an existing row; only pending
 * points settle; the scan's end is a compare-and-set on its status.
 */
import type {
  LocalScanRecord,
  LocalScanStore,
  PointSeed,
  PointSettlement,
  PostBegin,
  ScanFinish,
} from '../scan-engine'

export interface MemoryPoint extends Omit<PointSeed, 'status'> {
  position: number | null
  results_count: number | null
  competitors: PointSettlement['competitors']
  status: 'pending' | 'collected' | 'not_collected'
}

export function createMemoryScanStore(scan: LocalScanRecord) {
  const state = {
    scan: { ...scan },
    posts: new Map<
      string,
      { tasks: Array<string | null> | null; cost: number }
    >(),
    points: new Map<string, MemoryPoint>(),
    finish: null as ScanFinish | null,
    settleCalls: 0,
  }
  const store: LocalScanStore = {
    async getScan(scanId) {
      return scanId === state.scan.id
        ? { ...state.scan, keywords: [...state.scan.keywords] }
        : null
    },
    async claimScan(scanId) {
      if (
        scanId !== state.scan.id ||
        !['queued', 'running'].includes(state.scan.status)
      )
        return false
      state.scan.status = 'running'
      return true
    },
    async beginPost(scanId, key): Promise<PostBegin> {
      if (scanId !== state.scan.id || state.scan.status !== 'running')
        return { state: 'inactive' }
      const existing = state.posts.get(key)
      if (!existing) {
        state.posts.set(key, { tasks: null, cost: 0 })
        return { state: 'go' }
      }
      return existing.tasks
        ? { state: 'posted', tasks: existing.tasks }
        : { state: 'unknown' }
    },
    async recordPost(_scanId, key, tasks, cost) {
      state.posts.set(key, { tasks, cost })
    },
    async seedPoints(rows) {
      for (const row of rows) {
        if (state.points.has(row.id)) continue
        state.points.set(row.id, {
          ...row,
          position: null,
          results_count: null,
          competitors: [],
        })
      }
    },
    async listPendingPoints(scanId) {
      return [...state.points.values()]
        .filter((p) => p.scanId === scanId && p.status === 'pending')
        .map((p) => ({ id: p.id, taskId: p.taskId }))
    },
    async settlePoints(_scanId, rows) {
      state.settleCalls++
      let written = 0
      for (const row of rows) {
        const point = state.points.get(row.id)
        if (!point || point.status !== 'pending') continue
        point.status = row.status
        point.position = row.status === 'collected' ? row.position : null
        point.results_count =
          row.status === 'collected' ? row.results_count : null
        point.competitors = row.status === 'collected' ? row.competitors : []
        point.error = row.error
        written++
      }
      return written
    },
    async markUncollected(scanId, error) {
      let n = 0
      for (const point of state.points.values()) {
        if (point.scanId === scanId && point.status === 'pending') {
          point.status = 'not_collected'
          point.error = error
          n++
        }
      }
      return n
    },
    async listPointStates(scanId) {
      return [...state.points.values()]
        .filter((p) => p.scanId === scanId)
        .map((p) => ({
          keywordIndex: p.keywordIndex,
          status: p.status,
          position: p.position,
        }))
    },
    async finishScan(_scanId, finish) {
      if (!['queued', 'running'].includes(state.scan.status)) return false
      state.scan.status = finish.status
      state.finish = finish
      return true
    },
  }
  return { store, state }
}
