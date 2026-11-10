'use client'

/**
 * HOW MANY WORKSPACES THE APP SHOWS — the one app-wide "Show all workspaces"
 * switch in the workspace menu (workspace-switcher.tsx).
 *
 *  • off (the default) — every surface shows the ACTIVE workspace only: in the
 *    Corvanne workspace you see Corvanne's actions, projects, bots and banners,
 *    and nothing else.
 *  • on — those same surfaces span every workspace the user belongs to, each
 *    foreign row wearing its workspace's badge.
 *
 * It replaced three per-page toggles (the My Actions toolbar's, the inbox's and
 * the Agents page's), which each held their own answer to the same question and
 * disagreed by default. Readers:
 *
 *   My Actions / Projects   use-view.ts (`workspace_scope` on the query body)
 *   Banners, bot peeks      notification-context.tsx (the inbox and its bell
 *                           went: docs/plans/retire-notifications-page.md)
 *   Bots, their pages       agent-work-provider.tsx (the shared source is
 *                           narrowed once, so every reader follows)
 *   Arrival sounds          use-attention-items.ts / use-agent-work.ts
 *
 * WHERE THE ANSWER LIVES. On the account, so it follows the user to every
 * device and every desktop window: `user_metadata.show_all_workspaces`, read
 * by the profile GET the workspace cache already makes at boot and written by
 * the profile PATCH (api/account/profile). Three pieces keep that honest:
 *
 *  • A LOCAL CACHE in localStorage, so the app boots on the last answer it saw
 *    instead of flashing the narrow view until the profile lands. It is a
 *    cache, tagged with the user it belongs to, never the source of truth.
 *  • A FLIP IS OPTIMISTIC: the switch moves at once, then the PATCH goes out.
 *    A server read that began before the latest flip, or lands while a save is
 *    in flight, is dropped — it would only put the old answer back.
 *  • A WINDOW COMING BACK re-reads the account (throttled), so a flip on the
 *    laptop reaches the desktop app the next time it is looked at. Windows
 *    that share storage also follow each other at once (`storage` event).
 *
 * An account that has never saved an answer (the GET says `null`) takes this
 * device's, and saves it — including the inbox's old per-device toggle, so a
 * viewer who had left the inbox on "All workspaces" keeps the wide view.
 *
 * The server never reads this to authorize anything: every route still
 * resolves the membership set itself, so the switch can only narrow or widen
 * what the user may already see.
 *
 * A module-level store read through useSyncExternalStore rather than a context:
 * it needs no provider, so a reader mounted anywhere (a detail panel on its
 * own, a test) gets the same answer, and the non-React callers — the sound
 * gates — can read it too.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { applyAccountSettings, beginAccountSettingsRead } from './account-setting'
import { getClientWorkspaceId } from './workspace-fetch'

export const WORKSPACE_SPAN_STORAGE_KEY = 'ni:show-all-workspaces'

/** Where the account's answer is read and written. */
export const WORKSPACE_SPAN_PROFILE_URL = '/api/account/profile'

/**
 * The inbox's old per-device toggle. Read only as a device's answer for an
 * account that has never saved one.
 */
const LEGACY_INBOX_SCOPE_KEY = 'ni:notifications-scope'

/** A window coming back re-reads the account at most this often. */
export const WORKSPACE_SPAN_RESYNC_MS = 30_000

/** The cached answer, and whose it is (null: not known when it was written). */
interface CachedSpan {
  all: boolean
  user: string | null
}

function readCache(): CachedSpan | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(WORKSPACE_SPAN_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<CachedSpan>
      if (typeof parsed?.all === 'boolean') {
        return { all: parsed.all, user: typeof parsed.user === 'string' ? parsed.user : null }
      }
    }
    if (window.localStorage.getItem(LEGACY_INBOX_SCOPE_KEY) === 'all') return { all: true, user: null }
    return null
  } catch {
    // Storage unavailable, or junk in the key: no cached answer.
    return null
  }
}

function writeCache(all: boolean, user: string | null): void {
  try {
    window.localStorage.setItem(WORKSPACE_SPAN_STORAGE_KEY, JSON.stringify({ all, user }))
  } catch {
    // Storage unavailable — the next boot waits for the profile instead.
  }
}

let current: boolean | null = null
/** The signed-in user, once a profile answer has named them. */
let knownUser: string | null = null
/** Bumped by every local flip: a read that began under an older epoch is stale. */
let epoch = 0
/** Saves on their way to the server; a read landing meanwhile is stale too. */
let savesInFlight = 0
/** When the account was last asked (throttles the comeback re-read). */
let lastReadAt = 0

const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function adopt(next: boolean): void {
  if (next === current) return
  current = next
  emit()
}

/** Another window flipped the switch (same storage): follow it. */
function onStorage(event: StorageEvent): void {
  // `key === null` is a storage.clear(), which resets this to its default.
  if (event.key !== null && event.key !== WORKSPACE_SPAN_STORAGE_KEY) return
  adopt(readCache()?.all ?? false)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1 && typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}

