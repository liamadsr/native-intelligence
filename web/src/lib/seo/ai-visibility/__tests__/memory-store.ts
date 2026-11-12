/**
 * An in-memory AiRunStore that behaves like the Supabase one (../store.ts)
 * over migration 596, for the engine's tests. The SQL rules are mirrored:
 *
 *   claimRun        queued or running -> running; anything else refuses.
 *   beginAnswers    seo_ai_answers_begin: nothing unless the check is
 *                   running; then pending -> asking for the ids named, and
 *                   only those come back (a repeat gets nothing).
 *   markPosted      asking -> posted, with the task id and cost.
 *   saveAnswer      asking/posted -> collected (late: failed NOT_ARRIVED ->
 *                   collected, marked late); sources upserted by id.
 *   failAnswers     the named (or all) answers still in `from` -> failed (with
 *                   the cost they were charged, when given).
 *   refreshCounts   seo_ai_refresh_run_counts.
 *   finishRun       queued/running -> the given end.
 */
import type {
  AiRunStore,
  CollectedAnswer,
  EngineRun,
  OpenAnswer,
  RunCounts,
} from '../engine'
import type { AiAnswerStatus, AiEngine } from '../view'

export interface MemAnswer extends OpenAnswer {
  prompt_id: string
  branded: boolean
  cost_usd: number
  late: boolean
  collected?: CollectedAnswer
  writes: number
}

export interface MemRun extends EngineRun {
  counts: RunCounts
  error_code: string | null
  error_detail: string | null
}

export function createMemoryStore(seed: {
  /** estimate_usd defaults to more than any test check costs. */
  run: Omit<MemRun, 'counts' | 'error_code' | 'error_detail' | 'estimate_usd'> & {
    estimate_usd?: number
  }
  tracker?: {
    workspace_id: string
    created_by: string | null
    paused: boolean
    schedule_interval: string
  }
  answers: Array<{
    id: string
    prompt_id?: string
    prompt_text: string
    engine: AiEngine
    branded?: boolean
  }>
}) {
  const run: MemRun = {
    ...seed.run,
    estimate_usd: seed.run.estimate_usd ?? 1000,
    counts: {
      answers_total: 0,
      answers_collected: 0,
      answers_no_answer: 0,
      answers_failed: 0,
      answers_late: 0,
      answers_open: 0,
      cost_usd: 0,
    },
    error_code: null,
    error_detail: null,
  }
  const tracker = seed.tracker ?? {
    workspace_id: run.workspace_id,
    created_by: 'person',
    paused: false,
    schedule_interval: 'weekly',
  }
  const answers = new Map<string, MemAnswer>(
    seed.answers.map((a) => [
      a.id,
      {
        id: a.id,
        prompt_id: a.prompt_id ?? `p-${a.id}`,
        prompt_text: a.prompt_text,
        engine: a.engine,
        branded: a.branded ?? false,
        status: 'pending' as AiAnswerStatus,
        task_id: null,
        error_code: null,
        cost_usd: 0,
        late: false,
        writes: 0,
      },
    ]),
  )
  const sources = new Map<string, { answer_id: string; url: string }>()
  const tracker_touches: string[] = []

  const store: AiRunStore = {
    async getRun(runId) {
      return runId === run.id
        ? { ...run, brands: run.brands.map((b) => ({ ...b })) }
        : null
    },
    async claimRun(runId) {
      if (
        runId !== run.id ||
        (run.status !== 'queued' && run.status !== 'running')
      )
        return false
      run.status = 'running'
      return true
    },
    async getTracker() {
      return { ...tracker }
    },
    async listAnswers(runId, filter) {
      if (runId !== run.id) return []
      return [...answers.values()]
        .filter((a) => filter.statuses.includes(a.status))
        .filter((a) => !filter.ids || filter.ids.includes(a.id))
        .filter((a) => !filter.errorCode || a.error_code === filter.errorCode)
        .filter((a) => !filter.withTask || a.task_id !== null)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((a) => ({
          id: a.id,
          prompt_text: a.prompt_text,
          engine: a.engine,
          status: a.status,
          task_id: a.task_id,
          error_code: a.error_code,
        }))
    },
    async beginAnswers(runId, ids) {
      if (runId !== run.id || run.status !== 'running') return []
      const out: string[] = []
      for (const id of ids) {
        const a = answers.get(id)
        if (a && a.status === 'pending') {
          a.status = 'asking'
          out.push(id)
        }
      }
      return out
    },
    async markPosted(_runId, posted) {
      for (const p of posted) {
        const a = answers.get(p.id)
        if (a && a.status === 'asking') {
          a.status = 'posted'
          a.task_id = p.task_id
          a.cost_usd = p.cost_usd
        }
      }
    },
    async saveAnswer(_runId, answer, opts) {
      const a = answers.get(answer.id)
      if (!a) return false
      for (const s of answer.sources)
        sources.set(s.id, { answer_id: answer.id, url: s.url })
      const ok = opts.late
        ? a.status === 'failed' && a.error_code === 'NOT_ARRIVED'
        : a.status === 'asking' || a.status === 'posted'
      if (!ok) return false
      a.status = 'collected'
      a.error_code = null
      a.late = opts.late
      a.collected = answer
      a.writes++
      if (answer.cost_usd !== null) a.cost_usd = answer.cost_usd
      return true
    },
    async failAnswers(_runId, ids, code, from, opts) {
      let n = 0
      for (const a of answers.values()) {
        if (ids && !ids.includes(a.id)) continue
        if (!from.includes(a.status)) continue
        a.status = 'failed'
        a.error_code = code
        if (opts?.costUsd !== undefined) a.cost_usd = Math.max(0, opts.costUsd)
        n++
      }
      return n
    },
    async refreshCounts() {
      const all = [...answers.values()]
      run.counts = {
        answers_total: all.length,
        answers_collected: all.filter(
          (a) => a.status === 'collected' && a.collected?.has_answer,
        ).length,
        answers_no_answer: all.filter(
          (a) => a.status === 'collected' && !a.collected?.has_answer,
        ).length,
        answers_failed: all.filter((a) => a.status === 'failed').length,
        answers_late: all.filter((a) => a.late).length,
        answers_open: all.filter(
          (a) =>
            a.status === 'pending' ||
            a.status === 'asking' ||
            a.status === 'posted',
        ).length,
        cost_usd: all.reduce((sum, a) => sum + a.cost_usd, 0),
      }
      return { ...run.counts }
    },
    async finishRun(_runId, patch) {
      if (run.status !== 'queued' && run.status !== 'running') return false
      run.status = patch.status
      run.error_code = patch.error_code
      run.error_detail = patch.error_detail
      return true
    },
    async touchTracker(trackerId) {
      tracker_touches.push(trackerId)
    },
  }
  return { store, run, answers, sources, tracker, tracker_touches }
}
