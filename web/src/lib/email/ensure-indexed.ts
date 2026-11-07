/**
 * Before Mail acts on a search result the index doesn't have (a list row with
 * `indexed: false`, src/lib/email/search-result-rows.ts), it is indexed
 * (POST /api/account/email/threads/materialize), so the thread routes (star,
 * archive, trash, labels) find their row. A row the index has is left alone.
 * One request per thread at a time. Resolves to the index row id, or null when
 * nothing was needed or the thread could not be indexed (the action then runs
 * as before).
 */
export interface IndexableThread {
  provider_thread_id: string
  account_id?: string | null
  indexed?: boolean
}

const inflight = new Map<string, Promise<string | null>>()

export function ensureIndexed(thread: IndexableThread, doFetch: typeof fetch = fetch): Promise<string | null> {
  if (thread.indexed !== false || !thread.account_id) return Promise.resolve(null)
  const key = `${thread.account_id}:${thread.provider_thread_id}`
  const open = inflight.get(key)
  if (open) return open
  const run = (async () => {
    try {
      const res = await doFetch('/api/account/email/threads/materialize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: thread.provider_thread_id, accountId: thread.account_id }),
      })
      if (!res.ok) return null
      const data = (await res.json()) as { id?: unknown }
      return typeof data.id === 'string' ? data.id : null
    } catch {
      return null
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, run)
  return run
}
