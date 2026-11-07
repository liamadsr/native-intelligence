/**
 * Which skill a `load_skill` argument names (tools/workspace_tools.ts), in
 * order, case-insensitively:
 *   1. the exact name;
 *   2. the same name with spaces, hyphens, underscores and other punctuation
 *      ignored, so "my to-do list" finds `my-todo-list` and "Overdue work"
 *      finds `overdue-work`;
 *   3. `<x>-playbook`, so `load_skill('actions')` stays the Actions pack even
 *      when recipes such as `overdue-work` or `actions-weekly` exist;
 *   4. the one name containing it (the model may echo a display name).
 * Two or more names containing it is ambiguous: the caller lists them.
 */

export interface NamedSkill {
  name: string
}

export type SkillMatch<T extends NamedSkill> =
  | { kind: 'match'; skill: T }
  | { kind: 'ambiguous'; names: string[] }
  | { kind: 'none' }

/**
 * A name reduced to its letters and digits, lowercased. A name with none (an
 * emoji alone) keeps its trimmed lowercase form, so it still matches itself.
 */
function nameKey(name: string): string {
  const lower = name.trim().toLowerCase()
  const key = lower.replace(/[^\p{L}\p{N}]+/gu, '')
  return key || lower
}

export function matchSkill<T extends NamedSkill>(skills: readonly T[], requested: string): SkillMatch<T> {
  const wanted = requested.trim().toLowerCase()
  if (!wanted) return { kind: 'none' }
  const exact = skills.find((s) => s.name.toLowerCase() === wanted)
  if (exact) return { kind: 'match', skill: exact }
  const key = nameKey(wanted)
  const loose = skills.filter((s) => nameKey(s.name) === key)
  if (loose.length === 1) return { kind: 'match', skill: loose[0] }
  if (loose.length > 1) return { kind: 'ambiguous', names: loose.map((s) => s.name) }
  const playbook = skills.find((s) => nameKey(s.name) === `${key}playbook`)
  if (playbook) return { kind: 'match', skill: playbook }
  const partial = skills.filter((s) => nameKey(s.name).includes(key))
  if (partial.length === 1) return { kind: 'match', skill: partial[0] }
  if (partial.length > 1) return { kind: 'ambiguous', names: partial.map((s) => s.name) }
  return { kind: 'none' }
}

/** The most skill names an unknown-skill error lists. */
export const MAX_LISTED_SKILLS = 40

/**
 * The names an unknown-skill error offers: the first {@link MAX_LISTED_SKILLS}
 * (in the advertised order) and how many more there are, so a workspace with a
 * hundred skills doesn't flood the result.
 */
export function listedSkillNames(skills: readonly NamedSkill[]): { available: string[]; more?: number } {
  const available = skills.slice(0, MAX_LISTED_SKILLS).map((s) => s.name)
  const more = skills.length - available.length
  return more > 0 ? { available, more } : { available }
}
