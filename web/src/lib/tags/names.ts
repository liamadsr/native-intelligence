/**
 * What a tag may be called. Mirrors migration 700's guard on `label.name`:
 * trimmed, 1–64 characters, no `#`, no comma, no line break.
 */
export const TAG_NAME_MAX = 64

/** The name as it will be stored, or null when nothing valid is left. */
export function normalizeTagName(raw: string): string | null {
  const name = raw.replace(/\s+/g, ' ').trim().replace(/^#+/, '').trim()
  if (!name || name.length > TAG_NAME_MAX || /[#,]/.test(name)) return null
  return name
}

/** Two names are the same tag when they match ignoring case. */
export function sameTagName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}
