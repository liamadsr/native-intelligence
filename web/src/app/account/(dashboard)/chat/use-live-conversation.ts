import { useEffect, useMemo, useRef, useCallback } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { createClient } from '@/lib/supabase/client'
import { isTeammateReportMessage } from '@/lib/chat/teammate-report'
import { isHomeTurnMessage } from '@/lib/chat/home-turn'
import { isChannelMessageRow } from '@/lib/chat/channel-turn'
import { isRelayMessage } from '@/lib/bots/relay-message'
import { messageTime, withCreatedAt } from '@/lib/chat/message-time'
import { HISTORY_PAGE_SIZE } from '@/lib/chat/history-page'
import { EVE_PROVISIONAL_METADATA_KEY } from '@/lib/chat/eve-message-writer'
import { isHomeAskMessage } from '@/lib/attention/chat-asks'
import { EMAIL_AUTO_ARCHIVE_MESSAGE_KIND } from '@/lib/email/auto-archive-part'
import { ACTION_DONE_MESSAGE_KIND } from '@/lib/email/action-done-part'
import { KEPT_MESSAGE_KIND } from '@/lib/kept-up-to-date/part'
import { LOOK_AHEAD_MESSAGE_KIND } from '@/lib/look-ahead/message-kind'
import { GUEST_MESSAGE_MESSAGE_KIND, GUEST_REQUEST_MESSAGE_KIND } from '@/lib/guests/chat-parts'

/**
 * Realtime bridge from the capture conversation's server-written rows into
 * useChat state (live-agent → chat merge, plan WS-1d).
 *
 * The meeting agent writes assistant messages (greeting, say_to_user, proposal
 * batches, questions) directly into chat_messages (conversation-writer.ts).
 * This hook subscribes to postgres_changes on that conversation and MERGES the
 * rows into the panel's message list:
 *
 *   - merge is BY MESSAGE ID — append if unseen, replace in place on UPDATE
 *     (the rolling proposals card grows by UPDATE). Never a wholesale
 *     setMessages(fetchedList): the in-memory array is the source of truth for
 *     in-flight turns (streaming assistant text has no DB row yet).
 *   - while a turn is streaming/submitted, events are BUFFERED and merged when
 *     the turn settles — a mid-turn splice would tear the visible stream.
 *   - on SUBSCRIBED, a resync fetch closes the mount→SUBSCRIBED gap (rows
 *     written during the handshake are never replayed), merge-by-id only.
 *
 * RLS (auth.uid() = user_id) means events are only ever delivered to the
 * conversation owner — plan D6's v1 audience.
 *
 * A bot's own THREAD (scope 'relays', bots v4 Phase A4) takes only what the
 * main chat's assistant relayed into it (src/lib/bots/bot-relay.ts): the
 * person's message, marked "From your main chat", and the bot's reply, which
 * the server writes (no browser persists a relayed turn). The thread's own
 * turns are its transport's, so it listens for INSERT alone (relay rows carry
 * stable ids and are never updated), and it resyncs on SUBSCRIBED, taking only
 * relay rows, since a kept thread can be shown again without reloading its
 * history. The thread can sit in another
 * workspace than the window, so its resync reads with `workspaceId`.
 *
 * The person's HOME THREAD (scope 'server-turns', A4 slice 5) takes the rows
 * the server writes into it: teammates' reports, the server-written turns
 * that follow them (src/lib/chat/home-turn-server.ts: one batched agent turn
 * after a background helper reports back), and an approval's outcome
 * (src/lib/safety/approvals.ts: `metadata.kind` 'approval_result'). Its own turns are its transport's,
 * so like 'relays' it listens for INSERT alone (both kinds carry stable ids
 * and are never updated) and resyncs on SUBSCRIBED taking only those rows: a
 * server turn can land while the thread sits open in a background tab or in
 * the mount→SUBSCRIBED gap. Never 'all', which would swap the thread's own
 * live turns for their stored copies. It also takes a reply the chat-agent's
 * reply backup wrote (src/lib/chat/reply-backup.ts), but only when the thread
 * doesn't hold that message already: the reply of a turn whose page died, which
 * lands after the reloaded page read its history. A reply this page is
 * rendering keeps its own live copy.
 *
 * Each hook instance takes its own channel topic (`…:<conversation>:<instance>`,
 * as capture-detail-panel does): the browser's Supabase client is a singleton,
 * so two panels on one chat under a shared topic would share one channel, and
 * the first to unmount would remove it from under the other.
 *
 * It hands back {@link LiveConversation}: its gap-closing read on demand
 * (`catchUp`, the same read the SUBSCRIBED resync makes, through the same
 * merge), for when something else says a row landed that the channel may
 * have missed (the router's banner, lib/chat/home-message.ts: PROD
 * 2026-10-31, a home turn never reached the open desktop chat), plus what a
 * caller reports about such a miss: whether a row waits in the mid-turn
 * buffer, and the channel's last status.
 */
