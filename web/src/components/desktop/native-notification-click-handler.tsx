'use client'

import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { tauriBridge } from '@/lib/tauri-bridge'
import { listenScoped } from '@/lib/tauri-unlisten'
import { isDesktopApp } from '@/lib/platform'
import { useWorkspaces } from '@/app/account/workspace-switcher'
import { resolveNotificationDetailPanel } from '@/app/account/notification-panel'
import { openNotificationTarget } from '@/app/account/notification-open'
import { openHrefInWorkspace } from '@/app/account/open-href-in-workspace'
import { openHomeThread } from '@/lib/chat/home-thread-client'
import { homeMessageOfNotice, type HomeMessageRef } from '@/lib/chat/home-message'
import { useNotifications } from '@/app/account/notification-context'
import { useOpenWorkItem } from '@/hooks/use-open-teammate'

/**
 * Routes clicks on NATIVE OS notification banners (macOS Notification Center /
 * Windows toast) raised by NotificationProvider while the window was unfocused.
 *
 * Rust focuses the window and emits `notification-clicked` with the opaque
 * payload string we handed it at send time; this component parses it back into
 * a notification-shaped object and opens what it is about as a card in the
 * chat (openNotificationTarget). Clicked is read: the agent then knows the
 * person saw it (agent-events/freshness.ts) and doesn't tell it again.
 *
 * Cold start: Rust buffers clicks until `notifyNotificationClickListenerReady`
 * arrives, so we register the listener FIRST and only then announce readiness
 * (same handshake as the agent-HUD nudge buffer).
 *
 * Payload-agnostic by design — no per-notification-type logic lives here, so
 * new notification types route correctly with zero changes on this side. A
 * target that is a work item opens where any work item opens (bots-v4.md
 * Phase 2, useOpenWorkItem): on its bot's page, else on its own card. What
 * no card draws (a digest, an unknown type, a lost payload) opens the home
 * thread, where the agent tells the person what happened: there is no
 * notifications page (docs/plans/retire-notifications-page.md).
 *
 * A banner can outlive the workspace it was raised in (the notification channel
 * is per-member, the OS notification center keeps banners around), so every
 * card it opens carries the notification's own workspace: the click switches
 * into it first and opens there.
 *
 * Mount this once inside DashboardShell, inside MainChatProvider (the cards are
 * put in its chats). No-op on the web.
 */

/** The subset of a notification row `resolveNotificationDetailPanel` needs,
 *  reconstructed from the payload Rust echoes back. Mirrors the object built in
 *  notification-context.tsx's tryShowNativeNotification. */
