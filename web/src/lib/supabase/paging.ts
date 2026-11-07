/**
 * Paging helpers for PostgREST reads.
 *
 * Two limits bite reads that "just select everything":
 *  - PostgREST caps every response at max-rows (1000 here), silently, so an
 *    unpaged read (or a `.limit(5000)`) returns at most 1000 rows with no error.
 *  - `.in('col', ids)` puts every id in the request URL, so a few hundred uuids
 *    overflow it and the whole read fails.
 *
 * `fetchAllRows` pages one query until a short page; `inChunks` splits an id
 * list and runs one query per chunk. They compose:
 *
 *   const { data, error } = await inChunks(ids, 100, (chunkIds) =>
 *     fetchAllRows(() => supabase.from('comment').select('commentable_id').in('commentable_id', chunkIds)),
 *   )
 *
 * Both are non-throwing and return `{ data, error }` like a PostgREST response,
 * so a caller checks `error` exactly as it would for a single read. On error
 * `data` holds whatever was read before the failure: treat it as partial.
 */

export type PageError = { message: string }
export type PageResult<T> = { data: T[] | null; error: PageError | null }

/** The slice of a PostgREST filter builder that paging needs. */
export interface PageableQuery<T> {
  order(column: string, options?: { ascending?: boolean }): PageableQuery<T>
  range(from: number, to: number): PromiseLike<PageResult<T>>
}

export const DEFAULT_PAGE_SIZE = 1000
export const DEFAULT_CHUNK_SIZE = 200

/** Split `items` into consecutive slices of at most `size` items. */
export function chunk<T>(items: readonly T[], size = DEFAULT_CHUNK_SIZE): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error(`chunk: size must be a positive integer, got ${size}`)
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Read every row of a query, `pageSize` rows at a time, until a page comes back
 * short. `makeQuery` must build a FRESH query each call (a PostgREST builder
 * runs once per await); the helper adds `.order(orderBy)` and `.range()`.
 * A stable order is what makes offset paging correct, so the default orders by
 * `id`. Pass `orderBy: null` when `makeQuery` already applies its own total
 * order (it must still be unique, or rows can repeat or go missing across
 * pages).
 */
export async function fetchAllRows<T>(
  makeQuery: () => PageableQuery<T>,
  { pageSize = DEFAULT_PAGE_SIZE, orderBy = 'id' }: { pageSize?: number; orderBy?: string | null } = {},
): Promise<{ data: T[]; error: PageError | null }> {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`fetchAllRows: pageSize must be a positive integer, got ${pageSize}`)
  }
  const rows: T[] = []
  for (let from = 0; ; from += pageSize) {
    const base = makeQuery()
    const ordered = orderBy ? base.order(orderBy, { ascending: true }) : base
    const { data, error } = await ordered.range(from, from + pageSize - 1)
    if (error) return { data: rows, error }
    const page = data ?? []
    rows.push(...page)
    if (page.length < pageSize) return { data: rows, error: null }
  }
}

/**
 * Run `fetchPage` once per chunk of `ids` (in parallel) and concatenate the
 * rows in chunk order. An empty `ids` makes no request. The first error wins.
 * Wrap the per-chunk query in `fetchAllRows` when one chunk can match more
 * than a page of rows.
 */
export async function inChunks<I, T>(
  ids: readonly I[],
  size: number,
  fetchPage: (chunkIds: I[]) => PromiseLike<PageResult<T>>,
): Promise<{ data: T[]; error: PageError | null }> {
  const results = await Promise.all(chunk(ids, size).map((c) => fetchPage(c)))
  const failed = results.find((r) => r.error)
  return {
    data: results.flatMap((r) => r.data ?? []),
    error: failed?.error ?? null,
  }
}