export type LiveConversationScope = 'all' | 'relays' | 'server-turns'

/**
 * The 'relays' and 'server-turns' resyncs close a gap (rows written while the
 * channel wasn't up), so they read the thread's newest page, never the whole
 * thread. The home thread ('server-turns') also takes only a row that isn't
 * older than what the chat holds: it opens on the newest page
 * (MAX_LIVE_MESSAGES) and pages back on scroll, and a whole-thread resync
 * appended every older report it didn't hold to the BOTTOM of the chat, under
 * a day line from a week ago (Liam, 2026-10-26: two meeting preps from Oct 18
 * shown below Oct 26's messages). A bot's thread ('relays') loads its whole
 * history (use-teammate-chat.ts loadTeammateHistory), so a relay row it
 * doesn't hold is always new there: never floored.
 */
export const RESYNC_PAGE_SIZE = HISTORY_PAGE_SIZE
/** A resync row this much older than the chat's oldest message is still taken (clock skew between the browser's stamp and the row's). */
export const RESYNC_SKEW_MS = 2 * 60_000
/** With nothing timed in the chat, a resync row from this long before the hook mounted is the newest it takes. */
export const RESYNC_EMPTY_LOOKBACK_MS = 10 * 60_000

/** The time of the oldest message that says one, or null. */
function oldestTime(messages: readonly UIMessage[]): number | null {
  let oldest: number | null = null
  for (const m of messages) {
    const t = messageTime(m)
    if (t !== null && (oldest === null || t < oldest)) oldest = t
  }
  return oldest
}

/** The `metadata.kind` of the bubble an approval's outcome writes into the home thread (src/lib/safety/approvals.ts postHomeResult). */
export const APPROVAL_RESULT_KIND = 'approval_result'

/** True for an approval's outcome bubble (an approved tool ran, or didn't). */
export function isApprovalResultMessage(message: unknown): boolean {
  const meta = (message as { metadata?: unknown } | null)?.metadata
  return !!meta && typeof meta === 'object' && (meta as { kind?: unknown }).kind === APPROVAL_RESULT_KIND
}

/**
 * True when the home thread's 'server-turns' scope takes this row: a
 * teammate's report, a server-written turn (a channel turn's reply included),
 * an approval's outcome, an ask (chat-asks.ts isHomeAskMessage), a guest's
 * note or request, or the person's own message from an outside channel
 * (written by the Slack intake, src/lib/slack/turn.ts, or the SMS webhook,
 * src/lib/sms/deliver.ts; no browser persists it).
 */
export function isServerTurnRow(message: unknown): boolean {
  // P13: what the server asks or tells in the home thread too (an approval, a run's suggestions, a run's notice).
  return (
    isTeammateReportMessage(message) ||
    isHomeTurnMessage(message) ||
    isApprovalResultMessage(message) ||
    isHomeAskMessage(message) ||
    isChannelMessageRow(message) ||
    isMailChangeMessage(message) ||
    isGuestNoteMessage(message)
  )
}

/**
 * A guest's note to the person (message_owner, guests/reach-owner.ts) or a
 * request to reach the agent (guests/activity.ts): the router banners both
 * (reach/route-policy.ts), so the open chat takes them as they land, and a
 * banner's catch-up finds them. Not a guest's activity line: the server
 * rewrites that row in place, and this scope hears inserts only.
 */
