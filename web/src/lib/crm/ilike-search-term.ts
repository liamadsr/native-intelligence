/**
 * A free-text term (model- or user-supplied) made safe to interpolate into a
 * PostgREST `.or()` filter as `col.ilike.%${term}%`.
 *
 * `.or()` takes a raw logic tree: `,` separates conditions, `(` `)` open and
 * close groups, `"` starts a quoted value and `\` escapes inside one. A term
 * carrying any of them can end its condition and add new ones (e.g.
 * `x%,id.neq.0` would match every row). Those characters are STRIPPED. So are
 * the ilike wildcards `%` and `*` (PostgREST reads `*` as `%`), so a bare `%`
 * cannot turn a name lookup into "match everything"; `_` (any one character)
 * is escaped to match literally, since it is common in emails.
 *
 * `.` is kept on purpose: PostgREST splits `column.operator.value` on the
 * first two dots only, so a dot in the value is inert, and stripping it would
 * break email and initial lookups ("ana@example.com", "J. Smith").
 *
 * Returns '' when nothing searchable is left; callers skip the query then.
 */
export function toIlikeSearchTerm(raw: string): string {
  return raw
    .replace(/[,()"\\*%]/g, '')
    .trim()
    .replace(/_/g, '\\_')
}
