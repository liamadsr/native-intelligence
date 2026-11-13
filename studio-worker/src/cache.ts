/**
 * The asset cache: library files (assets/<sha256>.<ext>) the worker has
 * downloaded, kept so the next render of the same project does not fetch them
 * again. Content-addressed, so a cached file is never stale: a file is only
 * put here once its bytes were checked against its sha256, and its size is
 * checked again on every use.
 *
 * Bounded: past `maxBytes`, the files used least recently go first (a use
 * touches the file's mtime). A file a running job holds (pinned) is never
 * removed.
 */
import { mkdir, readdir, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'

export const ASSET_FILE = /^[a-f0-9]{64}\.[a-z0-9]+$/

export interface CacheEntry {
  name: string
  bytes: number
  usedAt: number
}

/** Which entries to remove so the rest fit in `maxBytes`: oldest use first, never a pinned one. Pure. */
export function evictionPlan(entries: CacheEntry[], maxBytes: number, pinned: ReadonlySet<string>): string[] {
  let total = entries.reduce((n, e) => n + e.bytes, 0)
  const out: string[] = []
  for (const e of [...entries].sort((a, b) => a.usedAt - b.usedAt)) {
    if (total <= maxBytes) break
    if (pinned.has(e.name)) continue
    out.push(e.name)
    total -= e.bytes
  }
  return out
}

export class AssetCache {
  readonly dir: string
  private readonly maxBytes: number
  private readonly pins = new Map<string, number>()

  constructor(dir: string, maxBytes: number) {
    this.dir = dir
    this.maxBytes = maxBytes
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    // Downloads cut short by a crash.
    for (const name of await readdir(this.dir)) if (!ASSET_FILE.test(name)) await rm(join(this.dir, name), { force: true, recursive: true, maxRetries: 5, retryDelay: 200 })
  }

  /** Where a file lives in the cache (`assets/<sha>.<ext>` → <dir>/<sha>.<ext>). */
  pathOf(file: string): string {
    const name = file.replace(/^assets\//, '')
    if (!ASSET_FILE.test(name)) throw new Error(`Not an asset file: ${file}`)
    return join(this.dir, name)
  }

  /** The cached file when it is there at the expected size (and marks it used), else null. */
  async lookup(file: string, bytes: number): Promise<string | null> {
    const path = this.pathOf(file)
    try {
      const s = await stat(path)
      if (s.size !== bytes) {
        await rm(path, { force: true, maxRetries: 5, retryDelay: 200 })
        return null
      }
      const now = new Date()
      await utimes(path, now, now).catch(() => undefined)
      return path
    } catch {
      return null
    }
  }

  /** Hold files while a job uses them; the returned function lets go. */
  pin(files: string[]): () => void {
    const names = files.map((f) => f.replace(/^assets\//, ''))
    for (const n of names) this.pins.set(n, (this.pins.get(n) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      for (const n of names) {
        const left = (this.pins.get(n) ?? 1) - 1
        if (left <= 0) this.pins.delete(n)
        else this.pins.set(n, left)
      }
    }
  }

  /** Remove the least recently used files until the cache fits its bound. Returns what was removed. */
  async trim(): Promise<string[]> {
    const entries: CacheEntry[] = []
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (!ASSET_FILE.test(name)) continue
      try {
        const s = await stat(join(this.dir, name))
        entries.push({ name, bytes: s.size, usedAt: s.mtimeMs })
      } catch {
        // gone meanwhile
      }
    }
    const plan = evictionPlan(entries, this.maxBytes, new Set(this.pins.keys()))
    // A file another process still holds (Windows refuses to delete an open file) stays until the next eviction.
    for (const name of plan) await rm(join(this.dir, name), { force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined)
    return plan
  }
}
