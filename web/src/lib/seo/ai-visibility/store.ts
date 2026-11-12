/**
 * The check's store over migration 596: what ./engine.ts reads and writes,
 * through the service role. Every write is a compare-and-set on the row's
 * status, so a step that runs twice changes nothing the first run settled.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import type {
  AiRunStore,
  CollectedAnswer,
  EngineRun,
  OpenAnswer,
  RunCounts,
} from './engine'
import { readRunBrands } from './queries'
import type {
  AiAnswerStatus,
  AiEngine,
  AiRunStatus,
  AiRunTrigger,
} from './view'

/** PostgREST answers at most this many rows per request. */
const PAGE = 1000

interface RunRecord {
  id: string
  workspace_id: string
  tracker_id: string
  trigger: AiRunTrigger
  status: AiRunStatus
  started_by: string | null
  engines: AiEngine[]
  location_code: number
  language_code: string
  brands: unknown
  estimate_usd: number | string
}

export function createAiRunStore(svc: SupabaseClient): AiRunStore {
  return {
    async getRun(runId) {
      const { data, error } = await svc
        .from('seo_ai_run')
        .select(
          'id, workspace_id, tracker_id, trigger, status, started_by, engines, location_code, language_code, brands, estimate_usd',
        )
        .eq('id', runId)
        .maybeSingle()
      if (error) throw new Error(`seo ai run read failed: ${error.message}`)
      if (!data) return null
      const row = data as RunRecord
      return {
        ...row,
        brands: readRunBrands(row.brands),
        // numeric arrives as a string.
        estimate_usd: Number(row.estimate_usd) || 0,
      } satisfies EngineRun
    },

    async claimRun(runId) {
      const now = new Date().toISOString()
      const { data, error } = await svc
        .from('seo_ai_run')
        .update({ status: 'running', updated_at: now })
        .eq('id', runId)
        .in('status', ['queued', 'running'])
        .select('id, started_at')
      if (error) throw new Error(`seo ai run claim failed: ${error.message}`)
      const rows = (data ?? []) as Array<{
        id: string
        started_at: string | null
      }>
      if (rows.length && !rows[0].started_at) {
        await svc
          .from('seo_ai_run')
          .update({ started_at: now })
          .eq('id', runId)
          .is('started_at', null)
      }
      return rows.length > 0
    },

    async getTracker(trackerId) {
      const { data, error } = await svc
        .from('seo_ai_tracker')
        .select('workspace_id, created_by, paused, schedule_interval')
        .eq('id', trackerId)
        .maybeSingle()
      if (error) throw new Error(`seo ai tracker read failed: ${error.message}`)
      return (
        (data as {
          workspace_id: string
          created_by: string | null
          paused: boolean
          schedule_interval: string
        } | null) ?? null
      )
    },

    async listAnswers(runId, filter) {
      const out: OpenAnswer[] = []
      for (let from = 0; ; from += PAGE) {
        let query = svc
          .from('seo_ai_answer')
          .select('id, prompt_text, engine, status, task_id, error_code')
          .eq('run_id', runId)
          .in('status', filter.statuses)
        if (filter.ids) query = query.in('id', filter.ids)
        if (filter.errorCode) query = query.eq('error_code', filter.errorCode)
        if (filter.withTask) query = query.not('task_id', 'is', null)
        const { data, error } = await query
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1)
        if (error)
          throw new Error(`seo ai answers read failed: ${error.message}`)
        const rows = (data ?? []) as OpenAnswer[]
        out.push(...rows)
        if (rows.length < PAGE) return out
      }
    },

    async beginAnswers(runId, ids) {
      if (ids.length === 0) return []
      const { data, error } = await svc.rpc('seo_ai_answers_begin', {
        p_run: runId,
        p_ids: ids,
      })
      if (error)
        throw new Error(`seo ai answers begin failed: ${error.message}`)
      return (
        (data ?? []) as Array<string | { seo_ai_answers_begin?: string }>
      ).map((v) => (typeof v === 'string' ? v : String(v.seo_ai_answers_begin)))
    },

    async markPosted(runId, posted) {
      const now = new Date().toISOString()
      // One update per answer: each carries its own task id. At most 100 per post.
      for (const p of posted) {
        const { error } = await svc
          .from('seo_ai_answer')
          .update({
            status: 'posted',
            task_id: p.task_id.slice(0, 100),
            cost_usd: Math.max(0, p.cost_usd),
            updated_at: now,
          })
          .eq('run_id', runId)
          .eq('id', p.id)
          .eq('status', 'asking')
        if (error)
          throw new Error(`seo ai mark posted failed: ${error.message}`)
      }
    },

    async saveAnswer(runId, answer: CollectedAnswer, opts) {
      const now = new Date().toISOString()
      // Sources first (ids derived from the answer and URL: a repeat writes the same rows), then the answer's own CAS.
      if (answer.sources.length) {
        const { data: run } = await svc
          .from('seo_ai_run')
          .select('workspace_id')
          .eq('id', runId)
          .maybeSingle()
        const workspaceId = (run as { workspace_id?: string } | null)
          ?.workspace_id
        if (!workspaceId) return false
        const { error: sourceError } = await svc.from('seo_ai_source').upsert(
          answer.sources.map((s) => ({
            id: s.id,
            answer_id: answer.id,
            run_id: runId,
            workspace_id: workspaceId,
            url: s.url,
            domain: s.domain.slice(0, 253),
            title: s.title,
            position: s.position,
          })),
          { onConflict: 'id', ignoreDuplicates: true },
        )
        if (sourceError)
          throw new Error(`seo ai sources write failed: ${sourceError.message}`)
      }
      const patch: Record<string, unknown> = {
        status: 'collected',
        has_answer: answer.has_answer,
        answer_markdown: answer.answer_markdown,
        model_name: answer.model_name ? answer.model_name.slice(0, 100) : null,
        brand_mentioned: answer.brand_mentioned,
        brand_cited: answer.brand_cited,
        brand_position: answer.brand_position,
        brand_first_offset: answer.brand_first_offset,
        matches: answer.matches,
        citation_count: answer.citation_count,
        collected_at: answer.collected_at,
        error_code: null,
        late: opts.late,
        updated_at: now,
      }
      if (answer.cost_usd !== null)
        patch.cost_usd = Math.max(0, answer.cost_usd)
      let query = svc
        .from('seo_ai_answer')
        .update(patch)
        .eq('run_id', runId)
        .eq('id', answer.id)
      query = opts.late
        ? query.eq('status', 'failed').eq('error_code', 'NOT_ARRIVED')
        : query.in('status', ['asking', 'posted'])
      const { data, error } = await query.select('id')
      if (error) throw new Error(`seo ai answer write failed: ${error.message}`)
      return (data ?? []).length > 0
    },

    async failAnswers(runId, ids, code, from: AiAnswerStatus[], opts) {
      if (ids && ids.length === 0) return 0
      const patch: Record<string, unknown> = {
        status: 'failed',
        error_code: code.slice(0, 60),
        updated_at: new Date().toISOString(),
      }
      // What a failed answer was still charged, so the check's cost counts it.
      if (opts?.costUsd !== undefined)
        patch.cost_usd = Math.max(0, Number(opts.costUsd) || 0)
      let query = svc
        .from('seo_ai_answer')
        .update(patch)
        .eq('run_id', runId)
        .in('status', from)
      if (ids) query = query.in('id', ids)
      const { data, error } = await query.select('id')
      if (error) throw new Error(`seo ai fail answers failed: ${error.message}`)
      return (data ?? []).length
    },

    async refreshCounts(runId) {
      const { data, error } = await svc.rpc('seo_ai_refresh_run_counts', {
        p_run: runId,
      })
      if (error) throw new Error(`seo ai run counts failed: ${error.message}`)
      const row = (Array.isArray(data) ? data[0] : data) as
        | (Omit<RunCounts, 'cost_usd'> & { cost_usd: number | string | null })
        | null
      if (!row)
        return {
          answers_total: 0,
          answers_collected: 0,
          answers_no_answer: 0,
          answers_failed: 0,
          answers_late: 0,
          answers_open: 0,
          cost_usd: 0,
        }
      // numeric arrives as a string.
      return { ...row, cost_usd: Number(row.cost_usd) || 0 }
    },

    async finishRun(runId, patch) {
      const now = new Date().toISOString()
      const { data, error } = await svc
        .from('seo_ai_run')
        .update({ ...patch, completed_at: now, updated_at: now })
        .eq('id', runId)
        .in('status', ['queued', 'running'])
        .select('id')
      if (error) throw new Error(`seo ai run finish failed: ${error.message}`)
      return (data ?? []).length > 0
    },

    async touchTracker(trackerId, patch) {
      const { error } = await svc
        .from('seo_ai_tracker')
        .update(patch)
        .eq('id', trackerId)
      if (error) console.error('[seo-ai] tracker touch failed', error.message)
    },
  }
}