function isGuestNoteMessage(message: unknown): boolean {
  const meta = (message as { metadata?: unknown } | null)?.metadata
  const kind = !!meta && typeof meta === 'object' ? (meta as Record<string, unknown>).kind : null
  return kind === GUEST_MESSAGE_MESSAGE_KIND || kind === GUEST_REQUEST_MESSAGE_KIND
}

/**
 * The morning tidy's message (src/lib/email/auto-archive.ts), after the
 * digest, a to-do arriving mail marked done
 * (src/lib/email/action-done-from-mail.ts), a record kept up to date
 * (src/lib/kept-up-to-date/engine.ts), and the evening look-ahead
 * (src/lib/look-ahead/message.ts): each lands while the home thread is open.
 */
function isMailChangeMessage(message: unknown): boolean {
  const meta = (message as { metadata?: unknown } | null)?.metadata
  const kind = !!meta && typeof meta === 'object' ? (meta as Record<string, unknown>).kind : null
  return kind === EMAIL_AUTO_ARCHIVE_MESSAGE_KIND || kind === ACTION_DONE_MESSAGE_KIND || kind === KEPT_MESSAGE_KIND || kind === LOOK_AHEAD_MESSAGE_KIND
}

/** True for a reply the reply backup wrote and no browser has replaced yet (eve-message-writer.ts). */
export function isProvisionalReply(message: unknown): boolean {
  const meta = (message as { metadata?: unknown } | null)?.metadata
  return !!meta && typeof meta === 'object' && (meta as Record<string, unknown>)[EVE_PROVISIONAL_METADATA_KEY] === true
}

/** What the bridge hands back (see the header). Stable for the hook's life: every member reads refs. */
export interface LiveConversation {
  /** Read the conversation's newest rows into the chat now, as the SUBSCRIBED resync does; settles once they are merged (or buffered behind a running turn). */
  catchUp: () => Promise<void>
  /** Whether a row of this id waits in the mid-turn buffer. */
  buffered: (messageId: string) => boolean
  /** The channel's last status ('SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'), or null before it reported one. */
  channelStatus: () => string | null
}

