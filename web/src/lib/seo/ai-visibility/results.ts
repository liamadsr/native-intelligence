/**
 * The maths behind a check's results and the trend across checks. Pure: the
 * queries (./queries.ts) read the rows, this counts them.
 *
 * The rules, for every figure here:
 *
 *   - Rates count ANSWERED answers only (collected with text). An answer that
 *     failed, or came back empty ("no AI Overview shown"), is coverage, never
 *     lost visibility.
 *   - Branded prompts (the prompt names the brand) always mention it, so the
 *     default scope is neutral prompts; branded or all on request.
 *   - A brand's position is its place among the tracked brands an answer
 *     names, in order of first mention (1 is named first).
 *   - A gap is a prompt where some engine's answer names or cites a
 *     competitor and none names or cites the brand.
 *   - The trend compares the latest N days with the N days before over
 *     CELLS: one prompt on one engine in one market for one brand domain.
 *     Each period's rate is the mean of the cells' own rates over the cells
 *     answered in both periods, so a prompt added or an engine dropped does
 *     not move the line. A change is reported only when both periods
 *     collected at least 90% of their planned answers.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import { ALL_AI_ENGINES } from './limits'
import {
  engineLabel,
  rate,
  type AiAnswerStatus,
  type AiBrandResult,
  type AiBrandSummary,
  type AiCoverage,
  type AiEngine,
  type AiEngineShare,
  type AiPromptScope,
  type AiPromptShare,
  type AiRunBrand,
  type AiTrend,
  type AiTrendComparison,
  type AiTrendCoverage,
  type AiTrendMetric,
} from './view'

/** One answer as the results read it. */
export interface ResultAnswer {
  id: string
  prompt_id: string
  prompt: string
  engine: AiEngine
  branded: boolean
  status: AiAnswerStatus
  has_answer: boolean
  brand_mentioned: boolean | null
  brand_cited: boolean | null
  matches: AiBrandResult[]
}

export function isAnswered(
  row: Pick<ResultAnswer, 'status' | 'has_answer'>,
): boolean {
  return row.status === 'collected' && row.has_answer
}

export function inScope<T extends Pick<ResultAnswer, 'branded'>>(
  rows: T[],
  scope: AiPromptScope,
): T[] {
  if (scope === 'all') return rows
  return rows.filter((row) =>
    scope === 'branded' ? row.branded : !row.branded,
  )
}

export function answerCoverage(rows: ResultAnswer[]): AiCoverage {
  return {
    expected: rows.length,
    answered: rows.filter(isAnswered).length,
    no_answer: rows.filter((r) => r.status === 'collected' && !r.has_answer)
      .length,
    failed: rows.filter((r) => r.status === 'failed').length,
    pending: rows.filter(
      (r) => r.status !== 'collected' && r.status !== 'failed',
    ).length,
  }
}

export function engineShares(
  rows: ResultAnswer[],
  engines: readonly AiEngine[],
): AiEngineShare[] {
  return engines.map((engine) => {
    const answered = rows.filter((r) => r.engine === engine && isAnswered(r))
    const mentioned = answered.filter((r) => r.brand_mentioned).length
    const cited = answered.filter((r) => r.brand_cited).length
    return {
      engine,
      label: engineLabel(engine),
      answered: answered.length,
      mentioned,
      cited,
      mention_rate: rate(mentioned, answered.length),
      citation_rate: rate(cited, answered.length),
    }
  })
}

function competitorsNamed(row: ResultAnswer): string[] {
  return row.matches
    .filter((m) => !m.own && (m.mentioned || m.cited))
    .map((m) => m.name)
}

export function promptShares(rows: ResultAnswer[]): AiPromptShare[] {
  const byPrompt = new Map<string, AiPromptShare>()
  for (const row of rows) {
    const share = byPrompt.get(row.prompt_id) ?? {
      prompt_id: row.prompt_id,
      prompt: row.prompt,
      branded: row.branded,
      answered: 0,
      mentioned: 0,
      cited: 0,
      engines_mentioning: [],
      competitors_named: [],
    }
    if (isAnswered(row)) {
      share.answered++
      if (row.brand_mentioned) {
        share.mentioned++
        share.engines_mentioning.push(row.engine)
      }
      if (row.brand_cited) share.cited++
      for (const name of competitorsNamed(row))
        if (!share.competitors_named.includes(name))
          share.competitors_named.push(name)
    }
    byPrompt.set(row.prompt_id, share)
  }
  return [...byPrompt.values()]
}

/** Prompts where a competitor shows up and the brand never does. */
export function gapPrompts(shares: AiPromptShare[]): AiPromptShare[] {
  return shares.filter(
    (s) =>
      s.answered > 0 &&
      s.mentioned === 0 &&
      s.cited === 0 &&
      s.competitors_named.length > 0,
  )
}

