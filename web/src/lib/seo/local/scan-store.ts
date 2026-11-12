/**
 * The local rank scan's database layer (migration 597): the LocalScanStore
 * the engine (./scan-engine.ts) talks to, over the service-role client. The
 * background lane and the start/cancel core are the only writers.
 *
 * Every write here is safe to repeat: points are inserted on ids derived from
 * (scan, keyword, point) and an existing row is left alone, read points are
 * written only while still pending (seo_local_settle_points), the post marker
 * says 'go' once (seo_local_post_begin), and the scan's end is a
 * compare-and-set on its status.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import type { LocalDevice } from './limits'
import type {
  LocalScanRecord,
  LocalScanStore,
  PendingPoint,
  PointSeed,
  PointSettlement,
  PostBegin,
  ScanFinish,
  StoredPointState,
} from './scan-engine'
import type { LocalScanStatus } from './view'

const READ_PAGE = 1000
const WRITE_CHUNK = 250

interface ScanDbRow {
  id: string
  workspace_id: string
  status: LocalScanStatus
  keywords: string[] | null
  size: number
  radius_km: number | string
  center_latitude: number
  center_longitude: number
  zoom: number
  device: LocalDevice
  language_code: string
  target_title: string
  target_cid: string | null
  target_place_id: string | null
  started_by: string | null
}

const SCAN_COLUMNS =
  'id, workspace_id, status, keywords, size, radius_km, center_latitude, center_longitude, zoom, device, language_code, target_title, target_cid, target_place_id, started_by'

function fail(what: string, error: { message: string } | null): void {
  if (error) throw new Error(`seo local scan ${what} failed: ${error.message}`)
}

export function createLocalScanStore(svc: SupabaseClient): LocalScanStore {
  return {
    async getScan(scanId) {
      const { data, error } = await svc
        .from('seo_local_scan')
        .select(SCAN_COLUMNS)
        .eq('id', scanId)
        .maybeSingle()
      fail('read', error)
      if (!data) return null
      const row = data as ScanDbRow
      const record: LocalScanRecord = {
        id: row.id,
        workspaceId: row.workspace_id,
        status: row.status,
        keywords: row.keywords ?? [],
        size: row.size,
        radiusKm: Number(row.radius_km),
        centerLatitude: Number(row.center_latitude),
        centerLongitude: Number(row.center_longitude),
        zoom: row.zoom,
        device: row.device,
        languageCode: row.language_code,
        target: {
          title: row.target_title,
          cid: row.target_cid,
          place_id: row.target_place_id,
        },
        startedBy: row.started_by,
      }
      return record
    },

    async claimScan(scanId) {
      const now = new Date().toISOString()
      // A compare-and-set: the status filter is the condition. `running` is
      // accepted so a redelivered attempt carries on with its own row.
      const { data, error } = await svc
        .from('seo_local_scan')
        .update({ status: 'running', started_at: now, updated_at: now })
        .eq('id', scanId)
        .in('status', ['queued', 'running'])
        .select('id')
      fail('claim', error)
      return (data ?? []).length > 0
    },

    async beginPost(scanId, key): Promise<PostBegin> {
      const { data, error } = await svc.rpc('seo_local_post_begin', {
        p_scan: scanId,
        p_key: key,
      })
      fail('post begin', error)
      const row = ((data ?? []) as Array<{ state: string; tasks: unknown }>)[0]
      if (!row || row.state === 'inactive') return { state: 'inactive' }
      if (row.state === 'go') return { state: 'go' }
      if (row.state === 'posted' && Array.isArray(row.tasks)) {
        return {
          state: 'posted',
          tasks: row.tasks.map((task) =>
            typeof task === 'string' && task ? task : null,
          ),
        }
      }
      return { state: 'unknown' }
    },

    async recordPost(scanId, key, tasks, costUsd) {
      const { error } = await svc.rpc('seo_local_post_record', {
        p_scan: scanId,
        p_key: key,
        p_tasks: tasks,
        p_cost: Math.max(0, Number(costUsd.toFixed(6))),
      })
      fail('post record', error)
    },

    async seedPoints(rows: PointSeed[]) {
      for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
        const chunk = rows.slice(i, i + WRITE_CHUNK).map((row) => ({
          id: row.id,
          scan_id: row.scanId,
          workspace_id: row.workspaceId,
          keyword: row.keyword,
          keyword_index: row.keywordIndex,
          grid_row: row.row,
          grid_col: row.col,
          latitude: row.latitude,
          longitude: row.longitude,
          task_id: row.taskId,
          status: row.status,
          error: row.error,
          collected_at:
            row.status === 'not_collected' ? new Date().toISOString() : null,
        }))
        const { error } = await svc
          .from('seo_local_scan_point')
          .upsert(chunk, { onConflict: 'id', ignoreDuplicates: true })
        fail('seed points', error)
      }
    },

    async listPendingPoints(scanId): Promise<PendingPoint[]> {
      const out: PendingPoint[] = []
      for (let from = 0; ; from += READ_PAGE) {
        const { data, error } = await svc
          .from('seo_local_scan_point')
          .select('id, task_id')
          .eq('scan_id', scanId)
          .eq('status', 'pending')
          .order('id')
          .range(from, from + READ_PAGE - 1)
        fail('pending points', error)
        const rows = (data ?? []) as Array<{
          id: string
          task_id: string | null
        }>
        out.push(...rows.map((row) => ({ id: row.id, taskId: row.task_id })))
        if (rows.length < READ_PAGE) break
      }
      return out
    },

    async settlePoints(scanId, rows: PointSettlement[]) {
      let written = 0
      for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
        const { data, error } = await svc.rpc('seo_local_settle_points', {
          p_scan: scanId,
          p_rows: rows.slice(i, i + WRITE_CHUNK),
        })
        fail('settle points', error)
        written += Number(data ?? 0)
      }
      return written
    },

    async markUncollected(scanId, message) {
      const { data, error } = await svc
        .from('seo_local_scan_point')
        .update({
          status: 'not_collected',
          error: message.slice(0, 500),
          collected_at: new Date().toISOString(),
        })
        .eq('scan_id', scanId)
        .eq('status', 'pending')
        .select('id')
      fail('mark uncollected', error)
      return (data ?? []).length
    },

    async listPointStates(scanId): Promise<StoredPointState[]> {
      const out: StoredPointState[] = []
      for (let from = 0; ; from += READ_PAGE) {
        const { data, error } = await svc
          .from('seo_local_scan_point')
          .select('id, keyword_index, status, position')
          .eq('scan_id', scanId)
          .order('id')
          .range(from, from + READ_PAGE - 1)
        fail('point states', error)
        const rows = (data ?? []) as Array<{
          keyword_index: number
          status: StoredPointState['status']
          position: number | null
        }>
        out.push(
          ...rows.map((row) => ({
            keywordIndex: row.keyword_index,
            status: row.status,
            position: row.position,
          })),
        )
        if (rows.length < READ_PAGE) break
      }
      return out
    },

    async finishScan(scanId, finish: ScanFinish) {
      const now = new Date().toISOString()
      const { data, error } = await svc
        .from('seo_local_scan')
        .update({
          status: finish.status,
          points_total: finish.pointsTotal,
          points_collected: finish.pointsCollected,
          points_found: finish.pointsFound,
          top3: finish.top3,
          top10: finish.top10,
          average_position: finish.averagePosition,
          error_code: finish.errorCode,
          error_detail: finish.errorDetail,
          completed_at: now,
          updated_at: now,
        })
        .eq('id', scanId)
        .in('status', ['queued', 'running'])
        .select('id')
      fail('finish', error)
      return (data ?? []).length > 0
    },
  }
}
