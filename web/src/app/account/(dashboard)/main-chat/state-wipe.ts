/**
 * Sign-out wipe of persisted per-user state — a LEAF module on purpose.
 *
 * Both sides of the sign-out flow need this: workspace-switcher (the Sign out
 * click) starts the wipe, and the main chat's storage (main-chat-storage.ts)
 * must honour it. The main chat already imports from workspace-switcher
 * (useWorkspaceId), so workspace-switcher can never import it back without a
 * cycle — this module imports NOTHING from app code so either side can pull it
 * in freely.
 *
 * Why a flag and not just a key sweep: clicking Sign out removes the keys, but
 * the navigation to /sign-out then fires the main chat's pagehide flush, which
 * would RE-PERSIST the chat's thread — handing the next user on a shared device
 * the previous user's conversation anyway. The flag disarms every subsequent
 * writer (the pagehide flush, the workspace-switch write) for the remainder of
 * this page load. Module state is exactly the right lifetime: the wipe only
 * needs to hold until the /sign-out navigation completes, and the next page
 * load starts clean.
 */

// Everything persisted per-user: the main chat of each workspace and the
// last-workspace pointer (`ni-chat:*`), the in-app browser's saved tabs and
// its routing (under `ni-tabs*`, also where the retired chat tabs lived),
// and what the retired bot crew and its desktop overlay left on a device
// (`ni:bots:cast`, `ni:bots:bubble*`, `ni:bots:seen:<user>`,
// `ni:bots:peek:<user>`: the cast, the overlay's bubble, when this device
// last saw the bots, the peeks dismissed), still cleared so a device from
// before signs out clean. Most of it is not keyed by user, hence the sign-out
// wipe. Also this device's copy of the agent's look and name
// (`ni:agent-look`, `ni:voice:assistant-name`) and of the app rail's
// bar (`ni:rail-pages`; the account keeps the real ones,
// lib/account-setting.ts), so the next account to sign in starts
// on the default rather than the last one's, and a desktop HUD still open
// drops it at once.
const WIPE_KEY_PREFIXES = [
  'ni-chat:',
  'ni-tabs',
  'ni:bots:cast',
  'ni:bots:bubble',
  'ni:bots:seen',
  'ni:bots:peek',
  'ni:agent-look',
  'ni:voice:assistant-name',
  'ni:rail-pages',
] as const

let wipeActive = false

/** Heard on a wipe (onTabStateWipe): per-user state held in memory, not storage. */
const wipeListeners = new Set<() => void>()

/**
 * Remove everything persisted per-user and disarm the main chat's storage
 * writers for the rest of this page load. Call from the Sign out click, BEFORE the
 * navigation to /sign-out. Best-effort: localStorage can be unavailable
 * (privacy mode / quota) and sign-out must never be blocked by it.
 */
export function beginPersistedTabStateWipe(): void {
  // Flag first — even if the removal below throws, the writers stay disarmed.
  wipeActive = true
  for (const listener of [...wipeListeners]) {
    try {
      listener()
    } catch {
      // ignore — a listener never blocks sign-out either
    }
  }
  try {
    // Collect first, then remove — deleting while walking localStorage.key(i)
    // shifts the indices and skips every other key.
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && WIPE_KEY_PREFIXES.some((p) => key.startsWith(p))) doomed.push(key)
    }
    for (const key of doomed) localStorage.removeItem(key)
  } catch {
    // ignore — see above
  }
}

/** Has a sign-out wipe started this page load? Storage writers must bail. */
export function isTabStateWipeActive(): boolean {
  return wipeActive
}

/**
 * Hear the sign-out wipe, for per-user state that lives in memory rather than
 * localStorage: the bots v2 teammate threads (use-teammate-chat.ts), which
 * outlive the bubble that shows them. Returns the unsubscribe.
 */
export function onTabStateWipe(listener: () => void): () => void {
  wipeListeners.add(listener)
  return () => {
    wipeListeners.delete(listener)
  }
}
