'use client'

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  markSelfRefetched,
  wasSelfRefetchedRecently,
  repairIdFromRecoveredEvent,
} from '@/lib/supabase/realtime-recovery'
import { emitReminderChanged } from '@/lib/reminders/client'
import { REMINDER_ENTITY_TYPES, type ReminderEntityType } from '@/lib/reminders/types'
import { useCurrentMemberId, useWorkspaces } from './workspace-switcher'
import { toast } from 'sonner'
import { isDesktopApp } from '@/lib/platform'
import { useShowAllWorkspaces } from '@/lib/workspace-span'
import { tauriBridge } from '@/lib/tauri-bridge'
import {
  areNativeNotificationsDisabled,
  isNativeBannerPath,
  removeDeliveredBanners,
  setNativeNotificationsDisabled,
} from '@/lib/native-notification-path'
import { announceNotification } from '@/lib/sounds/triggers'
import { botNoticeCopy, noticeTeammateId, readBotNotice } from '@/lib/bots/bot-notice'
import { noticeFaceOf, noticeSpeakerOf } from '@/lib/bots/notice-faces'
import { announceHomeMessage, homeMessageOfNotice } from '@/lib/chat/home-message'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The workspace a notification belongs to, embedded by the API in `all` scope
 *  only (see NOTIFICATION_SELECT_ALL in the route). Absent in the default scope
 *  — every row there IS the active workspace, so there is nothing to disclose
 *  and nothing for the UI to draw. */
export interface NotificationWorkspace {
  id: string
  name: string
  slug: string
  logo_url: string | null
}

export interface Notification {
  id: string
  workspace_id: string
  recipient_id: string
  type: string
  title: string
  body: string | null
  actor_id: string | null
  actor_name: string | null
  actor_avatar: string | null
  target_type: string | null
  target_id: string | null
  context_type: string | null
  context_id: string | null
  is_read: boolean
  read_at: string | null
  is_archived: boolean
  group_key: string | null
  metadata: Record<string, unknown>
  created_at: string
  /** Optional on purpose: only the `all` scope's rows carry it, and a realtime
   *  INSERT never does (the channel payload is the raw table row, with no
   *  joins). Consumers draw the badge when it is present and differs from the
   *  active workspace, and nothing otherwise. */
  workspace?: NotificationWorkspace
}

/**
 * Which workspaces the inbox is reading.
 *
 *  • `workspace` — the active workspace only. The behaviour this provider has
 *    always had, and the default for anyone who has never touched the switch.
 *  • `all` — every workspace the user is a member of, resolved server-side.
 *
 * Not the inbox's own choice any more: it follows the app-wide "Show all
 * workspaces" switch in the workspace menu (lib/workspace-span), as Actions,
 * Projects and the bots do.
 */
export type NotificationWorkspaceScope = 'workspace' | 'all'

/** One (member id, workspace id) pair, as the `all` response returns them. The
 *  realtime channel filter takes a SINGLE recipient id, so the client needs the
 *  set the server read in order to subscribe one channel per membership. */
export interface NotificationMembership {
  memberId: string
  workspaceId: string
}

interface NotificationContextValue {
  /**
   * The notices this window holds that aren't a reachable bot's: from people,
   * clocks and Native Intelligence itself (bots-v4 Phase 4c, decision 8), and a bot's the
   * caller can't reach (an orphan: its teammate deleted, hidden, or behind a
   * private team they aren't on; the route says which,
   * `orphan_teammate_ids`). No list draws them: the notifications page went
   * (docs/plans/retire-notifications-page.md), and every notice reaches the
   * agent as an event. They are held for their banners and for an item
   * opened again to read its late one.
   */
  notifications: Notification[]
  /**
   * The bots' notices this window holds (bots-v4 Phase 4c): the newest
   * BOT_NOTICES_HELD with the first page, then each one realtime brings, read
   * state kept live. No list draws these as they are: an item opened again
   * reads its late one, failed runs are read off them, and a bot's Notices
   * part reads again when one of its own moves.
   */
  botNotices: Notification[]
  markAsRead: (id: string) => Promise<void>
  /** @see NotificationWorkspaceScope */
  workspaceScope: NotificationWorkspaceScope
}

const NotificationCtx = createContext<NotificationContextValue>({
  notifications: [],
  botNotices: [],
  markAsRead: async () => {},
  workspaceScope: 'workspace',
})

