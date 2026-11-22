/**
 * Turning a range's calculated values into what an SVG chart draws: series and
 * categories, axis ticks, pie angles. All pure, so the maths is tested without a
 * browser; the SVG components (components/spreadsheets/charts) only lay it out.
 */
import type { ChartType } from './extras'

/** One cell of the source range: the text it shows and, when it is a number, its value. */
export interface ChartCell {
  text: string
  value: number | null
}

export interface PreparedSeries {
  name: string
  color: string
  values: (number | null)[]
}

export interface ScatterSeries {
  name: string
  color: string
  points: { x: number; y: number }[]
}

export interface PreparedChart {
  /** False when the range holds no numbers: the view draws a quiet empty state. */
  ok: boolean
  categories: string[]
  series: PreparedSeries[]
  scatter: ScatterSeries[]
  /** The value extent across every series (for the axis). */
  min: number
  max: number
}

/** A fixed, accessible palette that reads on dark and light; series take colors in order. */
export const CHART_PALETTE: readonly string[] = [
  '#2563EB',
  '#16A34A',
  '#EA580C',
  '#9333EA',
  '#0891B2',
  '#DC2626',
  '#CA8A04',
  '#DB2777',
  '#4F46E5',
  '#65A30D',
]

export function seriesColor(index: number): string {
  return CHART_PALETTE[index % CHART_PALETTE.length]
}

function isNumber(cell: ChartCell | undefined): boolean {
  return !!cell && cell.value !== null && Number.isFinite(cell.value)
}

/** Whether a row of cells is text headings rather than numbers (the non-empty cells are mostly non-numeric). */
function looksLikeText(cells: ChartCell[]): boolean {
  const filled = cells.filter((c) => c && c.text.trim() !== '')
  if (!filled.length) return false
  const numeric = filled.filter((c) => c.value !== null).length
  return numeric < filled.length / 2
}

function columnLooksLikeText(grid: ChartCell[][], column: number, fromRow: number): boolean {
  const cells = grid.slice(fromRow).map((row) => row[column]).filter((c): c is ChartCell => !!c)
  return looksLikeText(cells)
}

/** Build the series and categories for a chart of `type` from a rectangle of cells. */
export function prepareChartData(grid: ChartCell[][], type: ChartType): PreparedChart {
  const rows = grid.length
  const cols = rows ? Math.max(...grid.map((r) => r.length)) : 0
  const empty: PreparedChart = { ok: false, categories: [], series: [], scatter: [], min: 0, max: 0 }
  if (!rows || !cols) return empty

  const at = (r: number, c: number): ChartCell => grid[r]?.[c] ?? { text: '', value: null }
  const hasHeader = looksLikeText(grid[0] ?? [])
  const bodyFrom = hasHeader ? 1 : 0
  const hasCategories = type !== 'scatter' && columnLooksLikeText(grid, 0, bodyFrom) && cols > 1
  const firstValueCol = hasCategories ? 1 : 0

  if (type === 'scatter') {
    // First numeric column is x; each later column is a y series.
    const xCol = 0
    const scatter: ScatterSeries[] = []
    for (let c = 1; c < cols; c++) {
      const name = hasHeader ? at(0, c).text || `Series ${c}` : `Series ${c}`
      const points: { x: number; y: number }[] = []
      for (let r = bodyFrom; r < rows; r++) {
        const x = at(r, xCol).value
        const y = at(r, c).value
        if (x !== null && y !== null && Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y })
      }
      if (points.length) scatter.push({ name, color: seriesColor(scatter.length), points })
    }
    const all = scatter.flatMap((s) => s.points.map((p) => p.y))
    if (!scatter.length) return empty
    return { ok: true, categories: [], series: [], scatter, min: Math.min(...all), max: Math.max(...all) }
  }

  const categories: string[] = []
  for (let r = bodyFrom; r < rows; r++) categories.push(hasCategories ? at(r, 0).text : String(r - bodyFrom + 1))

  const series: PreparedSeries[] = []
  for (let c = firstValueCol; c < cols; c++) {
    // Skip a column with no numbers at all (e.g. a stray text column).
    let anyNumber = false
    for (let r = bodyFrom; r < rows; r++) if (isNumber(grid[r]?.[c])) anyNumber = true
    if (!anyNumber) continue
    const name = hasHeader ? at(0, c).text || `Series ${series.length + 1}` : `Series ${series.length + 1}`
    const values: (number | null)[] = []
    for (let r = bodyFrom; r < rows; r++) {
      const cell = grid[r]?.[c]
      values.push(isNumber(cell) ? (cell!.value as number) : null)
    }
    series.push({ name, color: seriesColor(series.length), values })
  }

  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null))
  if (!all.length) return empty
  return { ok: true, categories, series, scatter: [], min: Math.min(...all), max: Math.max(...all) }
}

export interface Ticks {
  min: number
  max: number
  step: number
  ticks: number[]
}

/**
 * Round, evenly spaced axis bounds and ticks spanning [min, max], about `count`
 * of them. Zero is kept in range so bars sit on a sensible baseline.
 */
export function niceTicks(min: number, max: number, count = 5): Ticks {
  let lo = Math.min(min, 0)
  let hi = Math.max(max, 0)
  if (lo === hi) {
    // A flat series still needs a span to draw against.
    if (lo === 0) {
      lo = 0
      hi = 1
    } else {
      hi = lo + Math.abs(lo)
      lo = Math.min(0, lo)
    }
  }
  const span = niceNumber(hi - lo, false)
  const step = niceNumber(span / Math.max(1, count - 1), true)
  const niceMin = Math.floor(lo / step) * step
  const niceMax = Math.ceil(hi / step) * step
  const ticks: number[] = []
  // Guard against floating-point drift producing a runaway loop.
  for (let v = niceMin, i = 0; v <= niceMax + step / 2 && i < 1000; v += step, i++) {
    ticks.push(Number((Math.abs(v) < step / 1e6 ? 0 : v).toPrecision(12)))
  }
  return { min: niceMin, max: niceMax, step, ticks }
}

/** A "nice" number near `value`: 1, 2, 5 or 10 times a power of ten. */
function niceNumber(value: number, round: boolean): number {
  const exp = Math.floor(Math.log10(value || 1))
  const frac = value / 10 ** exp
  let nice: number
  if (round) nice = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10
  else nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10
  return nice * 10 ** exp
}

export interface PieSlice {
  value: number
  fraction: number
  /** Cumulative fractions around the circle, 0 to 1. */
  start: number
  end: number
}

/** Slices of a pie or doughnut: each value's share of the total (negatives use their magnitude). */
export function pieSlices(values: number[]): PieSlice[] {
  const magnitudes = values.map((v) => Math.abs(v))
  const total = magnitudes.reduce((a, b) => a + b, 0)
  if (total === 0) return []
  const slices: PieSlice[] = []
  let cursor = 0
  for (let i = 0; i < values.length; i++) {
    const fraction = magnitudes[i] / total
    slices.push({ value: values[i], fraction, start: cursor, end: cursor + fraction })
    cursor += fraction
  }
  return slices
}

/** A compact axis label: 1_250 → "1.25K", 2_000_000 → "2M". */
export function compactNumber(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e9) return `${trim(value / 1e9)}B`
  if (abs >= 1e6) return `${trim(value / 1e6)}M`
  if (abs >= 1e3) return `${trim(value / 1e3)}K`
  return trim(value)
}

function trim(value: number): string {
  return Number(value.toFixed(2)).toLocaleString('en-US')
}
