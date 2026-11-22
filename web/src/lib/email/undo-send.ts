/**
 * Undo send, for Mail's composer: Send waits a few seconds before it goes,
 * with "Sending… Undo" on screen; Undo puts the message back in the composer
 * and nothing leaves. The wait lives here, not in the composer, so closing
 * the composer or the thread (or moving to another one) never drops a send;
 * only Undo does. While a send waits, leaving the page asks first (a closed
 * tab would lose it).
 *
 * Nothing is held at the provider: the request is simply not made until the
 * time is up, which is the only undo that is the same for Gmail and Outlook.
 */

export const UNDO_SEND_MS = 5000

interface Pending {
  timer: ReturnType<typeof setTimeout>
  run: () => void
}

const pending = new Map<number, Pending>()
let nextId = 1

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (pending.size === 0) return
  e.preventDefault()
  // Older browsers need a value set to ask.
  e.returnValue = ''
}

function watchUnload(on: boolean) {
  if (typeof window === 'undefined') return
  if (on) window.addEventListener('beforeunload', onBeforeUnload)
  else window.removeEventListener('beforeunload', onBeforeUnload)
}

export interface QueuedSend {
  /** Stops it if it hasn't gone yet. True when it was stopped (nothing sent). */
  undo: () => boolean
  /** Sends now, without waiting out the rest of the time. */
  flush: () => void
}

/**
 * Run `send` after `delayMs` unless it is undone first. Never throws: what
 * `send` does on failure is its own.
 */
export function queueSend(send: () => Promise<unknown> | unknown, delayMs: number = UNDO_SEND_MS): QueuedSend {
  const id = nextId++
  const run = () => {
    const entry = pending.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    pending.delete(id)
    if (pending.size === 0) watchUnload(false)
    void Promise.resolve()
      .then(send)
      .catch(() => {})
  }
  if (pending.size === 0) watchUnload(true)
  pending.set(id, { timer: setTimeout(run, Math.max(0, delayMs)), run })
  return {
    undo: () => {
      const entry = pending.get(id)
      if (!entry) return false
      clearTimeout(entry.timer)
      pending.delete(id)
      if (pending.size === 0) watchUnload(false)
      return true
    },
    flush: run,
  }
}

/** How many sends are waiting (tests; the unload guard). */
export function pendingSendCount(): number {
  return pending.size
}
