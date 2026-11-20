/**
 * The demo's own storage. The demo page is on the site's own domain, so the
 * app it mounts would otherwise read and write the SAME localStorage the real
 * app uses: it would open on the visitor's real chat draft, and leave the
 * demo workspace's id, chat and settings behind for their next sign-in (and
 * push them, live, into a tab where they are signed in now).
 *
 * So before any of the app's code loads, `localStorage` and `sessionStorage`
 * on the demo page are replaced by ones that live in memory: empty at the
 * start, gone with the page, and firing no `storage` event anywhere.
 * components/demo/demo-app.tsx installs this and only then loads the app,
 * because some of the app's modules read storage as they are imported.
 */
class MemoryStorage implements Storage {
  private items = new Map<string, string>()
  get length(): number {
    return this.items.size
  }
  clear(): void {
    this.items.clear()
  }
  getItem(key: string): string | null {
    return this.items.get(String(key)) ?? null
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.items.delete(String(key))
  }
  setItem(key: string, value: string): void {
    this.items.set(String(key), String(value))
  }
  [name: string]: unknown
}

/** Whether `storage` is the demo's in-memory kind. */
export function isDemoStorage(storage: unknown): boolean {
  return storage instanceof MemoryStorage
}

/** Replaces this page's two storages. False when the browser would not let it: the demo must not start then. */
export function installDemoStorage(target: Window = window): boolean {
  try {
    for (const name of ['localStorage', 'sessionStorage'] as const) {
      if (isDemoStorage(target[name])) continue
      Object.defineProperty(target, name, { value: new MemoryStorage(), configurable: true, writable: false })
    }
    return isDemoStorage(target.localStorage) && isDemoStorage(target.sessionStorage)
  } catch {
    return false
  }
}
