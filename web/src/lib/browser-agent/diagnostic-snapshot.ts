import { observationSchema, type BrowserObservation } from './task-contract'

/** Opt-in diagnostics use the same bounded observation as the decision runner,
 * never an unbounded DOM dump or a legacy text snapshot disguised as one. */
export function parseDiagnosticBrowserSnapshot(value: unknown): BrowserObservation {
  const parsed = observationSchema.safeParse(value)
  if (!parsed.success) throw new Error('Browser diagnostic snapshot unavailable: the browser did not return a valid normalized observation.')
  return parsed.data
}
