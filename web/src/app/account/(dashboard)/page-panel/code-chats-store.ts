/**
 * A tick for the Code view's list (code-chats.tsx): the composer says a
 * coding chat started (chat/composer-code.tsx), and the list reads again.
 * A plain module, so the composer and the panel never import each other.
 *
 * Flat cost: one number and its listeners.
 */
let version = 0
const listeners = new Set<() => void>()

/** A coding chat started or changed here: the list reads again. */
export function noteCodeChatsChanged(): void {
  version += 1
  for (const listener of [...listeners]) listener()
}

export function subscribeCodeChats(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function codeChatsVersion(): number {
  return version
}