/** The brand and each competitor over the answered answers in scope, the brand first. */
export function brandSummaries(
  rows: ResultAnswer[],
  brands: AiRunBrand[],
): AiBrandSummary[] {
  const answered = rows.filter(isAnswered)
  const summaries = brands.map((brand) => {
    let mentions = 0
    let citations = 0
    let positionTotal = 0
    let positionCount = 0
    for (const row of answered) {
      const match = row.matches.find((m) => m.domain === brand.domain)
      if (!match) continue
      if (match.mentioned) mentions++
      if (match.cited) citations++
      if (match.position !== null) {
        positionTotal += match.position
        positionCount++
      }
    }
    return {
      name: brand.name,
      domain: brand.domain,
      own: brand.own,
      answers: answered.length,
      mentions,
      citations,
      mention_rate: rate(mentions, answered.length),
      citation_rate: rate(citations, answered.length),
      average_position: positionCount
        ? Math.round((positionTotal / positionCount) * 10) / 10
        : null,
    }
  })
  return summaries.sort(
    (a, b) =>
      Number(b.own) - Number(a.own) ||
      (b.mention_rate ?? -1) - (a.mention_rate ?? -1) ||
      a.name.localeCompare(b.name),
  )
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

/** One answer of a completed check, as seo_ai_trend_cells returns it. */
export interface TrendCell {
  run_id: string
  run_created_at: string
  location_code: number
  language_code: string
  own_domain: string
  prompt_id: string
  engine: AiEngine
  branded: boolean
  status: AiAnswerStatus
  has_answer: boolean
  brand_mentioned: boolean
  brand_cited: boolean
}

/** Below this share of planned answers collected in either period, no change is reported. */
export const TREND_MIN_COVERAGE = 0.9
const DAY_MS = 86_400_000

interface Tally {
  answers: number
  mentions: number
  citations: number
}
interface Cell extends Tally {
  engine: AiEngine
}
type Cells = Map<string, Cell>
type Rate = (tally: Tally) => number | null

const mentionRate: Rate = (c) =>
  c.answers ? (c.mentions / c.answers) * 100 : null
const citationRate: Rate = (c) =>
  c.answers ? (c.citations / c.answers) * 100 : null
const round1 = (value: number | null) =>
  value === null ? null : Math.round(value * 10) / 10

function emptyCoverage(): AiTrendCoverage {
  return { runs: 0, expected: 0, answered: 0, no_answer: 0, failed: 0 }
}

function addCoverage(coverage: AiTrendCoverage, rows: TrendCell[]) {
  coverage.runs++
  for (const row of rows) {
    coverage.expected++
    if (isAnswered(row)) coverage.answered++
    else if (row.status === 'collected') coverage.no_answer++
    else coverage.failed++
  }
}

/** Adds answered rows only: failed or empty collections never count as absent. */
function addAnswer(tally: Tally, row: TrendCell) {
  if (!isAnswered(row)) return
  tally.answers++
  if (row.brand_mentioned) tally.mentions++
  if (row.brand_cited) tally.citations++
}

function cellKey(row: TrendCell): string {
  return [
    row.prompt_id,
    row.engine,
    row.location_code,
    row.language_code,
    row.own_domain,
  ].join('|')
}

function rates(cells: Cells, rateOf: Rate) {
  const out = new Map<string, number>()
  for (const [key, cell] of cells) {
    const value = rateOf(cell)
    if (value !== null) out.set(key, value)
  }
  return out
}

const mean = (values: number[]) =>
  values.length ? values.reduce((t, v) => t + v, 0) / values.length : null

function metric(current: Cells, previous: Cells, rateOf: Rate): AiTrendMetric {
  const now = rates(current, rateOf)
  const before = rates(previous, rateOf)
  const matched = [...now.keys()].filter((key) => before.has(key))
  // Without matched cells there is no comparison, so current covers every cell.
  const currentValue = matched.length
    ? mean(matched.map((key) => now.get(key) ?? 0))
    : mean([...now.values()])
  const previousValue = mean(matched.map((key) => before.get(key) ?? 0))
  return {
    current: round1(currentValue),
    previous: round1(previousValue),
    change:
      currentValue !== null && previousValue !== null
        ? round1(currentValue - previousValue)
        : null,
    matched_cells: matched.length,
    current_cells: now.size,
    previous_cells: before.size,
  }
}

function matchedKeys(current: Cells, previous: Cells, rateOf: Rate) {
  const before = rates(previous, rateOf)
  return new Set(
    [...rates(current, rateOf).keys()].filter((k) => before.has(k)),
  )
}

const complete = (part: number, total: number) =>
  total > 0 && part / total >= TREND_MIN_COVERAGE

function comparison(
  current: AiTrendCoverage,
  previous: AiTrendCoverage,
  matchedCells: number,
): AiTrendComparison {
  if (!current.runs) return 'no_data'
  if (!previous.runs) return 'no_previous'
  if (!matchedCells) return 'scope_changed'
  return complete(current.answered, current.expected) &&
    complete(previous.answered, previous.expected)
    ? 'comparable'
    : 'incomplete'
}

/** A check's rate over the matched cells, or over every cell when none match. */
function runRate(
  rows: Array<{ key: string; row: TrendCell }>,
  matched: Set<string>,
  rateOf: Rate,
) {
  const tally: Tally = { answers: 0, mentions: 0, citations: 0 }
  for (const { key, row } of rows)
    if (!matched.size || matched.has(key)) addAnswer(tally, row)
  return round1(rateOf(tally))
}

/** The trend of a tracker's neutral prompts over the latest `days` against the `days` before. */
export function computeTrend(
  cells: TrendCell[],
  days: number,
  now: Date,
): AiTrend {
  const end = now.getTime()
  const splitMs = end - days * DAY_MS
  const startMs = end - 2 * days * DAY_MS
  const split = new Date(splitMs).toISOString()
  const start = new Date(startMs).toISOString()
  // Postgres writes "+00:00", JS "Z": compare instants, never strings.
  const at = (value: string) => Date.parse(value)
  const byRun = new Map<string, TrendCell[]>()
  for (const cell of cells) {
    if (at(cell.run_created_at) < startMs) continue
    const list = byRun.get(cell.run_id) ?? []
    list.push(cell)
    byRun.set(cell.run_id, list)
  }
  const periods = {
    current: { cells: new Map() as Cells, coverage: emptyCoverage() },
    previous: { cells: new Map() as Cells, coverage: emptyCoverage() },
  }
  const runRows = [...byRun.values()]
    .sort((a, b) => at(a[0].run_created_at) - at(b[0].run_created_at))
    .map((all) => {
      const first = all[0]
      const period =
        at(first.run_created_at) > splitMs ? periods.current : periods.previous
      // Prompts that name the brand would always mention it.
      const rows = all.filter((row) => !row.branded)
      const coverage = emptyCoverage()
      addCoverage(coverage, rows)
      addCoverage(period.coverage, rows)
      const keyed = rows.map((row) => ({ key: cellKey(row), row }))
      for (const { key, row } of keyed) {
        const cell = period.cells.get(key) ?? {
          engine: row.engine,
          answers: 0,
          mentions: 0,
          citations: 0,
        }
        addAnswer(cell, row)
        period.cells.set(key, cell)
      }
      return {
        runId: first.run_id,
        createdAt: first.run_created_at,
        coverage,
        keyed,
      }
    })
  const { current, previous } = periods
  const mentions = metric(current.cells, previous.cells, mentionRate)
  const citations = metric(current.cells, previous.cells, citationRate)
  const status = comparison(
    current.coverage,
    previous.coverage,
    Math.max(mentions.matched_cells, citations.matched_cells),
  )
  // Rates stay visible in every state; only a fair comparison shows a change.
  const shown = (value: AiTrendMetric): AiTrendMetric => ({
    ...value,
    change: status === 'comparable' ? value.change : null,
  })
  const engines = new Set(
    [...current.cells.values(), ...previous.cells.values()].map(
      (cell) => cell.engine,
    ),
  )
  const matched = {
    mention: matchedKeys(current.cells, previous.cells, mentionRate),
    citation: matchedKeys(current.cells, previous.cells, citationRate),
  }
  const only = (cellsIn: Cells, engine: AiEngine): Cells =>
    new Map([...cellsIn].filter(([, cell]) => cell.engine === engine))
  return {
    days,
    comparison: status,
    current: {
      start: split,
      end: new Date(end).toISOString(),
      coverage: current.coverage,
    },
    previous: { start, end: split, coverage: previous.coverage },
    mentions: shown(mentions),
    citations: shown(citations),
    engines: ALL_AI_ENGINES.filter((engine) => engines.has(engine)).map(
      (engine) => ({
        engine,
        mentions: shown(
          metric(
            only(current.cells, engine),
            only(previous.cells, engine),
            mentionRate,
          ),
        ),
        citations: shown(
          metric(
            only(current.cells, engine),
            only(previous.cells, engine),
            citationRate,
          ),
        ),
      }),
    ),
    runs: runRows.map(({ runId, createdAt, coverage, keyed }) => ({
      run_id: runId,
      created_at: createdAt,
      mention_rate: runRate(keyed, matched.mention, mentionRate),
      citation_rate: runRate(keyed, matched.citation, citationRate),
      coverage,
    })),
  }
}
