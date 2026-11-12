/**
 * What the product reads about AI visibility (the SEO pages and the tools):
 * trackers, prompts, checks, a check's results, one answer, the sources
 * leaderboard, the trend, an export. All free: nothing here buys anything.
 * Every read is scoped by workspace_id in the query: the caller's client is
 * the service role's, so the filter is the fence.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { markdownToText } from './evidence'
import {
  AI_PAGE_SIZE,
  ANSWER_READ_LIMIT,
  type AiScheduleSetting,
} from './limits'
import { aiBrandNames, aiMentionSpans, ownedAiDomain } from './matching'
import {
  answerCoverage,
  brandSummaries,
  computeTrend,
  engineShares,
  gapPrompts,
  inScope,
  promptShares,
  type ResultAnswer,
  type TrendCell,
} from './results'
import {
  answerErrorMessage,
  isLiveRun,
  marketLabel,
  skipReasonMessage,
  type AiAnswerDetail,
  type AiAnswerRow,
  type AiAnswerStatus,
  type AiBrandRef,
  type AiBrandResult,
  type AiEngine,
  type AiPromptScope,
  type AiPromptSource,
  type AiPromptView,
  type AiRunBrand,
  type AiRunResults,
  type AiRunStatus,
  type AiRunTrigger,
  type AiRunView,
  type AiSkipReason,
  type AiSourceOwnership,
  type AiSourcesView,
  type AiTrackerListItem,
  type AiTrackerView,
  type AiTrend,
} from './view'

/** PostgREST answers at most this many rows per request. */
const PAGE = 1000

export const TRACKER_FIELDS =
  'id, workspace_id, created_by, brand_name, brand_aliases, domain, competitors, location_code, language_code, engines, schedule_interval, next_run_at, last_run_at, last_skip_reason, paused, created_at, updated_at'

export interface TrackerRow {
  id: string
  workspace_id: string
  created_by: string | null
  brand_name: string
  brand_aliases: string[] | null
  domain: string
  competitors: unknown
  location_code: number
  language_code: string
  engines: AiEngine[]
  schedule_interval: AiScheduleSetting
  next_run_at: string | null
  last_run_at: string | null
  last_skip_reason: AiSkipReason | null
  paused: boolean
  created_at: string
  updated_at: string
}

export function readCompetitors(value: unknown): AiBrandRef[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c) => ({
      name:
        typeof c.name === 'string' && c.name ? c.name : String(c.domain ?? ''),
      domain: typeof c.domain === 'string' ? c.domain : '',
      aliases: Array.isArray(c.aliases)
        ? c.aliases.filter((a): a is string => typeof a === 'string')
        : [],
    }))
    .filter((c) => c.domain)
}

