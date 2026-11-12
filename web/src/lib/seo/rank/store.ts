/**
 * The rank check's store over migration 594, for the engine (./engine.ts).
 * The background lane is the only caller: the client is the service role's,
 * and a check's rows are reached by the run's own id (the lane got it from
 * the start, which wrote it inside the workspace).
 */
import { readMonthlySeoSpend } from '@/lib/seo/spend'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import type {
  PostedTask,
  RankRunStore,
  RunRecord,
  SnapshotWrite,
  StoredSnapshot,
  TrackerRecord,
} from './engine'

const PAGE = 1000

export function createRankRunStore(svc: SupabaseClient): RankRunStore {
  const nowIso = () => new Date().toISOString()
  return {
    async claimRun(runId, workspaceId) {
      // A compare-and-set: queued -> running. A redelivered attempt finds its
      // own row running and carries on.
      const { data, error } = await svc
        .from('seo_rank_run')
        .update({
          status: 'running',
          started_at: nowIso(),
          updated_at: nowIso(),
        })
        .eq('id', runId)
        .eq('workspace_id', workspaceId)
        .eq('status', 'queued')
        .select('id')
      if (error) throw new Error(`seo_rank_run claim failed: ${error.message}`)
      if ((data ?? []).length > 0) return true
      const { data: row, error: readError } = await svc
        .from('seo_rank_run')
        .select('status')
        .eq('id', runId)
        .eq('workspace_id', workspaceId)
        .maybeSingle()
      if (readError)
        throw new Error(`seo_rank_run read failed: ${readError.message}`)
      return (row as { status?: string } | null)?.status === 'running'
    },

    async getRun(runId) {
      const { data, error } = await svc
        .from('seo_rank_run')
        .select('id, tracker_id, workspace_id, trigger, status, started_by')
        .eq('id', runId)
        .maybeSingle()
      if (error) throw new Error(`seo_rank_run read failed: ${error.message}`)
      return (data as RunRecord | null) ?? null
    },

    async getTracker(trackerId) {
      const { data, error } = await svc
        .from('seo_rank_tracker')
        .select(
          'id, workspace_id, created_by, domain, location_code, language_code, location_name, devices, serp_depth, paused',
        )
        .eq('id', trackerId)
        .maybeSingle()
      if (error)
        throw new Error(`seo_rank_tracker read failed: ${error.message}`)
      return (data as TrackerRecord | null) ?? null
    },

    async listKeywords(trackerId) {
      const out: Array<{ id: string; keyword: string }> = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await svc
          .from('seo_rank_keyword')
          .select('id, keyword')
          .eq('tracker_id', trackerId)
          .order('created_at')
          .order('id')
          .range(from, from + PAGE - 1)
        if (error)
          throw new Error(`seo_rank_keyword read failed: ${error.message}`)
        const rows = (data ?? []) as Array<{ id: string; keyword: string }>
        out.push(...rows)
        if (rows.length < PAGE) return out
      }
    },

    async updateRun(runId, patch) {
      const { error } = await svc
        .from('seo_rank_run')
        .update({ ...patch, updated_at: nowIso() })
        .eq('id', runId)
        .eq('status', 'running')
      if (error) throw new Error(`seo_rank_run update failed: ${error.message}`)
    },

    async finishRun(runId, patch) {
      const { data, error } = await svc
        .from('seo_rank_run')
        .update({ ...patch, completed_at: nowIso(), updated_at: nowIso() })
        .eq('id', runId)
        .eq('status', 'running')
        .select('id')
      if (error) throw new Error(`seo_rank_run finish failed: ${error.message}`)
      return (data ?? []).length > 0
    },

    async failRun(runId, code, message) {
      const { data, error } = await svc
        .from('seo_rank_run')
        .update({
          status: 'failed',
          error_code: code.slice(0, 60),
          error_detail: message.slice(0, 2000),
          completed_at: nowIso(),
          updated_at: nowIso(),
        })
        .eq('id', runId)
        .in('status', ['queued', 'running'])
        .select('id')
      if (error) throw new Error(`seo_rank_run fail failed: ${error.message}`)
      return (data ?? []).length > 0
    },

    async beginPost(runId, key) {
      const { data, error } = await svc.rpc('seo_rank_post_begin', {
        p_run: runId,
        p_key: key,
      })
      if (error) throw new Error(`seo_rank_post_begin failed: ${error.message}`)
      const row = ((data ?? []) as Array<{ state: string; tasks: unknown }>)[0]
      const state = row?.state
      if (state !== 'go' && state !== 'posted' && state !== 'unknown')
        return { state: 'inactive', tasks: null }
      return {
        state,
        tasks: Array.isArray(row?.tasks) ? (row.tasks as PostedTask[]) : null,
      }
    },

    async recordPost(runId, key, tasks, costUsd) {
      const { error } = await svc.rpc('seo_rank_post_record', {
        p_run: runId,
        p_key: key,
        p_tasks: tasks,
        p_cost: Math.max(0, costUsd),
      })
      if (error)
        throw new Error(`seo_rank_post_record failed: ${error.message}`)
    },

    async writeSnapshots(runId, rows) {
      // One row per id in a statement (ON CONFLICT can't touch a row twice): the best one.
      const best = new Map<string, SnapshotWrite>()
      for (const row of rows) {
        const seen = best.get(row.id)
        if (
          !seen ||
          (row.position !== null &&
            (seen.position === null || row.position < seen.position))
        )
          best.set(row.id, row)
      }
      const { error } = await svc.rpc('seo_rank_write_snapshots', {
        p_run: runId,
        p_rows: [...best.values()],
      })
      if (error)
        throw new Error(`seo_rank_write_snapshots failed: ${error.message}`)
    },

    async runSnapshots(runId) {
      const out: StoredSnapshot[] = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await svc
          .from('seo_rank_snapshot')
          .select('id, keyword_id, device, position, url')
          .eq('run_id', runId)
          .order('id')
          .range(from, from + PAGE - 1)
        if (error)
          throw new Error(`seo_rank_snapshot read failed: ${error.message}`)
        const rows = (data ?? []) as StoredSnapshot[]
        out.push(...rows)
        if (rows.length < PAGE) return out
      }
    },

    async dropUnconfirmedMisses(runId) {
      const { data, error } = await svc.rpc(
        'seo_rank_drop_unconfirmed_misses',
        { p_run: runId },
      )
      if (error)
        throw new Error(
          `seo_rank_drop_unconfirmed_misses failed: ${error.message}`,
        )
      return Number(data) || 0
    },

    async setSnapshotUrls(rows) {
      for (let i = 0; i < rows.length; i += 20) {
        const results = await Promise.all(
          rows
            .slice(i, i + 20)
            .map(({ id, url }) =>
              svc.from('seo_rank_snapshot').update({ url }).eq('id', id),
            ),
        )
        const failed = results.find((r) => r.error)
        if (failed?.error)
          throw new Error(
            `seo_rank_snapshot url update failed: ${failed.error.message}`,
          )
      }
    },

    async markTrackerChecked(trackerId, at) {
      const { error } = await svc
        .from('seo_rank_tracker')
        .update({
          last_checked_at: at,
          last_skip_reason: null,
          updated_at: nowIso(),
        })
        .eq('id', trackerId)
      if (error)
        throw new Error(`seo_rank_tracker update failed: ${error.message}`)
    },

    monthlySpend: (workspaceId) => readMonthlySeoSpend(svc, workspaceId),
  }
}
