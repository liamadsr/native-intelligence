/**
 * Read `supabase/migrations/` as TEXT, and find the LATEST definition of a SQL
 * function across the whole directory.
 *
 * Why this exists. A handful of properties in this codebase live only in
 * Postgres and cannot be asserted by executing anything from vitest: the
 * `claim_source.source_type` CHECK list, `claim_neighborhood`'s label CASE, and
 * the requester-identity guard on the visibility-aware search RPCs. The repo
 * idiom for those is to read the migration file as a string and assert on what
 * it must contain (entity-registry.test.ts pioneered it).
 *
 * That idiom has one sharp edge, and this module is the answer to it. Functions
 * here are redefined WHOLESALE — the body always travels with the change — so
 * `claim_neighborhood` has been defined in 117, 121, 125, 223, 264, 267 and 275.
 * A test that reads ONE hardcoded migration stops guarding the moment a newer
 * migration redefines the function, and it stops silently: the old file still
 * contains the old string, so the assertion still passes while the live
 * function no longer has the property. Pinning a filename therefore tests
 * history, not production.
 *
 * `latestDefinition()` resolves the definition the database would actually end
 * up with — the newest migration that defines the function — so the guard
 * follows the function forward instead of rotting in place.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations')

export interface MigrationFile {
  file: string
  /** Leading integer of the filename. Not unique — see `migrationsInOrder`. */
  num: number
  sql: string
}

/**
 * Every migration, ordered oldest → newest.
 *
 * Migration numbers in this repo are NOT unique (258, 263, 270 each appear
 * twice, from parallel branches that landed together), so the filename breaks
 * ties. That ordering is arbitrary but stable, which is all a "latest wins"
 * lookup needs — and no duplicate-numbered pair defines the same function.
 */
export function migrationsInOrder(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((file) => ({
      file,
      num: Number.parseInt(file.split('_')[0] ?? '', 10),
      sql: readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'),
    }))
    .filter((m) => Number.isFinite(m.num))
    .sort((a, b) => a.num - b.num || a.file.localeCompare(b.file))
}

/**
 * Every `CREATE OR REPLACE FUNCTION public.<fn>(...)` statement in one file.
 *
 * Returns a list because a single migration may define several OVERLOADS of the
 * same name — 223 defines three `match_claims` (7-, 8- and 10-arg plus the
 * requester) and a property that holds for one must hold for all of them.
 *
 * Each returned block runs from the CREATE through the statement's terminating
 * semicolon, NOT merely to the closing dollar quote. The volatility and
 * security clauses may sit on either side of the body —
 * `AS $$ ... $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = ...;` is the
 * dominant form here — so a block cut at `$$` would drop `SECURITY DEFINER`
 * from exactly the functions whose security posture is worth asserting.
 */
export function definitionsIn(sql: string, fn: string): string[] {
  const needle = `CREATE OR REPLACE FUNCTION public.${fn}(`
  const out: string[] = []
  let from = 0
  for (;;) {
    const start = sql.indexOf(needle, from)
    if (start === -1) break
    const open = sql.indexOf('$$', start)
    const close = open === -1 ? -1 : sql.indexOf('$$', open + 2)
    if (close === -1) {
      // Unterminated body — hand back the remainder so a caller asserting on it
      // fails loudly rather than skipping a malformed migration in silence.
      out.push(sql.slice(start))
      break
    }
    const semi = sql.indexOf(';', close + 2)
    const end = semi === -1 ? sql.length : semi + 1
    out.push(sql.slice(start, end))
    from = end
  }
  return out
}

export interface LatestDefinition {
  /** The defining migration's filename, or `'(none)'` when nothing defines it. */
  file: string
  /** Every overload in that file. Empty when nothing defines the function. */
  blocks: string[]
}

/**
 * The newest migration that defines `fn`, with all of that file's overloads.
 *
 * Returns an EMPTY result instead of throwing when no migration defines `fn`.
 * Callers use this at module scope to build `describe` blocks, and a throw there
 * aborts collection for the whole file — which vitest reports as "no tests",
 * hiding which guarantee was actually lost. An empty result lets each `it` fail
 * with its own message. Callers MUST therefore assert `blocks.length` rather
 * than only iterating, or an empty result passes vacuously.
 */
export function latestDefinition(fn: string, files?: MigrationFile[]): LatestDefinition {
  const all = files ?? migrationsInOrder()
  for (let i = all.length - 1; i >= 0; i--) {
    const blocks = definitionsIn(all[i].sql, fn)
    if (blocks.length > 0) return { file: all[i].file, blocks }
  }
  return { file: '(none)', blocks: [] }
}
