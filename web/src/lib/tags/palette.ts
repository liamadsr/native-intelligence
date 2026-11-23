/**
 * The colors a tag can take: one palette for Settings › Tags and the `#` menu's
 * create step. Hex, `#rrggbb` (migration 700's guard refuses anything else).
 */
export const TAG_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
  '#6366f1', '#8b5cf6', '#a855f7', '#ec4899', '#f43f5e', '#6b7280', '#78716c', '#0ea5e9',
] as const

/** The default for an old label (020's column default). */
export const TAG_DEFAULT_COLOR = '#6b7280'

const HEX_RE = /^#[0-9a-f]{6}$/i

export function isTagColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_RE.test(value)
}

/**
 * A color for a new tag: the first palette color no existing tag uses (grey
 * last), else one picked by the name so the same name gets the same color.
 */
export function nextTagColor(name: string, used: readonly string[]): string {
  const taken = new Set(used.map((c) => c.toLowerCase()))
  const free = TAG_COLORS.filter((c) => c !== TAG_DEFAULT_COLOR && !taken.has(c))
  if (free.length > 0) return free[0]
  let h = 0
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return TAG_COLORS[h % TAG_COLORS.length]
}
