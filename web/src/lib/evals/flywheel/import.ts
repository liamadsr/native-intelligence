/**
 * Importing an export (GET /api/admin/evals/export) into
 * src/lib/packs/skill-evals/cases/flywheel.json: scripts/eval-flywheel-import.ts
 * reads the files, this decides what changes. Pure.
 *
 * Every entry is checked with flywheelCaseSchema; one bad entry stops the
 * import (nothing is written). A candidate already in the file, or twice in
 * the export, is skipped. The file is kept in one stable order (by skill, then
 * promotedAt, then candidateId), so an import only adds lines.
 */
import { flywheelCaseSchema, formatIssues, type TypedFlywheelCase } from './case-schema'

export interface FlywheelImportResult {
  /** The file's cases after the import, in file order. */
  cases: TypedFlywheelCase[]
  added: TypedFlywheelCase[]
  skipped: Array<{ candidateId: string; skill: string; why: 'already in flywheel.json' | 'twice in the export' }>
}

export type FlywheelImportOutcome = ({ ok: true } & FlywheelImportResult) | { ok: false; errors: string[] }

function parseList(input: unknown, label: string): { cases: TypedFlywheelCase[]; errors: string[] } {
  if (!Array.isArray(input)) return { cases: [], errors: [`${label}: not a JSON array of cases`] }
  const cases: TypedFlywheelCase[] = []
  const errors: string[] = []
  input.forEach((entry, i) => {
    const parsed = flywheelCaseSchema.safeParse(entry)
    if (parsed.success) cases.push(parsed.data)
    else {
      const id = entry && typeof entry === 'object' && typeof (entry as { candidateId?: unknown }).candidateId === 'string' ? ` (${(entry as { candidateId: string }).candidateId})` : ''
      errors.push(`${label}[${i}]${id}: ${formatIssues(parsed.error)}`)
    }
  })
  return { cases, errors }
}

/** The file's order: by skill, then promotedAt, then candidateId. */
export function compareFlywheelCases(a: TypedFlywheelCase, b: TypedFlywheelCase): number {
  if (a.skill !== b.skill) return a.skill < b.skill ? -1 : 1
  const ta = Date.parse(a.promotedAt)
  const tb = Date.parse(b.promotedAt)
  if (ta !== tb) return ta - tb
  return a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0
}

/** Merge an export into the file's current cases. */
export function mergeFlywheelExport(existing: unknown, incoming: unknown): FlywheelImportOutcome {
  const current = parseList(existing, 'flywheel.json')
  const exported = parseList(incoming, 'export')
  const errors = [...current.errors, ...exported.errors]
  if (errors.length > 0) return { ok: false, errors }

  const seen = new Set(current.cases.map((c) => c.candidateId))
  const added: TypedFlywheelCase[] = []
  const skipped: FlywheelImportResult['skipped'] = []
  for (const c of exported.cases) {
    if (seen.has(c.candidateId)) {
      const twice = added.some((a) => a.candidateId === c.candidateId)
      skipped.push({ candidateId: c.candidateId, skill: c.skill, why: twice ? 'twice in the export' : 'already in flywheel.json' })
      continue
    }
    seen.add(c.candidateId)
    added.push(c)
  }
  const cases = [...current.cases, ...added].sort(compareFlywheelCases)
  return { ok: true, cases, added: [...added].sort(compareFlywheelCases), skipped }
}

/** The file's text: two-space JSON and a final newline. */
export function serializeFlywheelCases(cases: readonly TypedFlywheelCase[]): string {
  return `${JSON.stringify(cases, null, 2)}\n`
}
