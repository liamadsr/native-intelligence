/**
 * Goal Seek: change one input cell until a formula cell reaches a value. A
 * pure search over an engine Model — always a throwaway COPY, never the open
 * workbook, since it writes the input cell many times to probe it.
 *
 * It evaluates the formula cell through a scratch sheet (a plain General cell
 * referencing it), so the number it reads back carries no currency or date
 * formatting. A bracketing search (a secant step, then bisection when the
 * secant wanders) finds a root of f(x) = formula(x) - target.
 */
import type { Model } from '@ironcalc/wasm'
import { cellName, quoteSheetName } from './a1'
import { CELL_TYPE, listSheets } from './workbook'

export interface GoalSeekRequest {
  /** The formula cell to drive to a value. */
  setSheet: number
  setRow: number
  setColumn: number
  /** The input cell to change. */
  changeSheet: number
  changeRow: number
  changeColumn: number
  target: number
  maxIterations?: number
  tolerance?: number
}

export type GoalSeekResult =
  | { ok: true; input: number; result: number; iterations: number }
  | { ok: false; reason: 'same-cell' | 'not-numeric' | 'no-solution'; message: string }

const DEFAULT_MAX_ITERATIONS = 100

function toNumber(text: string): number {
  const cleaned = text.replace(/[^0-9.eE+-]/g, '')
  return cleaned === '' ? NaN : Number(cleaned)
}

/**
 * Find the input value. The Model is mutated (a scratch sheet is added and the
 * input cell is written repeatedly), so pass a copy you can throw away.
 */
export function goalSeek(model: Model, request: GoalSeekRequest): GoalSeekResult {
  const { setSheet, setRow, setColumn, changeSheet, changeRow, changeColumn, target } = request
  const maxIterations = Math.max(10, request.maxIterations ?? DEFAULT_MAX_ITERATIONS)
  const tolerance = request.tolerance ?? Math.max(1e-7, Math.abs(target) * 1e-9)

  if (setSheet === changeSheet && setRow === changeRow && setColumn === changeColumn) {
    return { ok: false, reason: 'same-cell', message: 'The cell to change must be a different cell from the one being set.' }
  }

  const sheets = listSheets(model)
  const setSheetName = sheets[setSheet]?.name
  if (!setSheetName) return { ok: false, reason: 'not-numeric', message: 'That sheet is gone.' }

  // A scratch sheet reads the set cell in General format, so the value has no formatting on it.
  model.newSheet()
  const scratch = listSheets(model).length - 1
  model.setUserInput(scratch, 1, 1, `=${quoteSheetName(setSheetName)}!${cellName(setRow, setColumn)}`)

  let iterations = 0
  const evalAt = (x: number): number => {
    iterations += 1
    model.setUserInput(changeSheet, changeRow, changeColumn, String(x))
    model.evaluate()
    // Only a genuine number counts; text or an error reads as NaN (so a non-numeric set cell is caught).
    if (model.getCellType(scratch, 1, 1) !== CELL_TYPE.number) return NaN
    return toNumber(model.getFormattedCellValue(scratch, 1, 1))
  }

  const start = toNumber(model.getCellContent(changeSheet, changeRow, changeColumn))
  const x0 = Number.isFinite(start) ? start : 0

  const f0 = evalAt(x0)
  if (!Number.isFinite(f0)) {
    return { ok: false, reason: 'not-numeric', message: 'The cell to set does not work out to a number.' }
  }
  if (Math.abs(f0 - target) <= tolerance) return { ok: true, input: x0, result: f0, iterations }

  const solved = (x: number, result: number): GoalSeekResult => ({ ok: true, input: x, result, iterations })

  // Secant iteration from two nearby points.
  let a = x0
  let fa = f0 - target
  let b = x0 + (Math.abs(x0) > 1 ? Math.abs(x0) * 0.01 : 1)
  let fb = evalAt(b) - target
  for (let i = 0; i < maxIterations; i++) {
    if (Number.isFinite(fb) && Math.abs(fb) <= tolerance) return solved(b, fb + target)
    if (!Number.isFinite(fb) || !Number.isFinite(fa) || fb === fa) break
    const next = b - fb * (b - a) / (fb - fa)
    if (!Number.isFinite(next) || Math.abs(next) > 1e15) break
    a = b
    fa = fb
    b = next
    fb = evalAt(b) - target
  }

  // Fall back to a bracketing search: scan outward for a sign change, then bisect.
  const bracket = findBracket(evalAt, target, x0)
  if (!bracket) {
    return { ok: false, reason: 'no-solution', message: `No value within ${iterations} tries makes that cell reach ${target}.` }
  }
  let [lo, hi] = bracket
  let flo = evalAt(lo) - target
  for (let i = 0; i < maxIterations; i++) {
    const mid = (lo + hi) / 2
    const fmid = evalAt(mid) - target
    if (!Number.isFinite(fmid)) break
    if (Math.abs(fmid) <= tolerance || (hi - lo) / 2 <= tolerance) return solved(mid, fmid + target)
    if (Math.sign(fmid) === Math.sign(flo)) {
      lo = mid
      flo = fmid
    } else {
      hi = mid
    }
  }
  return { ok: false, reason: 'no-solution', message: `No value within ${iterations} tries makes that cell reach ${target}.` }
}

/** Scan outward from a start point for two inputs whose f straddles zero. */
function findBracket(evalAt: (x: number) => number, target: number, x0: number): [number, number] | null {
  const scale = Math.abs(x0) > 1 ? Math.abs(x0) : 1
  let prevX = x0
  let prevF = evalAt(x0) - target
  // Widen the step each round, probing both sides of the start.
  for (let i = 1; i <= 60; i++) {
    const step = scale * i * i * 0.5
    for (const x of [x0 + step, x0 - step]) {
      const f = evalAt(x) - target
      if (!Number.isFinite(f)) continue
      if (Number.isFinite(prevF) && Math.sign(f) !== Math.sign(prevF) && f !== 0 && prevF !== 0) {
        return prevX < x ? [prevX, x] : [x, prevX]
      }
      if (f === 0) return [x, x]
      prevX = x
      prevF = f
    }
  }
  return null
}
