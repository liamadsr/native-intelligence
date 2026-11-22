/**
 * The spreadsheet engine on the server: routes, the agents' tools, import and
 * export. IronCalc (MIT or Apache-2.0), the same build the browser runs, so a
 * tool's edit and a person's edit follow one set of rules.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { initSync, Model } from '@ironcalc/wasm'
import { base64ToBytes } from './workbook'

let ready = false

/** Where the engine's binary is on disk. The browser fetches it through /api/account/spreadsheets/engine. */
export function engineBinaryPath(): string {
  // The app always runs from its own directory (next dev, next start, vitest), with node_modules beside it.
  return path.join(process.cwd(), 'node_modules', '@ironcalc', 'wasm', 'wasm_bg.wasm')
}

export function ensureEngine(): void {
  if (ready) return
  initSync({ module: readFileSync(engineBinaryPath()) })
  ready = true
}

/** An empty workbook with one sheet. Calculations read UTC, so two readers never differ. */
export function newModel(name = 'Workbook'): Model {
  ensureEngine()
  return new Model(name, 'en', 'UTC', 'en')
}

/** A saved workbook, or an empty one when nothing was saved yet. */
export function loadModel(workbook: string | null | undefined, name = 'Workbook'): Model {
  ensureEngine()
  if (!workbook) return newModel(name)
  return Model.fromBytes(base64ToBytes(workbook), 'en')
}
