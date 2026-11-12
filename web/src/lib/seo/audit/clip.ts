/**
 * How much of the audited site's own text a stored row may hold. A finding's
 * details can quote a page (its robots meta, a canonical, a title), and a
 * page's author decides how long that is: every string is cut, every list is
 * shortened, at every depth, where the issue row is built.
 *
 * Strings are cut by characters (code points), so a character outside the
 * basic plane (an emoji, a surrogate pair in UTF-16) is never cut in half.
 */
import { MAX_URL_CHARS } from './limits'

/** Most characters of site text kept in one detail field. */
export const DETAIL_TEXT_CHARS = 300
/** Most entries kept from one list in the details. */
export const DETAIL_LIST_ITEMS = 50
/** Objects nested deeper than this are dropped: no finding needs them. */
const DETAIL_MAX_DEPTH = 4

/** `value` cut to at most `max` characters, never inside a surrogate pair. */
export function clipText(value: string, max: number): string {
  // Fewer UTF-16 units than `max` means fewer characters too.
  if (value.length <= max) return value
  let units = 0
  let chars = 0
  while (units < value.length && chars < max) {
    const code = value.charCodeAt(units)
    const pair =
      code >= 0xd800 &&
      code <= 0xdbff &&
      units + 1 < value.length &&
      (value.charCodeAt(units + 1) & 0xfc00) === 0xdc00
    units += pair ? 2 : 1
    chars += 1
  }
  return value.slice(0, units)
}

function clipValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return clipText(
      value,
      /^https?:\/\//i.test(value) ? MAX_URL_CHARS : DETAIL_TEXT_CHARS,
    )
  }
  if (Array.isArray(value)) {
    if (depth >= DETAIL_MAX_DEPTH) return []
    return value
      .slice(0, DETAIL_LIST_ITEMS)
      .map((item) => clipValue(item, depth + 1))
  }
  if (value && typeof value === 'object') {
    if (depth >= DETAIL_MAX_DEPTH) return {}
    return clipDetails(value as Record<string, unknown>, depth + 1)
  }
  return value
}

/** A finding's details, every string and list held to the bounds above. */
export function clipDetails(
  details: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let fields = 0
  for (const [key, value] of Object.entries(details)) {
    // Keys are ours, but the bound costs nothing.
    if (fields++ >= DETAIL_LIST_ITEMS) break
    out[clipText(key, DETAIL_TEXT_CHARS)] = clipValue(value, depth)
  }
  return out
}
