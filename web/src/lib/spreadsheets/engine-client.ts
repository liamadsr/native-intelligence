/**
 * The spreadsheet engine in the browser. The binary comes from the app's own
 * route (one fetch, cached), not from a bundler's asset pipeline, so the
 * editor loads the same way in development and in production.
 */
import init, { Model } from '@ironcalc/wasm'
import { base64ToBytes } from './workbook'

export const ENGINE_URL = '/api/account/spreadsheets/engine'

let loading: Promise<void> | null = null

export function loadEngine(): Promise<void> {
  if (!loading) {
    loading = init({ module_or_path: ENGINE_URL }).then(
      () => undefined,
      (error) => {
        // A failed load can be tried again.
        loading = null
        throw error
      },
    )
  }
  return loading
}

export async function openModel(workbook: string | null | undefined, name = 'Workbook'): Promise<Model> {
  await loadEngine()
  if (!workbook) return new Model(name, 'en', 'UTC', 'en')
  return Model.fromBytes(base64ToBytes(workbook), 'en')
}
