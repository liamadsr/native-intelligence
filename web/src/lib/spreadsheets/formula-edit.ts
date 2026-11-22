/**
 * Typing a formula: where a click on the grid may drop a reference, and the
 * draft with that reference in it. Pure text work.
 */
import { cellName, quoteSheetName, type CellRange } from './a1'

export function isFormula(draft: string): boolean {
  return draft.startsWith('=')
}

/** A reference as a formula writes it, with the sheet when it is on another one. */
export function referenceText(range: CellRange, sheetName?: string | null): string {
  const a = cellName(range.r1, range.c1)
  const b = cellName(range.r2, range.c2)
  const cells = a === b ? a : `${a}:${b}`
  return sheetName ? `${quoteSheetName(sheetName)}!${cells}` : cells
}

/**
 * Is the caret where a reference goes? Right after `=`, an opening bracket,
 * a comma or an operator (spaces aside): then a click on the grid points at
 * a cell instead of ending the edit.
 */
export function expectsReference(draft: string, caret: number): boolean {
  if (!isFormula(draft)) return false
  const before = draft.slice(0, caret).replace(/\s+$/, '')
  if (!before) return false
  // Inside a text in quotes nothing is a reference.
  if ((before.match(/"/g) ?? []).length % 2 === 1) return false
  return /[=(,;+\-*/^&<>:]$/.test(before)
}

export interface PointedDraft {
  draft: string
  /** Where the inserted reference starts and ends, so the next click replaces it. */
  start: number
  end: number
}

/** Put a reference into the draft: over the last pointed one when there is one, else at the caret. */
export function insertReference(draft: string, caret: number, reference: string, replacing?: { start: number; end: number } | null): PointedDraft {
  const start = replacing ? replacing.start : caret
  const end = replacing ? replacing.end : caret
  const next = draft.slice(0, start) + reference + draft.slice(end)
  return { draft: next, start, end: start + reference.length }
}

/** The function name being typed at the caret (`=SU|` gives `SU`), or null. */
export function functionPrefix(draft: string, caret: number): { prefix: string; from: number } | null {
  if (!isFormula(draft)) return null
  const before = draft.slice(0, caret)
  if ((before.match(/"/g) ?? []).length % 2 === 1) return null
  const m = /(^|[=(,;+\-*/^&<>:\s])([A-Za-z][A-Za-z0-9.]*)$/.exec(before)
  if (!m) return null
  const prefix = m[2]
  // `A1` or `AB12` being typed is a cell, not a function.
  if (/^[A-Za-z]{1,3}[0-9]+$/.test(prefix)) return null
  const after = draft.slice(caret)
  if (/^[A-Za-z0-9.]/.test(after)) return null
  return { prefix, from: caret - prefix.length }
}

/** The function whose arguments the caret is inside (`=IF(A1, |` gives IF, argument 2), or null. */
export function enclosingFunction(draft: string, caret: number): { name: string; argument: number } | null {
  if (!isFormula(draft)) return null
  let depth = 0
  let argument = 1
  let quoted = false
  for (let i = Math.min(caret, draft.length) - 1; i >= 1; i--) {
    const ch = draft[i]
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (quoted) continue
    if (ch === ')') depth += 1
    else if (ch === '(') {
      if (depth > 0) {
        depth -= 1
        continue
      }
      const m = /([A-Za-z][A-Za-z0-9.]*)$/.exec(draft.slice(0, i))
      return m ? { name: m[1].toUpperCase(), argument } : null
    } else if ((ch === ',' || ch === ';') && depth === 0) argument += 1
  }
  return null
}