interface NotificationLike {
  /** The notification's id, to read it on click. Absent in older payloads. */
  id: string | null
  type?: string
  /** Workspace the notification belongs to. Absent in older payloads (before
   *  this field existed) — treated as null, same degrade-gracefully rule as
   *  `title`/`body` above. Used only to decide which workspace the click opens
   *  in; it never reaches resolveNotificationDetailPanel. */
  workspace_id: string | null
  metadata?: Record<string, unknown>
  target_type: string | null
  target_id: string | null
  context_type: string | null
  context_id: string | null
  title: string
  body: string | null
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/** Parse the opaque payload string into a NotificationLike, or null if it is
 *  missing/garbage (cold start with lost user-info, or a shape we don't know) —
 *  the caller then just opens the home thread. */
function parsePayload(payload: string | null): NotificationLike | null {
  if (!payload) return null
  try {
    const raw: unknown = JSON.parse(payload)
    if (!raw || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    return {
      id: asStringOrNull(o.notification_id),
      type: typeof o.type === 'string' ? o.type : undefined,
      workspace_id: asStringOrNull(o.workspace_id),
      metadata:
        o.metadata && typeof o.metadata === 'object' && !Array.isArray(o.metadata)
          ? (o.metadata as Record<string, unknown>)
          : undefined,
      target_type: asStringOrNull(o.target_type),
      target_id: asStringOrNull(o.target_id),
      context_type: asStringOrNull(o.context_type),
      context_id: asStringOrNull(o.context_id),
      // Sent verbatim by tryShowNativeNotification; they only feed the detail
      // panel's label. Absent (older payload shape) degrades to the previous
      // empty-label behaviour rather than failing the parse.
      title: typeof o.title === 'string' ? o.title : '',
      body: asStringOrNull(o.body),
    }
  } catch {
    return null
  }
}

/**
 * The home thread, the click's home when nothing more particular opens: where
 * the agent tells the person what happened. Another workspace's opens there,
 * switched to first (the dashboard's one chat is its home thread, loaded
 * afresh with its newest messages). A banner about a message the agent wrote
 * there (`about`, lib/chat/home-message.ts) opens on that message, brought in
 * when the chat lacks it: showing the thread alone did nothing when the chat
 * was on it already (PROD 2026-10-31).
 */
function openHome(workspaceId: string | null, currentId: string | null, about: HomeMessageRef | null = null): void {
  if (workspaceId && workspaceId !== currentId) void openHrefInWorkspace(workspaceId, '/account', currentId)
  else openHomeThread(about ? { reveal: { messageId: about.messageId } } : {})
}

/** A bot's banner: whose page a click opens its item on (bots v3 1b; notification-context.tsx nativeNotificationArgs `payload.bot`). */
interface BannerBot {
  teammateId: string
  /** Its face as the window that raised it knew it; null when it didn't. */
  face: string | null
  workItemId: string | null
}

/** The bot a banner speaks for, off its payload, or null (an app notice, an older payload, garbage). */
export function parseBot(payload: string | null): BannerBot | null {
  if (!payload) return null
  try {
    const raw = JSON.parse(payload) as Record<string, unknown> | null
    const bot = raw && typeof raw === 'object' ? (raw.bot as Record<string, unknown> | undefined) : undefined
    if (!bot || typeof bot !== 'object') return null
    const teammateId = asStringOrNull(bot.teammate_id)
    if (!teammateId) return null
    return {
      teammateId,
      face: asStringOrNull(bot.face),
      workItemId: asStringOrNull(bot.work_item_id),
    }
  } catch {
    return null
  }
}

export function NativeNotificationClickHandler() {
  const { workspaces, currentId } = useWorkspaces()
  const { markAsRead } = useNotifications()
  const openWorkItem = useOpenWorkItem()
  const workspacesRef = useRef(workspaces)
  const currentIdRef = useRef(currentId)
  const markAsReadRef = useRef(markAsRead)
  const openWorkItemRef = useRef(openWorkItem)
  useEffect(() => {
    workspacesRef.current = workspaces
    currentIdRef.current = currentId
    markAsReadRef.current = markAsRead
    openWorkItemRef.current = openWorkItem
  }, [workspaces, currentId, markAsRead, openWorkItem])

  useEffect(() => {
    if (!isDesktopApp()) return

    let active = true

    const stop = listenScoped((gate) => {
      const onClick = gate(async ({ payload }: { id: string; payload: string | null }) => {
        const notification = parsePayload(payload)
        // No recoverable payload: just show the home thread.
        if (!notification) {
          openHome(null, currentIdRef.current)
          return
        }

        // Clicked is read, any banner's (a bot's included, bots v3 1b). What
        // it's about then opens as any notice's does: a work item on its
        // bot's page.
        const bot = parseBot(payload)
        if (notification.id) void markAsReadRef.current(notification.id)

        // An agent_run WITHOUT action context has no card, only the
        // standalone run page, so it hard-navigates. Everything else opens as
        // a card.
        //
        // The hard navigation writes the run's workspace first, so a run
        // belonging to another workspace switches FIRST: /account/agent-runs/<id> renders
        // on the server against the workspace cookie, so navigating straight
        // there from workspace A would look up B's run id in A and render "run
        // not found". With no workspace id to aim at (an older payload and a
        // cache that hasn't loaded) there is nothing to switch to, so the
        // plain assign stands.
        if (
          notification.target_type === 'agent_run' &&
          notification.target_id &&
          !(notification.context_type === 'action' && notification.context_id)
        ) {
          const href = `/account/agent-runs/${notification.target_id}`
          const runWorkspaceId = notification.workspace_id ?? currentIdRef.current
          if (runWorkspaceId) void openHrefInWorkspace(runWorkspaceId, href, currentIdRef.current)
          else window.location.assign(href)
          return
        }

        // CROSS-WORKSPACE CLICK. The realtime channel that raises native
        // banners is per-MEMBER (`notifications:${memberId}`) and re-subscribes
        // on a workspace switch, so a banner raised while the user was in
        // workspace A can still be sitting in the OS notification center after
        // they've moved on to workspace B. Clicking it must open A's item in A:
        // the card carries A, which is switched to first, so it is never
        // resolved against B's data.
        //
        // The one case that still can't be opened is a workspace the user is no
        // longer a member of: there is nothing to switch into, so the click
        // stays informational (toast + this workspace's home thread) rather
        // than a no-op.
        const foreignWorkspaceId =
          notification.workspace_id && notification.workspace_id !== currentIdRef.current
            ? notification.workspace_id
            : null
        if (foreignWorkspaceId && !workspacesRef.current.some((w) => w.id === foreignWorkspaceId)) {
          toast('This notification is from another workspace')
          openHome(null, currentIdRef.current)
          return
        }

        // Resolved BEFORE the switch, which is safe because
        // resolveNotificationDetailPanel is a pure mapping of the payload's own
        // target/context fields for every type but `share` — that one branch
        // fetches the share row, and a foreign share's fetch simply misses and
        // falls through to the unresolvable case below (the home thread, in the
        // right workspace) rather than resolving to something wrong.
        let dp: Awaited<ReturnType<typeof resolveNotificationDetailPanel>> = null
        try {
          dp = await resolveNotificationDetailPanel(notification)
        } catch {
          dp = null
        }
        if (!active) return

        // A work item: where any work item opens (bots-v4.md Phase 2), on its
        // bot's page, else on its own card in its own workspace. Its teammate,
        // when the banner names its bot, is what the source doesn't say
        // otherwise; a plain notice's is looked up.
        if (dp?.type === 'work_item') {
          openWorkItemRef.current(dp.id, [], {
            workspaceId: notification.workspace_id ?? currentIdRef.current,
            title: dp.title,
            ...(bot ? { teammateId: bot.teammateId } : {}),
          })
          return
        }

        // What it is about, as a card (in its own workspace); an
        // unresolvable target (a digest, unknown types) still opens the home
        // thread: a native click should never be a no-op.
        if (dp && openNotificationTarget(dp, { foreignWorkspaceId })) return
        openHome(foreignWorkspaceId, currentIdRef.current, homeMessageOfNotice(notification))
      })
      return tauriBridge.onNotificationClicked(onClick).then((fn) => {
        // Listener is live: let Rust flush anything buffered from a cold-start
        // click. A rejection means an older native binary without the command;
        // harmless, there is nothing to flush there either. (Already cleaned
        // up: listenScoped unlistens it a tick later, nothing to flush.)
        if (active) void tauriBridge.notifyNotificationClickListenerReady().catch(() => {})
        return fn
      })
    })

    return () => {
      active = false
      // Tell Rust this window no longer has a live click listener. Without it,
      // Rust keeps this window in its ready set and emits clicks into a webview
      // that will never handle them (silently lost). Rust's `on_page_load` hook
      // covers hard navigations/reloads; this covers the SPA-unmount edge, where
      // the page stays put but the component goes away.
      // Fire-and-forget: older native binaries have no such command and reject.
      void tauriBridge.notifyNotificationClickListenerGone().catch(() => {})
      stop()
    }
  }, [])

  return null
}
