/**
 * What a value looks like in a format code, asked of the engine itself on a
 * scratch workbook (so the preview is exactly what the cell will show). The
 * engine must already be loaded: the editor's, or the server's.
 */
import { Model } from '@ironcalc/wasm'

let scratch: Model | null = null

/** 9 March 2026, 6:00 PM as a serial number: the sample a date format is previewed with. */
export const SAMPLE_DATE = '46090.75'

/** The text the engine draws `value` as under `code`, or null when the code is not one it can draw. */
export function previewFormat(code: string, value: string): string | null {
  if (!code.trim()) return null
  try {
    scratch ??= new Model('preview', 'en', 'UTC', 'en')
    scratch.setUserInput(0, 1, 1, value)
    scratch.updateRangeStyle({ sheet: 0, row: 1, column: 1, width: 1, height: 1 }, 'num_fmt', code)
    const shown = scratch.getFormattedCellValue(0, 1, 1)
    return shown.startsWith('#') ? null : shown
  } catch {
    return null
  }
}
