/**
 * The knowledge map in chat cards: WebGL, so one at a time. A card holds the
 * lease while it shows the map full screen; any other card shows a still
 * until the lease is free. Module state on purpose: one map for the app.
 */
let holder: string | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Take the map for `id`. False when another card holds it. */
export function acquireMap(id: string): boolean {
  if (holder && holder !== id) return false
  if (holder !== id) {
    holder = id
    notify()
  }
  return true
}

export function releaseMap(id: string): void {
  if (holder !== id) return
  holder = null
  notify()
}

export function mapHolder(): string | null {
  return holder
}

export function subscribeMap(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
