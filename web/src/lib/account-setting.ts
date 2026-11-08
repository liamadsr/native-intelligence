'use client'

/**
 * A setting kept on the ACCOUNT with a copy on this device: the agent's look
 * (lib/bots/agent-look-store) and its name (lib/voice/assistant-name-store).
 * Both used to live on the device alone, so signing into another account in
 * the desktop app kept the last account's agent (Liam, 11-01). The shape
 * follows "Show all workspaces" (lib/workspace-span):
 *
 *  • THE ACCOUNT is the truth: `user_metadata.<field>`, read by the profile
 *    GET the workspace cache makes at boot (workspace-switcher.tsx) and again
 *    when a window comes back (workspace-span's comeback re-read), written by
 *    the profile PATCH (api/account/profile). `null` from the GET is an account
 *    that never saved one: the default.
 *  • A COPY in localStorage, read synchronously: what shows until the profile
 *    lands, what the wake word reads offline, and all a window that never
 *    reads the profile has (the desktop HUD). Windows that share storage
 *    follow each other through `storage` events. Sign Out removes the copies
 *    (main-chat/state-wipe.ts), so the next account starts on the default
 *    rather than the last one's.
 *  • A SAVE moves the copy at once, then waits for the account: false, and
 *    the old value back, when the account didn't take it. A read that began
 *    before a save ended, or lands while one is in flight, is dropped: it can
 *    only carry the value the save replaced.
 *
 * Saves from this window go out one at a time: GoTrue merges `user_metadata`
 * by reading and rewriting it, so two at once (the look and the name, saved
 * together by the agent editor) could each undo the other.
 */

/** Where the account's settings are read and written. */
export const ACCOUNT_PROFILE_URL = '/api/account/profile'

interface AccountSettingOptions<T> {
  /** Its key in the profile GET/PATCH (and in `user_metadata`). */
  field: string
  /** Where this device keeps its copy. */
  storageKey: string
  /** A stored or served value, checked; null when it isn't one. */
  parse: (raw: unknown) => T | null
  /** Two values that show the same. */
  same: (a: T, b: T) => boolean
}

export interface AccountSetting<T> {
  /** The saved value, or null while the default stands in. The same object until it changes. */
  get(): T | null
  subscribe(listener: () => void): () => void
  /** Save to the account; false (and the old value back) when it wasn't taken. */
  save(next: T): Promise<boolean>
  /** Tests only: a fresh page (read again from storage on next use). */
  resetForTests(): void
}

interface Registered {
  epoch(): number
  apply(profile: Record<string, unknown>, readEpoch: number): void
}

const registered = new Set<Registered>()
/** The latest profile read this page load: a setting first used after it lands still takes it. */
let lastProfile: Record<string, unknown> | null = null
let saveChain: Promise<unknown> = Promise.resolve()

/**
 * Run a save to the account's `user_metadata` after every other one this
 * window started (see the header: two at once can undo each other). The
 * settings here use it, and so does the model setting, which saves through
 * its own route (app/account/settings/agent-model-section.tsx).
 */
export function oneAtATime<R>(task: () => Promise<R>): Promise<R> {
  const run = saveChain.then(task, task)
  saveChain = run.catch(() => undefined)
  return run
}

async function patchAccount(body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(ACCOUNT_PROFILE_URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) console.warn('[account-setting] could not save', Object.keys(body).join(', '), res.status)
    return res.ok
  } catch (err) {
    console.warn('[account-setting] could not save', Object.keys(body).join(', '), err)
    return false
  }
}

export function createAccountSetting<T>({ field, storageKey, parse, same }: AccountSettingOptions<T>): AccountSetting<T> {
  /** undefined: not read from storage yet. */
  let value: T | null | undefined
  /** Bumped by every save: a read that began under an older one is stale. */
  let epoch = 0
  let savesInFlight = 0
  let watching = false
  const listeners = new Set<() => void>()

  function readCopy(): T | null {
    try {
      const raw = window.localStorage.getItem(storageKey)
      return raw ? parse(JSON.parse(raw)) : null
    } catch {
      return null
    }
  }

  function writeCopy(next: T | null): void {
    try {
      if (next === null) window.localStorage.removeItem(storageKey)
      else window.localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      // Storage refused: this page still holds the value, and the next boot asks the account.
    }
  }

  function get(): T | null {
    if (value === undefined) {
      if (typeof window === 'undefined') return null
      value = readCopy()
      // From the first read, not the first subscriber: a reader that never
      // subscribes (the HUD's wake word and dictation corrector, through
      // getAssistantName) still follows a sign-out or another account.
      if (!watching) {
        watching = true
        window.addEventListener('storage', onStorage)
      }
    }
    return value
  }

  function adopt(next: T | null): void {
    const now = get()
    if (next === now || (next !== null && now !== null && same(next, now))) return
    value = next
    for (const listener of [...listeners]) listener()
  }

  /** Another window saved, adopted or removed the copy. */
  function onStorage(event: StorageEvent): void {
    if (event.key === storageKey || event.key === null) adopt(readCopy())
  }

  function apply(profile: Record<string, unknown>, readEpoch: number): void {
    // Absent: a server from before the field says nothing.
    if (!(field in profile)) return
    if (readEpoch !== epoch || savesInFlight > 0) return
    const next = parse(profile[field])
    adopt(next)
    writeCopy(get())
  }

  registered.add({ epoch: () => epoch, apply })
  if (lastProfile) apply(lastProfile, epoch)

  return {
    get,
    subscribe(listener) {
      // Read the copy first (and start following other windows), so a change
      // from here on is told apart from it.
      get()
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async save(next) {
      const checked = parse(next)
      if (checked === null) return false
      const before = get()
      epoch += 1
      adopt(checked)
      const shown = get()
      writeCopy(shown)
      savesInFlight += 1
      let ok = false
      try {
        ok = await oneAtATime(() => patchAccount({ [field]: checked }))
      } finally {
        savesInFlight -= 1
        // A read that began while this was out may carry the value before it.
        epoch += 1
      }
      // Put the old value back, unless something newer replaced this one meanwhile.
      if (!ok && get() === shown) {
        adopt(before)
        writeCopy(before)
      }
      return ok
    },
    resetForTests() {
      if (watching && typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
      watching = false
      listeners.clear()
      value = undefined
      epoch = 0
      savesInFlight = 0
      lastProfile = null
    },
  }
}

/** A read of the account's settings, begun: hand it back to applyAccountSettings. */
export type AccountSettingsRead = ReadonlyMap<Registered, number>

/** Mark the start of a profile read (whoever fetches the profile calls this first). */
export function beginAccountSettingsRead(): AccountSettingsRead {
  return new Map([...registered].map((setting) => [setting, setting.epoch()]))
}

/** Take the account's settings from a profile GET begun with `read`. */
export function applyAccountSettings(profile: Record<string, unknown> | null | undefined, read: AccountSettingsRead): void {
  if (!profile || typeof profile !== 'object') return
  lastProfile = profile
  // A setting first used while the read was out had no save to lose to.
  for (const setting of registered) setting.apply(profile, read.get(setting) ?? setting.epoch())
}