export function useLiveConversation(opts: {
  /** The loaded conversation's id — null disables the bridge entirely. */
  conversationId: string | null
  /** useChat status — buffering gate. */
  status: string
  setMessages: (updater: (prev: UIMessage[]) => UIMessage[]) => void
  /** Mark merged ids as born-saved so autosave never re-persists them. */
  markSaved: (ids: string[]) => void
  /** What to take from the conversation: every server-written row (a live
   *  capture, the onboarding home conversation; the default), only relayed
   *  messages (a bot's own thread), or teammates' reports, server-written
   *  turns and approvals' outcomes (the home thread). */
  scope?: LiveConversationScope
  /** The conversation's workspace, sent on the resync read (a bot's thread in another workspace). */
  workspaceId?: string | null
}): LiveConversation {
  const { conversationId, status, setMessages, markSaved, scope = 'all', workspaceId = null } = opts
  // This instance's channel suffix (see the header): stable for its lifetime.
  const instanceIdRef = useRef<string | null>(null)
  if (instanceIdRef.current === null) instanceIdRef.current = crypto.randomUUID()
  const instanceId = instanceIdRef.current
  // When this instance mounted: the floor of a resync into a chat that holds nothing timed.
  const mountedAtRef = useRef<number | null>(null)
  if (mountedAtRef.current === null) mountedAtRef.current = Date.now()

  const streaming = status === 'streaming' || status === 'submitted'
  const streamingRef = useRef(streaming)
  // Events that arrived mid-turn, keyed by message id (an UPDATE after an
  // INSERT of the same id collapses to the latest payload).
  const bufferRef = useRef(new Map<string, UIMessage>())

  const setMessagesRef = useRef(setMessages)
  const markSavedRef = useRef(markSaved)
  useEffect(() => {
    streamingRef.current = streaming
    setMessagesRef.current = setMessages
    markSavedRef.current = markSaved
  })

  // Ids taken only if the chat doesn't hold them yet (a provisional reply in
  // the 'server-turns' scope): never swapped in for the live message.
  const appendOnlyRef = useRef(new Set<string>())
  // Ids the home thread's gap-closing resync brought: appended only when not
  // older than what the chat holds (see RESYNC_PAGE_SIZE).
  const resyncOnlyRef = useRef(new Set<string>())
  // The open channel's gap-closing read (catchUp), and its last status.
  const resyncRef = useRef<(() => Promise<void>) | null>(null)
  const channelStatusRef = useRef<string | null>(null)

  // Merge a batch of rows into useChat state by message id — append if unseen,
  // replace in place only if the payload changed. Never a wholesale replace, so
  // in-flight (un-persisted) turns survive.
  const mergeIntoChat = useCallback((incoming: UIMessage[]) => {
    if (incoming.length === 0) return
    markSavedRef.current(incoming.map((m) => m.id))
    // Read (and spend) the resync marks here, outside the updater: an updater
    // must be pure, since React may call it twice.
    const fromResync = new Set(incoming.filter((m) => resyncOnlyRef.current.has(m.id)).map((m) => m.id))
    for (const id of fromResync) resyncOnlyRef.current.delete(id)
    setMessagesRef.current((prev) => {
      const byId = new Map(prev.map((m, i) => [m.id, i]))
      let next: UIMessage[] | null = null
      let floor: number | undefined
      for (const msg of incoming) {
        const at = byId.get(msg.id)
        if (fromResync.has(msg.id) && at === undefined) {
          // A row from before what the chat holds belongs to an earlier page, not the bottom.
          floor ??= (oldestTime(prev) ?? (mountedAtRef.current ?? Date.now()) - RESYNC_EMPTY_LOOKBACK_MS) - RESYNC_SKEW_MS
          const t = messageTime(msg)
          if (t !== null && t < floor) continue
        }
        if (at !== undefined && appendOnlyRef.current.has(msg.id)) continue
        if (at !== undefined) {
          const current = (next ?? prev)[at]
          if (JSON.stringify(current) !== JSON.stringify(msg)) {
            next = next ?? [...prev]
            next[at] = msg
          }
        } else {
          next = next ?? [...prev]
          byId.set(msg.id, next.length)
          next.push(msg)
        }
      }
      return next ?? prev
    })
  }, [])

  useEffect(() => {
    if (!conversationId) return
    // This conversation's channel is up: a read still out when it goes (a
    // switch, an unmount) merges nothing into the next one's thread, and a
    // late status from its removal never stands for the next channel's.
    let alive = true
    const setChannelStatus = (subStatus: string) => {
      if (alive) channelStatusRef.current = subStatus
    }

    const acceptRow = (row: { ui_message?: unknown; created_at?: unknown } | null, opts: { resync?: boolean } = {}) => {
      if (!alive) return
      // With its row's time (message-time.ts): the chat's day lines.
      const msg = withCreatedAt(row?.ui_message, row?.created_at) as UIMessage | undefined
      if (!msg?.id) return
      if (scope === 'relays' && !isRelayMessage(msg)) return
      if (scope === 'server-turns' && !isServerTurnRow(msg)) {
        if (!isProvisionalReply(msg)) return
        appendOnlyRef.current.add(msg.id)
      }
      // Only the home thread floors its resync (a bot's thread holds its whole history).
      if (opts.resync && scope === 'server-turns') resyncOnlyRef.current.add(msg.id)
      if (streamingRef.current) {
        bufferRef.current.set(msg.id, msg)
      } else {
        mergeIntoChat([msg])
      }
    }

    channelStatusRef.current = null
    const supabase = createClient()
    if (scope === 'server-turns') {
      // Resync, server-written rows only: a report or a server turn that
      // landed before the channel was up, or that it missed.
      // The newest page only (RESYNC_PAGE_SIZE): never the whole thread.
      const resync = () =>
        fetch(`/api/account/chat-history/${conversationId}?limit=${RESYNC_PAGE_SIZE}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data: { messages?: UIMessage[] } | null) => {
            for (const m of data?.messages ?? []) if (isServerTurnRow(m) || isProvisionalReply(m)) acceptRow({ ui_message: m }, { resync: true })
          })
          .catch(() => {})
      resyncRef.current = resync
      const serverTurns = supabase
        .channel(`server-turns:${conversationId}:${instanceId}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'chat_messages',
            filter: `conversation_id=eq.${conversationId}`,
          },
          (payload) => acceptRow(payload.new as { ui_message?: unknown; created_at?: unknown }),
        )
        .subscribe((subStatus) => {
          setChannelStatus(subStatus)
          if (subStatus !== 'SUBSCRIBED') return
          void resync()
        })
      const buffer = bufferRef.current
      const resyncOnly = resyncOnlyRef.current
      return () => {
        alive = false
        if (resyncRef.current === resync) resyncRef.current = null
        supabase.removeChannel(serverTurns)
        buffer.clear()
        resyncOnly.clear()
      }
    }
    if (scope === 'relays') {
      // Resync, relay rows only: a thread kept from before shows what was
      // relayed into it while nothing showed it.
      const resync = () =>
        fetch(`/api/account/chat-history/${conversationId}?limit=${RESYNC_PAGE_SIZE}`, workspaceId ? { headers: { 'x-workspace-id': workspaceId } } : undefined)
          .then((r) => (r.ok ? r.json() : null))
          .then((data: { messages?: UIMessage[] } | null) => {
            for (const m of data?.messages ?? []) if (isRelayMessage(m)) acceptRow({ ui_message: m }, { resync: true })
          })
          .catch(() => {})
      resyncRef.current = resync
      const relays = supabase
        .channel(`relays:${conversationId}:${instanceId}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'chat_messages',
            filter: `conversation_id=eq.${conversationId}`,
          },
          (payload) => acceptRow(payload.new as { ui_message?: unknown; created_at?: unknown }),
        )
        .subscribe((subStatus) => {
          setChannelStatus(subStatus)
          if (subStatus !== 'SUBSCRIBED') return
          void resync()
        })
      const buffer = bufferRef.current
      return () => {
        alive = false
        if (resyncRef.current === resync) resyncRef.current = null
        supabase.removeChannel(relays)
        buffer.clear()
      }
    }
    // Resync: rows written during the mount→SUBSCRIBED handshake are never
    // replayed. Fetch + merge-by-id (append-missing only) — buffered if a
    // turn is mid-flight, same as live events.
    const resync = () =>
      fetch(`/api/account/chat-history/${conversationId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { messages?: UIMessage[] } | null) => {
          if (!alive) return
          const fetched = data?.messages ?? []
          if (streamingRef.current) {
            for (const m of fetched) if (m?.id) bufferRef.current.set(m.id, m)
          } else {
            mergeIntoChat(fetched)
          }
        })
        .catch(() => {})
    resyncRef.current = resync
    const channel = supabase
      .channel(`live-convo:${conversationId}:${instanceId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chat_messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => acceptRow(payload.new as { ui_message?: unknown; created_at?: unknown }),
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'chat_messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => acceptRow(payload.new as { ui_message?: unknown; created_at?: unknown }),
      )
      .subscribe((subStatus) => {
        setChannelStatus(subStatus)
        if (subStatus !== 'SUBSCRIBED') return
        void resync()
      })

    const buffer = bufferRef.current
    return () => {
      alive = false
      if (resyncRef.current === resync) resyncRef.current = null
      supabase.removeChannel(channel)
      buffer.clear()
    }
  }, [conversationId, scope, workspaceId, instanceId, mergeIntoChat])

  // Flush the mid-turn buffer once the turn settles. Same merge path as live
  // events, so a flush can never clobber messages that arrived while buffered.
  useEffect(() => {
    if (streaming || bufferRef.current.size === 0 || !conversationId) return
    const pending = [...bufferRef.current.values()]
    bufferRef.current.clear()
    mergeIntoChat(pending)
  }, [streaming, conversationId, mergeIntoChat])

  return useMemo<LiveConversation>(
    () => ({
      catchUp: () => resyncRef.current?.() ?? Promise.resolve(),
      buffered: (messageId: string) => bufferRef.current.has(messageId),
      channelStatus: () => channelStatusRef.current,
    }),
    [],
  )
}
