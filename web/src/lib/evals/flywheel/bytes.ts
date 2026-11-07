/**
 * Text as Postgres sees it, for the evals flywheel's limits (migration 349).
 * Client-safe (no server imports): the case editor's check (case-schema.ts)
 * and the writer (record.ts) measure and cut the same way.
 *
 *   - jsonbTextBytes: a value's length as `jsonb::text` prints it, which is
 *     what the table's `octet_length` checks measure.
 *   - sliceStart / sliceEnd: a cut that never splits a surrogate pair. A lone
 *     surrogate is not valid UTF-8, so Postgres refuses the whole row.
 */

/**
 * The length of `value` as Postgres prints it (`jsonb::text`, what migration
 * 349's `octet_length` checks measure): `{"k": v, "k2": v2}`, `[a, b]`, in
 * UTF-8 bytes. JSON.stringify leaves out the spaces after `:` and `,`.
 */
export function jsonbTextBytes(value: unknown): number {
  const enc = new TextEncoder()
  const walk = (v: unknown): number => {
    if (v === null || v === undefined) return 4
    if (Array.isArray(v)) {
      if (v.length === 0) return 2
      return 2 + v.reduce<number>((n, item) => n + walk(item), 0) + (v.length - 1) * 2
    }
    if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
      if (entries.length === 0) return 2
      return 2 + entries.reduce((n, [k, x]) => n + enc.encode(JSON.stringify(k)).length + 2 + walk(x), 0) + (entries.length - 1) * 2
    }
    return enc.encode(JSON.stringify(v) ?? 'null').length
  }
  return walk(value)
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff

/** The first `max` UTF-16 units of `text`, one fewer when the cut would split a surrogate pair. */
export function sliceStart(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  return isHigh(text.charCodeAt(max - 1)) && isLow(text.charCodeAt(max)) ? text.slice(0, max - 1) : text.slice(0, max)
}

/** The last `max` UTF-16 units of `text`, one fewer when the cut would split a surrogate pair. */
export function sliceEnd(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  const start = text.length - max
  return isLow(text.charCodeAt(start)) && isHigh(text.charCodeAt(start - 1)) ? text.slice(start + 1) : text.slice(start)
}
