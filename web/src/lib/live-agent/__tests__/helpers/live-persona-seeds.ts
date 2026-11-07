/**
 * The seeded live personas' text, read straight from the SQL, so tests check
 * what ships:
 *   - personaBody(file, slug): a persona's prompt as a migration writes it
 *     (the dollar-quoted body whose UPDATE names the slug);
 *   - migration358Blocks(): 358's DO blocks, each declaring its text once in
 *     a variable used by the SET and the IS DISTINCT FROM guard;
 *   - migration358() / migration358Descriptions(): the system_prompt blocks
 *     and the description block (interactive's);
 *   - livePersona(slug): what the row reads after 358 (274's text, then
 *     quiet), read from 358 itself.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function readMigration(file: string): string {
  return readFileSync(join(process.cwd(), 'supabase', 'migrations', file), 'utf8')
}

/** A persona's dollar-quoted body (tag `prompt` by default) in the UPDATE that names `slug`. */
export function personaBody(file: string, slug: string, tag = 'prompt'): string {
  const blocks = readMigration(file).split(`$${tag}$`)
  for (let i = 1; i < blocks.length; i += 2) {
    const where = (blocks[i + 1] ?? '').split(';')[0]
    if (where.includes(`slug = '${slug}'`)) return blocks[i]
  }
  throw new Error(`no $${tag}$ body for slug '${slug}' in ${file}`)
}

export const MIGRATION_358 = '358_quiet_sidekick.sql'
export const PERSONA_SLUGS = ['interactive', 'sales-live', 'sales-post-call'] as const
export type PersonaSlug = (typeof PERSONA_SLUGS)[number]

/**
 * One of 358's DO blocks: it declares the text once in a variable and uses
 * that variable in the SET and in the IS DISTINCT FROM guard.
 */
export interface Block358 {
  slug: string
  column: 'system_prompt' | 'description'
  /** The declared variable (v_prompt / v_description). */
  variable: string
  /** The text the variable holds. */
  text: string
  /** The value the SET assigns (must be the variable). */
  setValue: string
  /** The value the IS DISTINCT FROM guard compares with (must be the variable). */
  guard: string
  /** The SET list, whitespace squeezed. */
  set: string
  /** The WHERE clause, whitespace squeezed. */
  where: string
}
/** Kept for readers of the system_prompt blocks. */
export type PersonaSet = Block358
export type DescriptionSet = Block358

const BLOCK_RE =
  /DO \$quiet\$\nDECLARE\n {2}(v_[a-z]+) text := \$(prompt|desc)\$([\s\S]*?)\$\2\$;\nBEGIN\n {2}UPDATE public\.recipe\n {2}(SET (system_prompt|description) = (v_[a-z]+),\s*updated_at = now\(\))\n {2}(WHERE slug = '([a-z-]+)'[\s\S]*?IS DISTINCT FROM (v_[a-z]+));\nEND\n\$quiet\$;/g

export function migration358Blocks(): Block358[] {
  return [...readMigration(MIGRATION_358).matchAll(BLOCK_RE)].map((m) => ({
    variable: m[1],
    text: m[3],
    set: m[4].replace(/\s+/g, ' '),
    column: m[5] as Block358['column'],
    setValue: m[6],
    where: m[7].replace(/\s+/g, ' '),
    slug: m[8],
    guard: m[9],
  }))
}

/** 358's system_prompt blocks, in file order. */
export function migration358(): PersonaSet[] {
  return migration358Blocks().filter((b) => b.column === 'system_prompt')
}

/** 358's description blocks (interactive's). */
export function migration358Descriptions(): DescriptionSet[] {
  return migration358Blocks().filter((b) => b.column === 'description')
}

/** What a seeded persona's row reads after 358. */
export function livePersona(slug: PersonaSlug): string {
  const stmt = migration358().find((s) => s.slug === slug)
  if (!stmt) throw new Error(`358 sets no system_prompt for '${slug}'`)
  return stmt.text
}

/** Apply literal [from, to] swaps in order, each expected exactly once. */
export function applySwaps(text: string, swaps: ReadonlyArray<readonly [string, string]>): string {
  return swaps.reduce((t, [from, to]) => {
    const n = t.split(from).length - 1
    if (n !== 1) throw new Error(`swap source found ${n} times: ${from.slice(0, 60)}`)
    return t.replace(from, () => to)
  }, text)
}