/** Save `all` to the account. Never throws: a failed save is logged, and the next read decides. */
async function saveToAccount(all: boolean): Promise<void> {
  savesInFlight += 1
  try {
    const res = await fetch(WORKSPACE_SPAN_PROFILE_URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ show_all_workspaces: all }),
    })
    if (!res.ok) console.warn('[workspace-span] could not save "Show all workspaces":', res.status)
  } catch (err) {
    console.warn('[workspace-span] could not save "Show all workspaces":', err)
  } finally {
    savesInFlight -= 1
  }
}

/** The switch's value right now (the cached answer until the account's lands). */
export function getShowAllWorkspaces(): boolean {
  if (current === null) current = readCache()?.all ?? false
  return current
}

/** Flip the switch: every reader re-renders at once, and the account is saved. */
export function setShowAllWorkspaces(next: boolean): void {
  if (getShowAllWorkspaces() === next) return
  current = next
  epoch += 1
  writeCache(next, knownUser)
  emit()
  void saveToAccount(next)
}

/**
 * Mark the start of a read of the account's answer; hand the result to
 * applyAccountWorkspaceSpan with this token. Called by whoever fetches the
 * profile (the workspace cache at boot, the comeback re-read below).
 */
export function beginWorkspaceSpanRead(): number {
  lastReadAt = Date.now()
  return epoch
}

/**
 * Take the account's answer from a profile GET (`{ id, show_all_workspaces }`).
 *
 *  • a boolean is the answer: adopted and cached for this user;
 *  • `null` is an account that never saved one: this device's cached answer
 *    (if it is this user's, or untagged) is adopted and SAVED, so the first
 *    device to boot after the switch shipped seeds the account;
 *  • absent (an old server, a body without the field) says nothing.
 *
 * Dropped when a flip happened after the read began, or a save is in flight:
 * the read can only carry the answer the flip replaced.
 */
export function applyAccountWorkspaceSpan(
  profile: { id?: unknown; show_all_workspaces?: unknown } | null | undefined,
  readToken: number,
): void {
  if (!profile) return
  if (typeof profile.id === 'string' && profile.id) knownUser = profile.id
  const answer = profile.show_all_workspaces
  if (answer !== null && typeof answer !== 'boolean') return
  if (readToken !== epoch || savesInFlight > 0) return

  if (typeof answer === 'boolean') {
    writeCache(answer, knownUser)
    adopt(answer)
    return
  }

  const cached = readCache()
  if (cached && (cached.user === null || cached.user === knownUser)) {
    writeCache(cached.all, knownUser)
    adopt(cached.all)
    void saveToAccount(cached.all)
    return
  }
  // Another user's cache on a shared device: not this account's to inherit.
  adopt(false)
}

/**
 * Re-read the account's answer now (see applyAccountWorkspaceSpan), and the
 * other settings the same profile carries: the agent's look and name
 * (lib/account-setting).
 */
export async function syncWorkspaceSpanFromAccount(): Promise<void> {
  const token = beginWorkspaceSpanRead()
  const settingsRead = beginAccountSettingsRead()
  try {
    const res = await fetch(WORKSPACE_SPAN_PROFILE_URL, { cache: 'no-store' })
    if (!res.ok) return
    const profile = (await res.json()) as Record<string, unknown>
    applyAccountWorkspaceSpan(profile, token)
    applyAccountSettings(profile, settingsRead)
  } catch {
    // Offline or signed out: keep the answer held.
  }
}

/**
 * Re-read the account whenever this window comes back (it becomes visible or
 * takes focus), at most every WORKSPACE_SPAN_RESYNC_MS: how a flip made on
 * another device, or in another desktop window, reaches this one. Mounted
 * once, by the workspace cache provider; the boot read is that provider's own
 * profile fetch.
 */
export function useWorkspaceSpanAccountSync(): void {
  useEffect(() => {
    const onComeBack = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastReadAt < WORKSPACE_SPAN_RESYNC_MS) return
      void syncWorkspaceSpanFromAccount()
    }
    document.addEventListener('visibilitychange', onComeBack)
    window.addEventListener('focus', onComeBack)
    return () => {
      document.removeEventListener('visibilitychange', onComeBack)
      window.removeEventListener('focus', onComeBack)
    }
  }, [])
}

/**
 * Is the app showing every workspace? `false` on the server and during
 * hydration (the narrow view is the default), then the held answer.
 */
export function useShowAllWorkspaces(): boolean {
  return useSyncExternalStore(subscribe, getShowAllWorkspaces, () => false)
}

/**
 * Does something from `workspaceId` belong on screen right now? Always, with
 * the switch on; otherwise only when it is the active workspace's. An unknown
 * active workspace (the client id isn't set yet) or an unknown row workspace
 * answers yes: "show it" is the old behaviour, and a gate that hid everything
 * while the app boots would read as a bug.
 *
 * For callers outside React (the arrival-sound gates); a component reads the
 * hook above and the workspace cache instead.
 */
export function isInWorkspaceSpan(workspaceId: string | null | undefined): boolean {
  if (getShowAllWorkspaces()) return true
  const active = getClientWorkspaceId()
  if (!active || !workspaceId) return true
  return workspaceId === active
}

/** Test seam: forget everything held so the next read goes back to storage. */
export function resetWorkspaceSpanForTests(): void {
  current = null
  knownUser = null
  epoch = 0
  savesInFlight = 0
  lastReadAt = 0
}