export function trackerView(row: TrackerRow): AiTrackerView {
  return {
    id: row.id,
    brand_name: row.brand_name,
    brand_aliases: row.brand_aliases ?? [],
    domain: row.domain,
    competitors: readCompetitors(row.competitors),
    location_code: row.location_code,
    language_code: row.language_code,
    market_label: marketLabel(row.location_code, row.language_code),
    engines: row.engines,
    schedule_interval: row.schedule_interval,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    last_skip_reason: row.last_skip_reason,
    last_skip_message: skipReasonMessage(row.last_skip_reason),
    paused: row.paused,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/** The brands a check matches: the tracker's own first, then its competitors. */
export function trackerBrands(
  tracker: Pick<
    AiTrackerView,
    'brand_name' | 'brand_aliases' | 'domain' | 'competitors'
  >,
): AiRunBrand[] {
  const brands: AiRunBrand[] = [
    {
      name: tracker.brand_name,
      domain: tracker.domain,
      aliases: tracker.brand_aliases,
      own: true,
    },
  ]
  for (const c of tracker.competitors) {
    if (brands.some((b) => b.domain === c.domain)) continue
    brands.push({
      name: c.name || c.domain,
      domain: c.domain,
      aliases: c.aliases,
      own: false,
    })
  }
  return brands
}

export const PROMPT_FIELDS = 'id, tracker_id, text, source, active, created_at'

interface PromptRow {
  id: string
  tracker_id: string
  text: string
  source: AiPromptSource
  active: boolean
  created_at: string
}

export function promptView(row: PromptRow): AiPromptView {
  return {
    id: row.id,
    text: row.text,
    source: row.source,
    active: row.active,
    created_at: row.created_at,
  }
}

export const RUN_FIELDS =
  'id, tracker_id, workspace_id, started_by, trigger, scheduled_for, status, engines, location_code, language_code, brands, answers_total, answers_collected, answers_no_answer, answers_failed, answers_late, estimate_usd, cost_usd, error_code, error_detail, created_at, started_at, completed_at'

export interface RunRow {
  id: string
  tracker_id: string
  workspace_id: string
  started_by: string | null
  trigger: AiRunTrigger
  scheduled_for: string | null
  status: AiRunStatus
  engines: AiEngine[]
  location_code: number
  language_code: string
  brands: unknown
  answers_total: number
  answers_collected: number
  answers_no_answer: number
  answers_failed: number
  answers_late: number
  estimate_usd: number | string
  cost_usd: number | string
  error_code: string | null
  error_detail: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export function readRunBrands(value: unknown): AiRunBrand[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(
      (b): b is Record<string, unknown> =>
        !!b && typeof b === 'object' && typeof b.domain === 'string',
    )
    .map((b) => ({
      name: typeof b.name === 'string' ? b.name : String(b.domain),
      domain: String(b.domain),
      own: b.own === true,
      aliases: Array.isArray(b.aliases)
        ? b.aliases.filter((a): a is string => typeof a === 'string')
        : [],
    }))
}

export function runView(row: RunRow): AiRunView {
  const settled =
    row.answers_collected + row.answers_no_answer + row.answers_failed
  const live = isLiveRun(row.status)
  return {
    id: row.id,
    tracker_id: row.tracker_id,
    trigger: row.trigger,
    status: row.status,
    engines: row.engines,
    location_code: row.location_code,
    language_code: row.language_code,
    started_by: row.started_by,
    scheduled_for: row.scheduled_for,
    answers_total: row.answers_total,
    answers_collected: row.answers_collected,
    answers_no_answer: row.answers_no_answer,
    answers_failed: row.answers_failed,
    answers_late: row.answers_late,
    answers_open: live ? Math.max(row.answers_total - settled, 0) : 0,
    estimate_usd: Number(row.estimate_usd) || 0,
    cost_usd: Number(row.cost_usd) || 0,
    error_code: row.error_code,
    error:
      row.status === 'failed'
        ? (row.error_detail ?? 'The check stopped unexpectedly. Run it again.')
        : null,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    poll_after_seconds: live ? 30 : null,
  }
}

const ANSWER_FIELDS =
  'id, run_id, prompt_id, prompt_text, engine, branded, status, has_answer, brand_mentioned, brand_cited, brand_position, matches, citation_count, model_name, late, error_code, collected_at'

export interface AnswerRecord {
  id: string
  run_id: string
  prompt_id: string
  prompt_text: string
  engine: AiEngine
  branded: boolean
  status: AiAnswerStatus
  has_answer: boolean
  brand_mentioned: boolean | null
  brand_cited: boolean | null
  brand_position: number | null
  matches: unknown
  citation_count: number
  model_name: string | null
  late: boolean
  error_code: string | null
  collected_at: string | null
}

export function readMatches(value: unknown): AiBrandResult[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(
      (m): m is Record<string, unknown> =>
        !!m && typeof m === 'object' && typeof m.domain === 'string',
    )
    .map((m) => ({
      name: typeof m.name === 'string' ? m.name : String(m.domain),
      domain: String(m.domain),
      own: m.own === true,
      mentioned: m.mentioned === true,
      cited: m.cited === true,
      first_mention:
        typeof m.first_mention === 'number' ? m.first_mention : null,
      position: typeof m.position === 'number' ? m.position : null,
    }))
}

export function answerRow(row: AnswerRecord): AiAnswerRow {
  const matches = readMatches(row.matches)
  return {
    id: row.id,
    run_id: row.run_id,
    prompt_id: row.prompt_id,
    prompt: row.prompt_text,
    engine: row.engine,
    branded: row.branded,
    status: row.status,
    answer_status:
      row.status !== 'collected'
        ? null
        : row.has_answer
          ? 'answered'
          : 'no_answer',
    brand_mentioned: row.brand_mentioned,
    brand_cited: row.brand_cited,
    brand_position: row.brand_position,
    competitors_named: matches
      .filter((m) => !m.own && (m.mentioned || m.cited))
      .map((m) => m.name),
    citation_count: row.citation_count,
    model_name: row.model_name,
    late: row.late,
    error_code: row.status === 'failed' ? row.error_code : null,
    error: row.status === 'failed' ? answerErrorMessage(row.error_code) : null,
    collected_at: row.collected_at,
  }
}

function resultAnswer(row: AnswerRecord): ResultAnswer {
  return {
    id: row.id,
    prompt_id: row.prompt_id,
    prompt: row.prompt_text,
    engine: row.engine,
    branded: row.branded,
    status: row.status,
    has_answer: row.has_answer,
    brand_mentioned: row.brand_mentioned,
    brand_cited: row.brand_cited,
    matches: readMatches(row.matches),
  }
}

// ---------------------------------------------------------------------------
// Trackers and prompts
// ---------------------------------------------------------------------------

export async function getTrackerRow(
  svc: SupabaseClient,
  workspaceId: string,
  trackerId: string,
): Promise<TrackerRow | null> {
  const { data, error } = await svc
    .from('seo_ai_tracker')
    .select(TRACKER_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('id', trackerId)
    .maybeSingle()
  if (error) throw new Error(`seo ai tracker read failed: ${error.message}`)
  return (data as TrackerRow | null) ?? null
}

export async function getTracker(
  svc: SupabaseClient,
  workspaceId: string,
  trackerId: string,
): Promise<AiTrackerView | null> {
  const row = await getTrackerRow(svc, workspaceId, trackerId)
  return row ? trackerView(row) : null
}

export async function listPrompts(
  svc: SupabaseClient,
  workspaceId: string,
  trackerId: string,
): Promise<AiPromptView[]> {
  const { data, error } = await svc
    .from('seo_ai_prompt')
    .select(PROMPT_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('tracker_id', trackerId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(0, PAGE - 1)
  if (error) throw new Error(`seo ai prompts read failed: ${error.message}`)
  return ((data ?? []) as PromptRow[]).map(promptView)
}

/** The workspace's trackers, newest first, with prompt counts and each one's latest check. */
export async function listTrackers(
  svc: SupabaseClient,
  workspaceId: string,
): Promise<AiTrackerListItem[]> {
  const { data, error } = await svc
    .from('seo_ai_tracker')
    .select(TRACKER_FIELDS)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw new Error(`seo ai trackers read failed: ${error.message}`)
  const trackers = (data ?? []) as TrackerRow[]
  if (trackers.length === 0) return []
  const ids = trackers.map((t) => t.id)
  const [prompts, runs] = await Promise.all([
    svc
      .from('seo_ai_prompt')
      .select('tracker_id, active')
      .eq('workspace_id', workspaceId)
      .in('tracker_id', ids)
      .range(0, PAGE - 1),
    svc
      .from('seo_ai_run')
      .select(RUN_FIELDS)
      .eq('workspace_id', workspaceId)
      .in('tracker_id', ids)
      .order('created_at', { ascending: false })
      .limit(200),
  ])
  if (prompts.error)
    throw new Error(`seo ai prompts read failed: ${prompts.error.message}`)
  if (runs.error)
    throw new Error(`seo ai runs read failed: ${runs.error.message}`)
  const promptRows = (prompts.data ?? []) as Array<{
    tracker_id: string
    active: boolean
  }>
  const runRows = (runs.data ?? []) as RunRow[]
  return trackers.map((t) => {
    const mine = promptRows.filter((p) => p.tracker_id === t.id)
    const latest = runRows.find((r) => r.tracker_id === t.id)
    return {
      ...trackerView(t),
      prompt_count: mine.length,
      active_prompt_count: mine.filter((p) => p.active).length,
      latest_run: latest ? runView(latest) : null,
    }
  })
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export async function getRunRow(
  svc: SupabaseClient,
  workspaceId: string,
  runId: string,
): Promise<RunRow | null> {
  const { data, error } = await svc
    .from('seo_ai_run')
    .select(RUN_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('id', runId)
    .maybeSingle()
  if (error) throw new Error(`seo ai run read failed: ${error.message}`)
  return (data as RunRow | null) ?? null
}

export async function getRun(
  svc: SupabaseClient,
  workspaceId: string,
  runId: string,
): Promise<AiRunView | null> {
  const row = await getRunRow(svc, workspaceId, runId)
  return row ? runView(row) : null
}

export async function getLiveRun(
  svc: SupabaseClient,
  workspaceId: string,
  trackerId: string,
): Promise<RunRow | null> {
  const { data, error } = await svc
    .from('seo_ai_run')
    .select(RUN_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('tracker_id', trackerId)
    .in('status', ['queued', 'running'])
    .limit(1)
  if (error) throw new Error(`seo ai live run read failed: ${error.message}`)
  return ((data ?? []) as RunRow[])[0] ?? null
}

/** A tracker's checks, newest first, a page at a time. */
export async function listRuns(
  svc: SupabaseClient,
  workspaceId: string,
  trackerId: string,
  offset = 0,
  limit = AI_PAGE_SIZE,
): Promise<{ rows: AiRunView[]; next_offset: number | null }> {
  const size = Math.min(Math.max(limit, 1), AI_PAGE_SIZE)
  const from = Math.max(0, Math.floor(offset))
  const { data, error } = await svc
    .from('seo_ai_run')
    .select(RUN_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('tracker_id', trackerId)
    .order('created_at', { ascending: false })
    .range(from, from + size)
  if (error) throw new Error(`seo ai runs read failed: ${error.message}`)
  const rows = (data ?? []) as RunRow[]
  return {
    rows: rows.slice(0, size).map(runView),
    next_offset: rows.length > size ? from + size : null,
  }
}

/** The newest completed check of a tracker, or null. */
export async function latestCompletedRun(
  svc: SupabaseClient,
  workspaceId: string,
  trackerId: string,
): Promise<RunRow | null> {
  const { data, error } = await svc
    .from('seo_ai_run')
    .select(RUN_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('tracker_id', trackerId)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(`seo ai run read failed: ${error.message}`)
  return ((data ?? []) as RunRow[])[0] ?? null
}

/** Every answer of a check (at most a few hundred), in a stable order. */
export async function listRunAnswers(
  svc: SupabaseClient,
  workspaceId: string,
  runId: string,
): Promise<AnswerRecord[]> {
  const out: AnswerRecord[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await svc
      .from('seo_ai_answer')
      .select(ANSWER_FIELDS)
      .eq('workspace_id', workspaceId)
      .eq('run_id', runId)
      .order('prompt_text', { ascending: true })
      .order('engine', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`seo ai answers read failed: ${error.message}`)
    const rows = (data ?? []) as AnswerRecord[]
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

/** A check's results: coverage, the brand by engine and by prompt, the brands side by side, the gaps, and a page of answers. */
export async function getRunResults(
  svc: SupabaseClient,
  workspaceId: string,
  runId: string,
  opts: { scope?: AiPromptScope; offset?: number } = {},
): Promise<AiRunResults | null> {
  const run = await getRunRow(svc, workspaceId, runId)
  if (!run) return null
  const scope = opts.scope ?? 'neutral'
  const records = await listRunAnswers(svc, workspaceId, runId)
  const scoped = inScope(records, scope)
  const answers = scoped.map(resultAnswer)
  const prompts = promptShares(answers)
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  return {
    run: runView(run),
    scope,
    coverage: answerCoverage(answers),
    by_engine: engineShares(answers, run.engines),
    by_prompt: prompts,
    brands: brandSummaries(answers, readRunBrands(run.brands)),
    gaps: gapPrompts(prompts),
    rows: scoped.slice(offset, offset + AI_PAGE_SIZE).map(answerRow),
    next_offset:
      offset + AI_PAGE_SIZE < scoped.length ? offset + AI_PAGE_SIZE : null,
  }
}

// ---------------------------------------------------------------------------
// One answer
// ---------------------------------------------------------------------------

/** One answer in full: the text (cut at ANSWER_READ_LIMIT unless `full`), where each brand is named, the cited pages. */
export async function getAnswerDetail(
  svc: SupabaseClient,
  workspaceId: string,
  answerId: string,
  opts: { full?: boolean } = {},
): Promise<AiAnswerDetail | null> {
  const { data, error } = await svc
    .from('seo_ai_answer')
    .select(`${ANSWER_FIELDS}, answer_markdown`)
    .eq('workspace_id', workspaceId)
    .eq('id', answerId)
    .maybeSingle()
  if (error) throw new Error(`seo ai answer read failed: ${error.message}`)
  if (!data) return null
  const record = data as AnswerRecord & { answer_markdown: string | null }
  const [run, sources] = await Promise.all([
    getRunRow(svc, workspaceId, record.run_id),
    svc
      .from('seo_ai_source')
      .select('url, domain, title, position')
      .eq('workspace_id', workspaceId)
      .eq('answer_id', answerId)
      .order('position', { ascending: true })
      .range(0, PAGE - 1),
  ])
  if (sources.error)
    throw new Error(`seo ai sources read failed: ${sources.error.message}`)
  const limit = opts.full ? Infinity : ANSWER_READ_LIMIT
  const markdown = record.answer_markdown
  const text = markdown ? markdownToText(markdown) : null
  const brands = readMatches(record.matches)
  const runBrands = run ? readRunBrands(run.brands) : []
  return {
    answer: answerRow(record),
    answer_markdown: markdown ? markdown.slice(0, limit) : null,
    truncated: (markdown?.length ?? 0) > limit,
    sources: (sources.data ?? []) as AiAnswerDetail['sources'],
    brands,
    mentions: text
      ? brands
          .filter((b) => b.mentioned)
          .map((b) => {
            const ref = runBrands.find((r) => r.domain === b.domain)
            return {
              domain: b.domain,
              name: b.name,
              spans: aiMentionSpans(
                text,
                aiBrandNames({
                  name: b.name,
                  domain: b.domain,
                  aliases: ref?.aliases ?? [],
                }),
              ),
            }
          })
      : [],
    location_code: run?.location_code ?? 0,
    language_code: run?.language_code ?? '',
  }
}

// ---------------------------------------------------------------------------
// Sources leaderboard
// ---------------------------------------------------------------------------

function ownership(domain: string, brands: AiRunBrand[]): AiSourceOwnership {
  const own = brands.find((b) => b.own)
  if (own && ownedAiDomain(domain, own.domain)) return 'own'
  return brands.some((b) => !b.own && ownedAiDomain(domain, b.domain))
    ? 'competitor'
    : 'other'
}

/** Which domains (or pages) a check's answers cited, most-cited first. */
export async function getRunSources(
  svc: SupabaseClient,
  workspaceId: string,
  runId: string,
  opts: {
    groupBy?: 'domain' | 'page'
    domain?: string | null
    offset?: number
  } = {},
): Promise<AiSourcesView | null> {
  const run = await getRunRow(svc, workspaceId, runId)
  if (!run) return null
  const brands = readRunBrands(run.brands)
  const groupBy = opts.groupBy ?? 'domain'
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  if (groupBy === 'domain') {
    const { data, error } = await svc.rpc('seo_ai_cited_domains', {
      p_run: run.id,
      p_limit: AI_PAGE_SIZE,
      p_offset: offset,
    })
    if (error) throw new Error(`seo ai cited domains failed: ${error.message}`)
    const rows = (data ?? []) as Array<{
      domain: string
      answer_count: number
      prompt_count: number
      engines: Record<string, number>
      total_count: number
    }>
    const total = Number(rows[0]?.total_count ?? 0)
    return {
      run_id: run.id,
      group_by: 'domain',
      rows: rows.map((r) => ({
        key: r.domain,
        domain: r.domain,
        url: null,
        title: null,
        ownership: ownership(r.domain, brands),
        answer_count: Number(r.answer_count),
        prompt_count: Number(r.prompt_count),
        engines: Object.entries(r.engines ?? {}).map(([engine, n]) => ({
          engine: engine as AiEngine,
          answer_count: Number(n),
        })),
      })),
      total_count: total,
      next_offset: offset + rows.length < total ? offset + rows.length : null,
    }
  }
  const { data, error } = await svc.rpc('seo_ai_cited_pages', {
    p_run: run.id,
    p_domain: opts.domain ?? null,
    p_limit: AI_PAGE_SIZE,
    p_offset: offset,
  })
  if (error) throw new Error(`seo ai cited pages failed: ${error.message}`)
  const rows = (data ?? []) as Array<{
    url: string
    domain: string
    title: string | null
    answer_count: number
    prompt_count: number
    total_count: number
  }>
  const total = Number(rows[0]?.total_count ?? 0)
  return {
    run_id: run.id,
    group_by: 'page',
    rows: rows.map((r) => ({
      key: r.url,
      domain: r.domain,
      url: r.url,
      title: r.title,
      ownership: ownership(r.domain, brands),
      answer_count: Number(r.answer_count),
      prompt_count: Number(r.prompt_count),
      engines: [],
    })),
    total_count: total,
    next_offset: offset + rows.length < total ? offset + rows.length : null,
  }
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

/** At most this many trend cells are read (a year of weekly checks of a full tracker is about 13,000). */
const MAX_TREND_CELLS = 20_000

/** The trend of a tracker of this workspace (null when it isn't one). */
export async function getTrend(
  svc: SupabaseClient,
  workspaceId: string,
  trackerId: string,
  days: number,
  now: Date = new Date(),
): Promise<AiTrend | null> {
  // The function reads by tracker id: the tracker's own row is the fence.
  if (!(await getTrackerRow(svc, workspaceId, trackerId))) return null
  const since = new Date(now.getTime() - 2 * days * 86_400_000).toISOString()
  const cells: TrendCell[] = []
  for (let from = 0; from < MAX_TREND_CELLS; from += PAGE) {
    const { data, error } = await svc
      .rpc('seo_ai_trend_cells', { p_tracker: trackerId, p_since: since })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`seo ai trend read failed: ${error.message}`)
    const rows = (data ?? []) as TrendCell[]
    cells.push(...rows)
    if (rows.length < PAGE) break
  }
  return computeTrend(cells, days, now)
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function csvCell(value: string | number | boolean | null | undefined): string {
  let text = value == null ? '' : String(value)
  // A cell a spreadsheet would run as a formula is written as text.
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

/** One check as CSV: a row per answer, with the brands it named, the pages it cited, and the answer's text. */
export async function exportRunCsv(
  svc: SupabaseClient,
  workspaceId: string,
  runId: string,
): Promise<string | null> {
  const run = await getRunRow(svc, workspaceId, runId)
  if (!run) return null
  const answers: Array<AnswerRecord & { answer_markdown: string | null }> = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await svc
      .from('seo_ai_answer')
      .select(`${ANSWER_FIELDS}, answer_markdown`)
      .eq('workspace_id', workspaceId)
      .eq('run_id', runId)
      .order('prompt_text', { ascending: true })
      .order('engine', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`seo ai export read failed: ${error.message}`)
    const rows = (data ?? []) as Array<
      AnswerRecord & { answer_markdown: string | null }
    >
    answers.push(...rows)
    if (rows.length < PAGE) break
  }
  const urlsByAnswer = new Map<string, string[]>()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await svc
      .from('seo_ai_source')
      .select('answer_id, url, position')
      .eq('workspace_id', workspaceId)
      .eq('run_id', runId)
      .order('answer_id', { ascending: true })
      .order('position', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`seo ai export sources failed: ${error.message}`)
    const rows = (data ?? []) as Array<{ answer_id: string; url: string }>
    for (const row of rows)
      urlsByAnswer.set(row.answer_id, [
        ...(urlsByAnswer.get(row.answer_id) ?? []),
        row.url,
      ])
    if (rows.length < PAGE) break
  }
  const header = [
    'run_id',
    'answer_id',
    'prompt',
    'engine',
    'branded_prompt',
    'status',
    'collected_at',
    'late',
    'brand_mentioned',
    'brand_cited',
    'brand_position',
    'brands_named',
    'citation_urls',
    'answer',
  ]
  const lines = answers.map((a) => {
    const matches = readMatches(a.matches)
    return [
      a.run_id,
      a.id,
      a.prompt_text,
      a.engine,
      a.branded,
      a.status === 'failed'
        ? `failed (${a.error_code ?? 'unknown'})`
        : a.status === 'collected' && !a.has_answer
          ? 'no answer'
          : a.status,
      a.collected_at,
      a.late,
      a.brand_mentioned,
      a.brand_cited,
      a.brand_position,
      matches
        .filter((m) => m.mentioned)
        .map((m) => m.name)
        .join('; '),
      (urlsByAnswer.get(a.id) ?? []).join('; '),
      a.answer_markdown ? markdownToText(a.answer_markdown) : '',
    ]
      .map(csvCell)
      .join(',')
  })
  return [header.map(csvCell).join(','), ...lines].join('\r\n')
}