export function useNotifications() {
  return useContext(NotificationCtx)
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50

// Ceiling on REALTIME-inserted rows held in memory. Realtime INSERTs prepend
// without bound, so a long-lived session (the desktop shell runs for hours)
// grows this list forever — one contributor to the 948 MB WebContent heap
// measured after 7 h. 200 = four pages.
//
// TWO POOLS. The list holds rows from two independent sources and only one of
// them is ever trimmed:
//
//  • FETCHED rows come with the first page (fetchNotifications, on mount and
//    on a realtime catch-up). They are NEVER trimmed by realtime activity.
//
//  • LIVE rows arrive via a realtime INSERT. Their ids are tracked, in
//    insertion order (oldest first), by `liveIdsRef`. When that set passes
//    MAX_LIVE_NOTIFICATIONS the OLDEST live ids are evicted from both the set
//    and the list. Those rows still exist server-side, so they come back in a
//    later page or on a refetch — nothing is lost, only unpinned from memory.
//
// Keeping the two pools disjoint means realtime traffic can never hide a
// fetched row. INVARIANT: list.length ≤ the first page + 200.
const MAX_LIVE_NOTIFICATIONS = 200

/** Do two membership lists name the same member ids, in the same order? Used to
 *  keep the `memberships` state IDENTITY-stable across refetches: the realtime
 *  effect is keyed on the derived channel list, so a fresh array on every page
 *  fetch would tear down and rebuild every channel for no reason. */
function sameMemberIds(a: NotificationMembership[], b: NotificationMembership[]): boolean {
  return a.length === b.length && a.every((m, i) => m.memberId === b[i].memberId)
}

/**
 * Whether a notice is a bot's (it lives with its bot), as the route decides
 * (bots-v4 Phase 4c): its row names a teammate, and that teammate isn't one
 * the caller can't reach (`orphans`, the route's `orphan_teammate_ids`). A
 * teammate first named after the last first page (a notice realtime brings)
 * counts as reachable for the beat until the route says
 * (UNKNOWN_TEAMMATE_REREAD_MS): a new bot's first notice is far likelier than
 * a new orphan.
 */
export function isBotRow(notification: { metadata?: unknown } | null | undefined, orphans: ReadonlySet<string>): boolean {
  const teammate = noticeTeammateId(notification?.metadata)
  return teammate !== null && !orphans.has(teammate)
}

const NO_ORPHANS: ReadonlySet<string> = new Set()

/** A notice naming a teammate the last first page didn't: the first page is read again this long after, so the route sorts it. */
export const UNKNOWN_TEAMMATE_REREAD_MS = 1_000

// ---------------------------------------------------------------------------
// Native desktop notifications
// ---------------------------------------------------------------------------
//
// Inside the Tauri shell, a notification that arrives while the window is NOT
// focused becomes a real OS banner instead of an in-app toast. Everything else
// (plain browser, or desktop-with-focus) keeps the exact toast behaviour it has
// always had.
//
// VERSION SKEW is the governing constraint: dial8.ai deploys ahead of the
// native binary, so an older shell has no `show_native_notification` command
// and every invoke rejects. The first failure — for ANY reason (missing
// command, permission denied, unsupported backend) — permanently disables the
// native path for this page session, so subsequent notifications go straight to
// the toast with no wasted round-trip. Downgrade only, with EXACTLY ONE
// exception: the permission bootstrap re-arms the flag when the OS grants
// permission (see the bootstrap effect below). The flag itself lives in
// native-notification-path so surfaces outside this provider (UI sounds) can
// tell the banner path from the toast path.

/** Show `notification` as a native OS banner. Resolves false when the caller
 *  should toast instead — either the native path is unavailable (now or
 *  previously) or the native side deliberately skipped the banner because a
 *  Native Intelligence window is frontmost. Resolves true when a banner was shown. */
/**
 * What the OS banner for `notification` carries. A notice that names a
 * teammate (bots v3 1b, bot-notice.ts) speaks as its bot: the teammate's name
 * as its title, the bot's sentence as its body (the server wrote both onto the
 * row; read off the metadata again for a row written before), and
 * `payload.bot` says whose item a click opens (NativeNotificationClickHandler):
 * the teammate, its face when this window knows it (notice-faces.ts), and the
 * run. The banner stays the transient kind: nothing here asks for a sticky
 * alert style or a raised interruption level.
 *
 * `threadId` is the teammate's id, so Notification Center stacks each bot's
 * banners together, and `subtitle` is the workspace (`workspaceName`, when
 * known). A notice that names no teammate gets neither. No banner carries an
 * image: the OS draws the app's own icon on every one.
 */
export function nativeNotificationArgs(
  notification: Notification,
  opts: { workspaceName?: string | null } = {},
): {
  id: string
  title: string
  body: string | undefined
  payload: string
  threadId?: string
  subtitle?: string
} {
  const bot = readBotNotice(notification.metadata)
  const copy = speakerCopy(notification)
  const face = bot ? noticeFaceOf(bot.teammate_id) : null
  // An area face's notice speaks as the agent (one face): its stack.
  const speaker = bot ? (noticeSpeakerOf(bot.teammate_id)?.teammateId ?? bot.teammate_id) : null
  const subtitle = bot ? opts.workspaceName?.trim() : undefined
  return {
    ...(speaker ? { threadId: speaker } : {}),
    ...(subtitle ? { subtitle } : {}),
    id: notification.id,
    title: copy.title,
    body: copy.body,
    // Opaque to Rust; handed back verbatim on click and parsed by
    // NativeNotificationClickHandler. Keep these fields in sync with the
    // NotificationLike shape that component reconstructs.
    payload: JSON.stringify({
      notification_id: notification.id,
      type: notification.type,
      workspace_id: notification.workspace_id,
      target_type: notification.target_type,
      target_id: notification.target_id,
      context_type: notification.context_type,
      context_id: notification.context_id,
      metadata: notification.metadata,
      // Carried so a detail panel opened from a native click can label itself
      // with the real notification text instead of an empty string.
      title: notification.title,
      body: notification.body,
      ...(bot
        ? {
            bot: {
              teammate_id: speaker ?? bot.teammate_id,
              face,
              work_item_id: bot.work_item_id ?? null,
            },
          }
        : {}),
    }),
  }
}

/**
 * Where a notice that lands while this window is in front goes:
 *
 *   silent  a bot's notice for a run that left nothing (`quiet`: a skipped
 *           loop): kept in its bot's Notices (bots-v4 Phase 4c), no
 *           toast, no banner.
 *   toast   anything else: an app notice as ever, or a bot's, signed by the
 *           bot (`toastCopy`).
 */
export function noticeSurface(notification: Pick<Notification, 'metadata'>): 'silent' | 'toast' {
  const bot = readBotNotice(notification.metadata)
  return bot?.quiet ? 'silent' : 'toast'
}

/** What a toast says: a bot's notice signed by the bot (its name, its sentence), anything else as it is. */
export function toastCopy(notification: Pick<Notification, 'title' | 'body' | 'metadata'>): { title: string; description: string | undefined } {
  const copy = speakerCopy(notification)
  return { title: copy.title, description: copy.body || undefined }
}

/**
 * A bot's notice's copy (botNoticeCopy), titled with who it speaks as: an area
 * face's notice speaks as the agent, under the agent's name (one face:
 * notice-faces.ts noticeSpeakerOf; the server wrote the area face's name).
 */
export function speakerCopy(notification: Pick<Notification, 'title' | 'body' | 'metadata'>): { title: string; body: string | undefined } {
  const copy = botNoticeCopy(notification.metadata ?? {}, { title: notification.title, body: notification.body })
  const bot = readBotNotice(notification.metadata)
  const speaker = bot ? noticeSpeakerOf(bot.teammate_id) : null
  return speaker ? { ...copy, title: speaker.name } : copy
}

async function tryShowNativeNotification(notification: Notification, workspaceName?: string | null): Promise<boolean> {
  if (areNativeNotificationsDisabled()) return false
  try {
    const shown = await tauriBridge.showNativeNotification(nativeNotificationArgs(notification, { workspaceName }))
    // EXACTLY false = the native side skipped the banner on purpose (a Native Intelligence
    // window is focused, so the in-app toast is the right surface). That is a
    // skip, not a failure: leave nativeNotificationsDisabled alone so later
    // notifications — arriving when the app is NOT frontmost — still go native.
    // Anything else means shown: `true` from current binaries, and
    // `undefined`/`null` from older ones whose command returns unit.
    if (shown === false) return false
    return true
  } catch {
    // A rejection is the real failure signal (missing command on an older
    // shell, permission denied, backend error) — disable the native path for
    // this page session.
    setNativeNotificationsDisabled(true)
    return false
  }
}

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const memberId = useCurrentMemberId()
  // Workspace names by id, for a bot banner's subtitle (phase 7). A ref, so
  // the realtime effect reads the latest without re-subscribing.
  const { workspaces } = useWorkspaces()
  const workspaceNamesRef = useRef<ReadonlyMap<string, string>>(new Map())
  workspaceNamesRef.current = useMemo(() => new Map(workspaces.map((w) => [w.id, w.name])), [workspaces])
  const [notifications, setNotifications] = useState<Notification[]>([])
  // The app-wide switch (lib/workspace-span). A flip re-creates
  // `fetchNotifications`, whose initial-fetch effect re-runs in the new scope:
  // a first-page replace, which also resets the live pool — the two scopes
  // are different result sets, so no row may carry across.
  const workspaceScope: NotificationWorkspaceScope = useShowAllWorkspaces() ? 'all' : 'workspace'
  // The membership set the server read for the CURRENT `all` response. Empty in
  // the default scope and until the first `all` fetch lands — the channel list
  // falls back to the active member id in the meantime, so the window is never
  // deaf while this is in flight.
  const [memberships, setMemberships] = useState<NotificationMembership[]>([])
  // The bots the caller can't reach, as the last first page said: their
  // notices aren't a bot's (bots-v4 Phase 4c). State for the split below, a
  // ref for the realtime handlers.
  const [orphans, setOrphans] = useState<ReadonlySet<string>>(NO_ORPHANS)
  const orphansRef = useRef<ReadonlySet<string>>(NO_ORPHANS)
  // Every teammate the last first page named, either way: one a live notice
  // names that isn't here has the first page read again (UNKNOWN_TEAMMATE_REREAD_MS).
  const knownTeammatesRef = useRef<Set<string>>(new Set())
  // Ids of the LIVE pool: rows that arrived via a realtime INSERT rather than
  // through the server cursor. A Set preserves insertion order, so iterating it
  // yields the live rows oldest-first — which is exactly the eviction order.
  //
  // Provenance is tracked by ID, not by a head-count: rows move (a page appends
  // below them) and disappear (realtime DELETE), so a positional
  // count silently desynchronises while an id set does not. This is in-memory
  // bookkeeping only — never persisted, never rendered. Cleared whenever a
  // page-0 fetch replaces the whole list with a fresh server baseline.
  const liveIdsRef = useRef<Set<string>>(new Set())

  // Mirror of the current list so realtime UPDATE/DELETE handlers can compute
  // the next list without nesting one setState in another, and
  // so `forgetLiveIds` can resolve a predicate against the rows actually held.
  // Assigned on every render (see below `notificationsRef.current = ...`).
  const notificationsRef = useRef<Notification[]>([])

  // Ids this page posted an OS banner for (phase 7). Realtime takes a banner
  // down when its notice turns read, but only on a channel this page still
  // listens to: a notice read while the socket was down, or while you were in
  // another workspace (the default scope listens to the active member only),
  // sends no UPDATE here. Every fetch checks this set, so the banner leaves on
  // the reconnect catch-up or when you come back to that workspace. A gap is
  // left on purpose: a banner from workspace A read while you stay in B stays
  // until you return to A (or open it). In-memory, page session only.
  const postedBannerIdsRef = useRef<Set<string>>(new Set())

  // Drop rows from the list. Pure removal. Used by realtime DELETE.
  //
  // Returning `prev` unchanged when nothing matched keeps the identity stable,
  // so a DELETE for a row we never loaded does not re-render every consumer.
  const removeRows = useCallback(
    (prev: Notification[], shouldRemove: (n: Notification) => boolean): Notification[] => {
      const kept = prev.filter((n) => !shouldRemove(n))
      return kept.length === prev.length ? prev : kept
    },
    [],
  )

  // Forget the live-pool membership of every held row matching the predicate.
  //
  // This runs on the EVENT path, not inside the setState updater it accompanies.
  // React may invoke an updater more than once for the same logical update, and
  // a `Set.delete` replayed against an already-pruned pool is silently wrong
  // (see `admitLiveRow`, where a replay would actually corrupt state by evicting
  // a second batch). Keeping every ref mutation on the event path — invoked
  // exactly once per realtime message — sidesteps the whole question.
  const forgetLiveIds = useCallback((shouldRemove: (n: Notification) => boolean) => {
    for (const n of notificationsRef.current) {
      if (shouldRemove(n)) liveIdsRef.current.delete(n.id)
    }
  }, [])

  // Register a realtime arrival in the live pool and return the ids that must
  // now be evicted to hold the pool at MAX_LIVE_NOTIFICATIONS. Only ids in
  // `liveIdsRef` are ever candidates, so a paged row can never be dropped —
  // which is the whole point of the two pools. Set iteration order is insertion
  // order, so the first entries are the oldest live arrivals.
  //
  // Called once per INSERT on the event path (NOT from inside the updater): the
  // pool is mutated here exactly once, and the updater it feeds is a pure
  // filter over a precomputed id set, so replaying it is harmless.
  const admitLiveRow = useCallback((id: string): Set<string> | null => {
    const live = liveIdsRef.current
    live.add(id)
    const overflow = live.size - MAX_LIVE_NOTIFICATIONS
    if (overflow <= 0) return null
    const evicted = new Set<string>()
    for (const oldest of live) {
      evicted.add(oldest)
      if (evicted.size === overflow) break
    }
    for (const oldest of evicted) live.delete(oldest)
    return evicted
  }, [])

  // The first page: the window's held notices and the bots' newest
  // (bots-v4 Phase 4c), on mount and on a realtime catch-up.
  const fetchNotifications = useCallback(async () => {
    if (!memberId) return
    try {
      // The scope parameter is OMITTED in the default scope, not sent as
      // `workspace_scope=workspace`.
      const scopeParam = workspaceScope === 'all' ? '&workspace_scope=all' : ''
      const res = await fetch(`/api/account/notifications?limit=${PAGE_SIZE}${scopeParam}&include_bots=1`)
      if (res.ok) {
        const data = await res.json()
        const fetched = data.notifications as Notification[]
        const fetchedBots = Array.isArray(data.bot_notifications) ? (data.bot_notifications as Notification[]) : []
        if (Array.isArray(data.bot_teammate_ids)) {
          knownTeammatesRef.current = new Set(
            [...(data.bot_teammate_ids as unknown[]), ...((data.orphan_teammate_ids as unknown[] | undefined) ?? [])].filter(
              (id): id is string => typeof id === 'string',
            ),
          )
        }
        if (Array.isArray(data.orphan_teammate_ids)) {
          const next = new Set((data.orphan_teammate_ids as unknown[]).filter((id): id is string => typeof id === 'string'))
          const same = next.size === orphansRef.current.size && [...next].every((id) => orphansRef.current.has(id))
          if (!same) {
            orphansRef.current = next
            setOrphans(next)
          }
        }
        // A banner this page posted whose notice is now read or archived (an
        // UPDATE this page never heard): take it down (postedBannerIdsRef). A
        // bot's banner too: its notice is read when its item opens.
        const settled = [...fetched, ...fetchedBots]
          .filter((n) => (n.is_read || n.is_archived) && postedBannerIdsRef.current.has(n.id))
          .map((n) => n.id)
        if (settled.length > 0) {
          for (const id of settled) postedBannerIdsRef.current.delete(id)
          void removeDeliveredBanners(settled)
        }
        // Only the `all` response carries the membership set. Replaced only
        // when the member ids actually differ, so a routine fetch does not
        // hand the realtime effect a fresh array and re-subscribe every channel.
        if (Array.isArray(data.memberships)) {
          const next = data.memberships as NotificationMembership[]
          setMemberships((prev) => (sameMemberIds(prev, next) ? prev : next))
        }
        // This page IS the new baseline, so the live pool starts empty again.
        liveIdsRef.current = new Set()
        // The held page, then the bots' notices it doesn't already hold: one
        // held list, which the value splits (`notifications`, `botNotices`).
        const inPage = new Set(fetched.map((n) => n.id))
        setNotifications([...fetched, ...fetchedBots.filter((n) => !inPage.has(n.id))])
      }
    } catch {
      // silently fail
    }
  }, [memberId, workspaceScope])

  // Latest full-reload fn, held in a ref so the realtime effect can call it on
  // recovery without listing it as a dep (which would re-subscribe the channel).
  const refetchRef = useRef<() => Promise<void>>(async () => {})
  refetchRef.current = () => fetchNotifications()

  // Keep the mirror (declared above, alongside the live pool it serves) in step
  // with the rendered list.
  notificationsRef.current = notifications

  // Initial fetch
  useEffect(() => {
    if (memberId) {
      fetchNotifications()
    }
  }, [memberId, fetchNotifications])

  // Native-notification permission bootstrap (desktop only, once per mount).
  // Ask the OS exactly once, and only from the "prompt" state — no custom
  // pre-prompt UI, no nagging. A rejection here means an older native binary
  // without these commands, so we disable the native path outright and every
  // notification keeps toasting as it does today.
  useEffect(() => {
    if (!isDesktopApp()) return
    let cancelled = false

    void (async () => {
      try {
        let state = await tauriBridge.notificationPermissionState()
        if (cancelled) return
        if (state === 'prompt') {
          state = await tauriBridge.requestNotificationPermission()
          if (cancelled) return
        }
        // A settled "denied"/"unsupported" means every showNativeNotification
        // invoke would fail, so skip the doomed round-trip and toast directly.
        // "granted" (immediately, or after the prompt) leaves the native path
        // armed. This is read once per mount: a user who grants permission
        // later in OS settings picks it up on the next page load, which is an
        // acceptable trade for not re-probing on every notification.
        if (state === 'denied' || state === 'unsupported') {
          setNativeNotificationsDisabled(true)
        } else if (state === 'granted') {
          // RE-ARM. A notification that arrived while the OS prompt was still
          // open fails and sets nativeNotificationsDisabled; without this
          // clear, the happy first-run path (grant permission, then get
          // banners) stays broken until the user reloads the page. The flag is
          // downgrade-only EXCEPT this one explicit re-arm on grant.
          setNativeNotificationsDisabled(false)
        }
      } catch {
        setNativeNotificationsDisabled(true)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  // The recipient ids this provider subscribes a realtime channel for.
  //
  // The channel filter is `recipient_id=eq.<id>` — a single value, not a set —
  // so cross-workspace delivery is N channels, one per membership, rather than
  // one widened channel. That is also why the set has to come from the server:
  // the client only ever knows the member id of the ACTIVE workspace.
  //
  //  • default scope → exactly `[memberId]`, i.e. today's single channel;
  //  • `all`, memberships not loaded yet → `[memberId]` as well, so the window
  //    is never deaf while the first fetch is in flight;
  //  • `all`, loaded → the server's set, with the active member id prepended if
  //    the response somehow omits it (a membership created since the fetch).
  //
  // DE-DUPLICATED, and that is load-bearing rather than tidiness. A notification
  // row has exactly ONE recipient_id, so while these filters are distinct a row
  // is delivered on exactly one channel — which is what lets the INSERT handler
  // keep its existing dedup (it reads `notificationsRef`, a render-time mirror,
  // so two INSERTs for the same row in the SAME tick would both pass the guard
  // and toast twice while the list correctly kept one row). Two
  // channels carrying the same filter is the only way to produce that tick, so
  // the invariant is enforced here, at the one place the list is built.
  //
  // Identity-stable while its inputs are (see sameMemberIds), which is what
  // keeps the effect below from re-subscribing on every page fetch.
  const channelMemberIds = useMemo(() => {
    if (!memberId) return []
    if (workspaceScope !== 'all') return [memberId]
    const ids = memberships.map((m) => m.memberId)
    if (ids.length === 0) return [memberId]
    return [...new Set([memberId, ...ids])]
  }, [memberId, workspaceScope, memberships])

  // Supabase Realtime subscription.
  //
  // This is a bespoke channel (not use-realtime-entities.ts) because it's keyed
  // on recipient_id, not workspace_id, and drives its own banner/toast logic.
  // It carries the full new-row for INSERT/UPDATE (migration 187 set REPLICA
  // IDENTITY FULL on notification so filtered UPDATE/DELETE deliver).
  //  • INSERT: prepend + banner or toast.
  //  • UPDATE: patch the row in place (e.g. is_read flipped from another device)
  //    and take its banner down once it is read.
  //  • DELETE: drop the row and its banner.
  // Reliability: refetch on the app-wide `ni:realtime-recovered` event and on
  // this channel's own re-SUBSCRIBE after a failure — events during the gap were
  // lost. (Mirrors use-realtime-entities.ts's hadFailure pattern.)
  //
  // In the `all` scope this is the SAME channel, N times over — one per member
  // id, with identical handlers. Nothing else about the pipeline changes: the
  // two pools and the dedup-by-id are keyed on the notification id, which is
  // unique across workspaces, so N
  // channels feed one list exactly the way one channel fed it.
  useEffect(() => {
    if (channelMemberIds.length === 0) return

    // ONE GAP, ONE CATCH-UP. A single socket repair knocks EVERY channel, so in
    // the `all` scope all N report SUBSCRIBED-after-failure for the same gap —
    // and the catch-up refetch spans every membership anyway, so running it N
    // times would be N-1 wasted page loads. The first channel back claims the
    // catch-up and the rest ride on it.
    //
    // The window matches the dedup window the recovery module already treats as
    // "the same gap" (SELF_REFETCH_WINDOW_MS = 3s), and sits under the
    // watchdog's 5s minimum between repair passes, so two genuinely separate
    // repairs can never be collapsed into one. With a single channel — the
    // default scope — nothing is ever coalesced away.
    const CATCH_UP_COALESCE_MS = 3000
    let lastCatchUpAt = 0
    let rereadTimer: ReturnType<typeof setTimeout> | null = null
    const claimCatchUp = () => {
      const now = Date.now()
      if (now - lastCatchUpAt < CATCH_UP_COALESCE_MS) return false
      lastCatchUpAt = now
      return true
    }

    const supabase = createClient()
    // The dedup key is the FULL channel name (each member id included) — see
    // markSelfRefetched: a workspace switch changes memberId, and a bare literal
    // would let the old member's mark suppress the new member's catch-up. In the
    // `all` scope that matters per MEMBERSHIP too: every channel marks under its
    // own name, so the app-wide echo below is suppressed no matter which one of
    // them got back first.
    const channelNames = channelMemberIds.map((id) => `notifications:${id}`)

    const channels = channelMemberIds.map((recipientId) => {
      const channelName = `notifications:${recipientId}`
      let hadFailure = false
      return supabase
        .channel(channelName)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'notification',
            filter: `recipient_id=eq.${recipientId}`,
          },
          (payload) => {
            const newNotification = payload.new as Notification
            // Dedupe against a row we already hold (e.g. an initial-fetch race).
            if (notificationsRef.current.some((n) => n.id === newNotification.id)) return
            // Provenance: this row did NOT come through the server cursor, so it
            // joins the LIVE pool and becomes the only kind of row the cap may
            // evict. Done HERE, once per message, so the updater below stays a
            // pure function of `prev` and the precomputed `evicted` set (React may
            // replay it). `evicted` holds only live ids — a paged row is
            // untouchable, which is the whole point of the two pools.
            const evicted = admitLiveRow(newNotification.id)
            // Add actor info — won't have joins from realtime, but we can show without
            setNotifications((prev) => {
              if (prev.some((n) => n.id === newNotification.id)) return prev
              const next = [
                { ...newNotification, actor_name: null, actor_avatar: null },
                ...prev,
              ]
              // Evict AFTER the prepend so the newest row always survives.
              return evicted ? next.filter((n) => !evicted.has(n.id)) : next
            })
            // A teammate the last first page didn't name: the route sorts it
            // (a bot's, or an orphan's) in a beat.
            const named = noticeTeammateId(newNotification.metadata)
            if (named && !knownTeammatesRef.current.has(named)) {
              knownTeammatesRef.current.add(named)
              if (rereadTimer) clearTimeout(rereadTimer)
              rereadTimer = setTimeout(() => void refetchRef.current(), UNKNOWN_TEAMMATE_REREAD_MS)
            }

            // The router's banner about a message the agent wrote in the home
            // thread (lib/chat/home-message.ts): the chat on that thread takes
            // the message if its own Realtime bridge missed it (PROD 10-31).
            const homeMessage = homeMessageOfNotice(newNotification)
            if (homeMessage) announceHomeMessage(homeMessage)

            // A delivered reminder is the ONE notification that invalidates other
            // UI: the row it fired from stops being pending, so any header pill or
            // picker still showing it is now stale ("now", plus a Remove row that
            // would match nothing). Nothing else emits this — the cron writes the
            // notification directly — so the realtime arrival is the signal.
            if (
              newNotification.type === 'reminder' &&
              newNotification.target_type &&
              newNotification.target_id &&
              REMINDER_ENTITY_TYPES.includes(newNotification.target_type as ReminderEntityType)
            ) {
              emitReminderChanged(
                newNotification.target_type as ReminderEntityType,
                newNotification.target_id,
              )
            }

            // The toast path carries the UI sound; the native banner makes its
            // own, so that path plays none (announceNotification picks the
            // sound: an agent's notification plays the agent sound).
            //
            // A bot's notice (bots v3 1b) toasts signed by the bot; a quiet
            // one (a run that left nothing) only lands in its bot's Notices
            // (bots-v4 Phase 4c). Any other notice toasts exactly as before
            // (noticeSurface).
            if (noticeSurface(newNotification) === 'silent') return
            const showToast = () => {
              const copy = toastCopy(newNotification)
              toast(copy.title, { description: copy.description })
              announceNotification(newNotification)
            }

            // In the desktop shell, an unfocused window gets a native OS banner
            // instead of a toast the user can't see. Focused (or plain browser)
            // keeps the toast exactly as before. A bot's banner fires the same
            // as any other.
            //
            // `shown === false` now covers TWO cases, and the toast is right for
            // both: the native path was unavailable (failure), or the native side
            // deliberately skipped the banner because a Native Intelligence window turned out to
            // be frontmost after all — this window's document.hasFocus() check and
            // the native focus check can disagree (another Native Intelligence window, or focus
            // regained in between). See tryShowNativeNotification.
            if (isNativeBannerPath()) {
              const workspaceName =
                newNotification.workspace?.name ?? workspaceNamesRef.current.get(newNotification.workspace_id)
              void tryShowNativeNotification(newNotification, workspaceName).then((shown) => {
                if (shown) postedBannerIdsRef.current.add(newNotification.id)
                else showToast()
              })
            } else {
              showToast()
            }
          },
        )
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'notification',
            filter: `recipient_id=eq.${recipientId}`,
          },
          (payload) => {
            const updated = payload.new as Notification
            const old = payload.old as Partial<Notification>
            // Read (its item opened, or read on any device) or archived: its
            // banner leaves Notification Center (phase 7).
            const goneNow = updated.is_read || updated.is_archived
            const goneBefore = old.is_read === true || old.is_archived === true
            if (goneNow && !goneBefore) void removeDeliveredBanners([updated.id])
            // Preserve any locally-joined fields the realtime row lacks — the actor
            // join, and (in the `all` scope) the embedded workspace a banner's
            // subtitle reads. A realtime payload is the raw table row with no
            // joins. Flat setter (never nested inside another) so we don't
            // update one state from inside another's updater.
            setNotifications((prev) =>
              prev.map((n) =>
                n.id === updated.id
                  ? {
                      ...updated,
                      actor_name: n.actor_name,
                      actor_avatar: n.actor_avatar,
                      ...(n.workspace ? { workspace: n.workspace } : {}),
                    }
                  : n,
              ),
            )
          },
        )
        .on(
          'postgres_changes',
          {
            event: 'DELETE',
            schema: 'public',
            table: 'notification',
            filter: `recipient_id=eq.${recipientId}`,
          },
          (payload) => {
            const old = payload.old as Partial<Notification>
            const removedId = old.id
            if (!removedId) return
            // A live row that is deleted server-side must leave the live pool
            // too, or its id would keep occupying an eviction slot.
            forgetLiveIds((n) => n.id === removedId)
            setNotifications((prev) => removeRows(prev, (n) => n.id === removedId))
            void removeDeliveredBanners([removedId])
          },
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED' && hadFailure) {
            hadFailure = false
            // Mark under THIS channel's own name even when a sibling already
            // claimed the refetch: the app-wide echo below checks every name, so
            // whichever channel got back first suppresses the duplicate.
            markSelfRefetched(channelName)
            if (claimCatchUp()) void refetchRef.current()
          } else if (
            status === 'CHANNEL_ERROR' ||
            status === 'TIMED_OUT' ||
            status === 'CLOSED'
          ) {
            hadFailure = true
          }
        })
    })

    // One real repair knocks EVERY channel, so our own re-SUBSCRIBE refetch and
    // the entities channel's fan-out describe the same gap — count it once. The
    // key carries the member id: a workspace switch must not let the previous
    // member's mark suppress the new member's genuine catch-up. With several
    // channels, a mark from ANY of them means this provider has already caught
    // up on that repair — the refetch spans every membership regardless of which
    // channel triggered it.
    const onRecovered = (event: Event) => {
      const repairId = repairIdFromRecoveredEvent(event)
      if (channelNames.some((name) => wasSelfRefetchedRecently(name, repairId))) return
      void refetchRef.current()
    }
    window.addEventListener('ni:realtime-recovered', onRecovered)

    return () => {
      window.removeEventListener('ni:realtime-recovered', onRecovered)
      if (rereadTimer) clearTimeout(rereadTimer)
      for (const channel of channels) supabase.removeChannel(channel)
    }
    // admitLiveRow, forgetLiveIds and removeRows are stable (useCallback []);
    // listing them satisfies the linter without re-subscribing the channels.
    // `channelMemberIds` is memoized on the scope and the membership set, so it
    // only changes when the channel list really must be rebuilt.
  }, [channelMemberIds, admitLiveRow, forgetLiveIds, removeRows])

  const markAsRead = useCallback(async (id: string) => {
    // Optimistic update
    setNotifications((prev) =>
      prev.map((n) =>
        n.id === id ? { ...n, is_read: true, read_at: new Date().toISOString() } : n,
      ),
    )
    // Its banner leaves Notification Center (phase 7). The realtime echo asks
    // again; removing twice is a no-op.
    void removeDeliveredBanners([id])

    // keepalive: a banner click that navigates away at once (a legacy run's
    // page) must not abort the read.
    await fetch(`/api/account/notifications/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_read: true }),
      keepalive: true,
    })
  }, [])

  // One held list, split: the plain notices, and the bots' (bots-v4 Phase 4c).
  // Each keeps the held order (newest first), so neither needs sorting.
  const plainNotifications = useMemo(() => notifications.filter((n) => !isBotRow(n, orphans)), [notifications, orphans])
  const botNotices = useMemo(() => notifications.filter((n) => isBotRow(n, orphans)), [notifications, orphans])

  const value = useMemo(
    () => ({
      notifications: plainNotifications,
      botNotices,
      markAsRead,
      workspaceScope,
    }),
    [plainNotifications, botNotices, markAsRead, workspaceScope],
  )

  return <NotificationCtx.Provider value={value}>{children}</NotificationCtx.Provider>
}
