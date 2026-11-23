/**
 * The colors of the tags this window has seen, by id: a pill in an editor
 * (TagPill's node view, plain DOM) reads its color here, so a pill whose
 * markdown carries only id and name still paints in the tag's color, and a
 * recolor repaints every pill at once. Fed by every tag list the app loads.
 * Client-only state; empty on the server.
 */
type Listener = () => void

const colors = new Map<string, string>()
const listeners = new Set<Listener>()

export const tagColorStore = {
  get(id: string): string | undefined {
    return colors.get(id.toLowerCase())
  },
  /** Remember these colors; listeners hear once, and only when something changed. */
  put(tags: ReadonlyArray<{ id: string; color: string | null | undefined }>): void {
    let changed = false
    for (const t of tags) {
      if (!t.color) continue
      const key = t.id.toLowerCase()
      if (colors.get(key) !== t.color) {
        colors.set(key, t.color)
        changed = true
      }
    }
    if (changed) for (const l of listeners) l()
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  /** Tests only. */
  reset(): void {
    colors.clear()
    listeners.clear()
  },
}
