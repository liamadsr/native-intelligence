/**
 * Tells the desktop app when its person is in one of our own calls, so its
 * meeting detection holds back (desktop `set_own_call_active`,
 * src-tauri/src/meeting_detection.rs `set_own_call`).
 *
 * Why: the server records our own calls (team calls and meeting-link calls)
 * itself. The desktop's detector sees any browser or meeting app on the mic
 * as a meeting and, with "Auto-record meetings" on, starts a capture of its
 * own: hosting one of our calls in Chrome on the same computer would give a
 * second capture of the same call and a HUD prompt mid-call. A call in the
 * desktop's own window is never detected (its own web view is left out on
 * both systems), but a browser tab or another device is not, so the word
 * comes from the server's record of the call, not from this window:
 * `team_call_participant` rows of his members that are `joined` in a call
 * still `live` (the same reading the reach router uses,
 * src/lib/reach/route.ts callReading). That covers the call wherever it
 * runs: this window, a browser on this computer, or his phone.
 *
 * How: the desktop's main window only (all windows share one detector).
 * One read now, on every change to his participant rows (realtime), and
 * every OWN_CALL_TICK_MS. While he is in a call, every evaluation says
 * `true` (the desktop holds each word for 150 s, so a window that reloads,
 * crashes or goes offline stops holding detection back by itself); when the
 * call is over it says `false` once. A failed read says nothing (the lease
 * runs out on its own). A desktop build without the command ignores it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isDesktopApp } from '@/lib/platform'
import { getThisWebviewLabel } from '@/lib/tauri-bridge'

/** How often the reading is redone (and a live call's word re-said). Well inside the desktop's 150 s lease. */
export const OWN_CALL_TICK_MS = 60_000

/** A change on his rows can arrive in a burst (join, then the webhook's update): read once after it settles. */
export const OWN_CALL_CHANGE_DEBOUNCE_MS = 500

export interface OwnCallWatchDeps {
  /** Whether he is in one of our calls now; null when the read failed. */
  readInCall: () => Promise<boolean | null>
  /** Tell the desktop. */
  send: (active: boolean) => Promise<void>
  /** Call `onChange` whenever his participant rows change; returns the unsubscribe. */
  subscribe: (onChange: () => void) => () => void
}

/**
 * The watch itself, free of Supabase and Tauri (tested with fakes). Returns
 * stop, which also takes the hold back (`false`) if it had said `true`.
 */
export function watchOwnCall(deps: OwnCallWatchDeps): () => void {
  let stopped = false
  let lastSent: boolean | null = null
  let running = false
  let again = false
  let debounce: ReturnType<typeof setTimeout> | null = null

  const say = (active: boolean) => {
    lastSent = active
    void deps.send(active).catch(() => {})
  }

  const evaluate = async () => {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      do {
        again = false
        const inCall = await deps.readInCall().catch(() => null)
        if (stopped) return
        if (inCall === true) say(true)
        else if (inCall === false && lastSent !== false) say(false)
      } while (again && !stopped)
    } finally {
      running = false
    }
  }

  const unsubscribe = deps.subscribe(() => {
    if (stopped) return
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      void evaluate()
    }, OWN_CALL_CHANGE_DEBOUNCE_MS)
  })
  const tick = setInterval(() => void evaluate(), OWN_CALL_TICK_MS)
  void evaluate()

  return () => {
    stopped = true
    clearInterval(tick)
    if (debounce) clearTimeout(debounce)
    unsubscribe()
    if (lastSent === true) say(false)
  }
}

/** The browser Supabase client (signed in as the person: his rows are read under RLS). */
type Supabase = SupabaseClient

/** His member ids, in every workspace (a call in another workspace is as much a call). Null on a failed read. */
async function memberIds(supabase: Supabase, userId: string): Promise<string[] | null> {
  const { data, error } = await supabase.from('member').select('id').eq('user_id', userId)
  if (error) return null
  return ((data ?? []) as Array<{ id?: unknown }>).map((m) => m.id).filter((id): id is string => typeof id === 'string')
}

/**
 * Start the watch for the signed-in person in the desktop's main window.
 * Returns stop; a no-op anywhere else (the web, iOS, other desktop windows).
 */
export function startDesktopOwnCallWatch(userId: string, supabase: Supabase): () => void {
  if (!isDesktopApp()) return () => {}
  let stop: (() => void) | null = null
  let cancelled = false

  void (async () => {
    if ((await getThisWebviewLabel()) !== 'main' || cancelled) return
    const ids = await memberIds(supabase, userId)
    if (cancelled || !ids || ids.length === 0) return
    const { invoke } = await import('@tauri-apps/api/core')
    if (cancelled) return

    stop = watchOwnCall({
      readInCall: async () => {
        const { data, error } = await supabase
          .from('team_call_participant')
          .select('call_id, team_call!inner(status)')
          .in('member_id', ids)
          .eq('state', 'joined')
          .eq('team_call.status', 'live')
          .limit(1)
        if (error) return null
        return Array.isArray(data) && data.length > 0
      },
      send: (active) => invoke<void>('set_own_call_active', { active }),
      subscribe: (onChange) => {
        const channel = supabase
          .channel(`own-call:${userId}:${Math.random().toString(36).slice(2, 10)}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'team_call_participant', filter: `member_id=in.(${ids.join(',')})` }, onChange)
          .subscribe()
        return () => {
          void supabase.removeChannel(channel)
        }
      },
    })
  })()

  return () => {
    cancelled = true
    stop?.()
  }
}
