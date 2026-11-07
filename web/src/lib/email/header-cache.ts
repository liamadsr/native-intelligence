/**
 * The inbox's header cache, in browser memory only (no stored mail,
 * 2026-10-15): nothing goes to localStorage or IndexedDB, and a reload asks
 * again. Keyed by the index row and its newest message, so a new message on a
 * thread fetches its new header. Each fill is ONE POST for the rows it lacks
 * (50 a call), and rows already in flight are not asked twice. A row the
 * mailbox did not answer for (a failed or timed-out call, or no header in the
 * reply) is marked header_unavailable, so the list shows a neutral line rather
 * than loading forever; the next fill still asks for it.
 */

export interface CachedHeader {
  subject: string | null
  snippet: string | null
  from_name: string | null
}

interface HeaderRowLike {
  id: string
  provider_message_id?: string | null
}

const MAX_ENTRIES = 2000
const BATCH = 50
/** A header call that has not answered by now counts as failed. */
export const HEADER_TIMEOUT_MS = 15_000
const cache = new Map<string, CachedHeader>()
const inflight = new Map<string, Promise<void>>()
/** Rows whose last fill came back without a header (bounded like the cache). */
const unavailable = new Set<string>()

const keyOf = (row: HeaderRowLike) => `${row.id}:${row.provider_message_id ?? ''}`

/** The cached header for a row, if any. */
export function cachedHeader(row: HeaderRowLike): CachedHeader | undefined {
  return cache.get(keyOf(row))
}

/**
 * Rows with what the cache knows merged in (subject, snippet, sender name),
 * and header_unavailable on a row its last fill got nothing for. Pure over
 * the cache; a row with nothing new is returned as it is.
 */
export function withCachedHeaders<T extends HeaderRowLike & { subject?: string | null; snippet?: string | null; from_name?: string | null; header_unavailable?: boolean }>(rows: T[]): T[] {
  return rows.map((row) => {
    const key = keyOf(row)
    const h = cache.get(key)
    if (!h) {
      const gone = unavailable.has(key)
      return !!row.header_unavailable === gone ? row : { ...row, header_unavailable: gone }
    }
    return { ...row, subject: h.subject ?? row.subject ?? null, snippet: h.snippet ?? row.snippet ?? null, from_name: h.from_name ?? row.from_name ?? null, header_unavailable: false }
  })
}

function markUnavailable(key: string) {
  if (unavailable.size >= MAX_ENTRIES) {
    const oldest = unavailable.values().next().value
    if (oldest !== undefined) unavailable.delete(oldest)
  }
  unavailable.add(key)
}

function remember(key: string, header: CachedHeader) {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, header)
  unavailable.delete(key)
}

/**
 * Ask for the headers the cache lacks for these rows. Resolves once they are
 * in (or the call failed: those rows stay without). `post` is the fetch, for tests.
 */
export async function fillHeaders(
  rows: readonly HeaderRowLike[],
  post: (ids: string[]) => Promise<Record<string, CachedHeader>> = postHeaders,
  timeoutMs: number = HEADER_TIMEOUT_MS,
): Promise<void> {
  const missing = rows.filter((r) => !cache.has(keyOf(r)) && !inflight.has(keyOf(r)))
  const waits = rows.map((r) => inflight.get(keyOf(r))).filter((p): p is Promise<void> => !!p)
  for (let i = 0; i < missing.length; i += BATCH) {
    const slice = missing.slice(i, i + BATCH)
    const run = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('header call timed out')), timeoutMs)
        })
        const headers = await Promise.race([post(slice.map((r) => r.id)), timeout])
        for (const row of slice) {
          const h = headers[row.id]
          if (h) remember(keyOf(row), h)
          else markUnavailable(keyOf(row))
        }
      } catch {
        // A neutral line for now; the next fill asks again.
        for (const row of slice) markUnavailable(keyOf(row))
      } finally {
        if (timer) clearTimeout(timer)
        for (const row of slice) inflight.delete(keyOf(row))
      }
    })()
    for (const row of slice) inflight.set(keyOf(row), run)
    waits.push(run)
  }
  await Promise.all(waits)
}

async function postHeaders(ids: string[]): Promise<Record<string, CachedHeader>> {
  const res = await fetch('/api/account/email/threads/headers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
  if (!res.ok) return {}
  const data = (await res.json()) as { headers?: Record<string, CachedHeader> }
  return data.headers ?? {}
}

/** Tests only. */
export function resetHeaderCache(): void {
  cache.clear()
  inflight.clear()
  unavailable.clear()
}
