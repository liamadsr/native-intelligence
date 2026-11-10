'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  markSelfRefetched,
  wasSelfRefetchedRecently,
  repairIdFromRecoveredEvent,
} from '@/lib/supabase/realtime-recovery'

// Channel name doubles as the self-refetch dedup key (see markSelfRefetched).
const IN_APP_MESSAGES_CHANNEL = 'in-app-messages'

// ---------------------------------------------------------------------------
// In-app message channel
//
// Admin-sent, account-tied messages (announcements, tips, feedback prompts)
// live in `in_app_messages`. This provider keeps the user's messages live and
// drives the toast → popup delivery channel. It is deliberately SEPARATE from
// the workspace-scoped notification system: announcements/tips never touch the
// inbox; only feedback prompts also get a companion inbox notification.
//
// `in_app_messages` IS on the Realtime publication (migration 003), RLS-scoped
// to the owning user — so a new message arrives instantly via a postgres_changes
// INSERT subscription. A slow poll (5 min) + focus refetch remain as a fallback
// for missed events (dropped socket) and for cross-tab dismiss/read consistency.
// ---------------------------------------------------------------------------

export type InAppMessageType = 'announcement' | 'tip' | 'feedback_prompt'

export interface MessageResponse {
  id: string
  rating: number | null
  response_text: string | null
  feature_request_id: string | null
  created_at: string
}

export interface InAppMessage {
  id: string
  message_title: string
  message_body: string
  message_type: string
  cta_text: string | null
  cta_action: string | null
  cta_url: string | null
  priority: string
  status: string
  created_at: string
  message_responses?: MessageResponse[]
}

interface InAppMessageContextValue {
  /** All non-dismissed, non-expired messages for the user. */
  messages: InAppMessage[]
  /** The message currently shown in the detail popup, if any. */
  openMessage: InAppMessage | null
  /** Open the detail popup for a message and mark it read. */
  open: (id: string) => void
  /** Close the detail popup (does not change status). */
  close: () => void
  /** Mark a message delivered (a toast was shown for it). */
  markDelivered: (id: string) => void
  /** Dismiss a message — removes it from the channel for good. */
  dismiss: (id: string) => void
  /** Re-fetch (e.g. after answering a feedback prompt). */
  refetch: () => Promise<void>
}

const InAppMessageCtx = createContext<InAppMessageContextValue>({
  messages: [],
  openMessage: null,
  open: () => {},
  close: () => {},
  markDelivered: () => {},
  dismiss: () => {},
  refetch: async () => {},
})

export function useInAppMessages() {
  return useContext(InAppMessageCtx)
}

/** A message should still surface (toast/popup) until it's been read,
 *  responded to, or dismissed. `pending`/`delivered` are pre-read states. */
export function isUnseen(m: InAppMessage): boolean {
  return m.status !== 'read' && m.status !== 'responded' && m.status !== 'dismissed'
}

// Realtime handles instant delivery; this poll is only a safety net for events
// missed during a dropped socket, so it can be slow.
const POLL_MS = 5 * 60_000

/** Structural equality over parsed JSON (primitives, arrays, plain objects).
 *  Deliberately a FULL comparison rather than id/status only: the route selects
 *  `*, message_responses(*)`, so an admin edit or a new response must still
 *  reach consumers. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bb = b as unknown[]
    return a.length === bb.length && a.every((v, i) => sameJson(v, bb[i]))
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ka = Object.keys(ao)
  if (ka.length !== Object.keys(bo).length) return false
  return ka.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && sameJson(ao[k], bo[k]))
}

/** Keep the previous array when a refetch brought back exactly the same
 *  messages, so focus / poll refetches don't re-render every consumer. */
export function keepIfUnchanged(prev: InAppMessage[], next: InAppMessage[]): InAppMessage[] {
  return sameJson(prev, next) ? prev : next
}

export function InAppMessageProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = useState<InAppMessage[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  // Track ids we've already toasted this session so a re-poll doesn't double-toast
  // a message whose status hasn't flipped to `delivered` yet (the PATCH is async).
  const toastedRef = useRef<Set<string>>(new Set())

  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetch('/api/account/messages')
      if (res.ok) {
        const data = await res.json()
        const next = (data.messages ?? []) as InAppMessage[]
        // A focus / poll refetch usually returns the same rows; keeping the
        // old array identity leaves the memoized context value unchanged.
        setMessages((prev) => keepIfUnchanged(prev, next))
      }
    } catch {
      // silently fail — polling will retry
    }
  }, [])

  // Initial fetch + slow polling + refetch on focus. fetchMessages only calls
  // setState after an awaited network round-trip (never synchronously in this
  // effect), so the cascading-render concern the rule guards against doesn't
  // apply here — this is the documented "subscribe to an external system" case.
  useEffect(() => {
    fetchMessages()
    const interval = setInterval(fetchMessages, POLL_MS)
    const onFocus = () => fetchMessages()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [fetchMessages])

  // Realtime: instant delivery of a freshly-sent message. in_app_messages is
  // RLS-scoped to the owning user (migration 003), so an unfiltered subscription
  // only delivers this user's rows. A raw INSERT row has no joined
  // message_responses yet — fine, a brand-new message has none.
  //  • Skip rows already held (poll/realtime race), already dismissed, or expired
  //    — mirrors what /api/account/messages returns.
  // Reliability: refetch on this channel's re-SUBSCRIBE after a failure and on
  // the app-wide `ni:realtime-recovered` — INSERTs during a gap were lost.
  useEffect(() => {
    let hadFailure = false
    const supabase = createClient()
    const channel = supabase
      .channel(IN_APP_MESSAGES_CHANNEL)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'in_app_messages' },
        (payload) => {
          const row = payload.new as InAppMessage & {
            status?: string
            expires_at?: string | null
          }
          if (row.status === 'dismissed') return
          if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return
          setMessages((prev) =>
            prev.some((m) => m.id === row.id) ? prev : [row, ...prev],
          )
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED' && hadFailure) {
          hadFailure = false
          markSelfRefetched(IN_APP_MESSAGES_CHANNEL)
          void fetchMessages()
        } else if (
          status === 'CHANNEL_ERROR' ||
          status === 'TIMED_OUT' ||
          status === 'CLOSED'
        ) {
          hadFailure = true
        }
      })

    // One real repair knocks EVERY channel, so our own re-SUBSCRIBE refetch and
    // the entities channel's fan-out describe the same gap — count it once.
    const onRecovered = (event: Event) => {
      // Match on the event's repair id, not just the time window: a SECOND real
      // repair inside the same 3s window is a different gap and must still be
      // caught up.
      if (wasSelfRefetchedRecently(IN_APP_MESSAGES_CHANNEL, repairIdFromRecoveredEvent(event))) return
      void fetchMessages()
    }
    window.addEventListener('ni:realtime-recovered', onRecovered)

    return () => {
      window.removeEventListener('ni:realtime-recovered', onRecovered)
      supabase.removeChannel(channel)
    }
  }, [fetchMessages])

  const patchStatus = useCallback(
    async (id: string, status: 'delivered' | 'read' | 'dismissed') => {
      await fetch(`/api/account/messages/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      }).catch(() => {})
    },
    [],
  )

  const markDelivered = useCallback(
    (id: string) => {
      if (toastedRef.current.has(id)) return
      toastedRef.current.add(id)
      // Optimistic local bump so an in-flight popup-open still reads the right state.
      setMessages((prev) =>
        prev.map((m) => (m.id === id && m.status === 'pending' ? { ...m, status: 'delivered' } : m)),
      )
      patchStatus(id, 'delivered')
    },
    [patchStatus],
  )

  const open = useCallback(
    (id: string) => {
      setOpenId(id)
      // Announcements/tips are "done" once opened, so mark them read (which
      // also stops re-toasting). A feedback prompt is NOT done on open — its
      // only terminal states are responded/dismissed — so leave it unseen so it
      // keeps re-surfacing until the user actually answers or dismisses it.
      setMessages((prev) => {
        const target = prev.find((m) => m.id === id)
        if (target && target.message_type === 'feedback_prompt') return prev
        return prev.map((m) => (m.id === id ? { ...m, status: 'read' } : m))
      })
      const target = messages.find((m) => m.id === id)
      if (target?.message_type !== 'feedback_prompt') {
        patchStatus(id, 'read')
      }
    },
    [messages, patchStatus],
  )

  const close = useCallback(() => setOpenId(null), [])

  const dismiss = useCallback(
    (id: string) => {
      setMessages((prev) => prev.filter((m) => m.id !== id))
      setOpenId((cur) => (cur === id ? null : cur))
      patchStatus(id, 'dismissed')
    },
    [patchStatus],
  )

  const openMessage = useMemo(
    () => messages.find((m) => m.id === openId) ?? null,
    [messages, openId],
  )

  const value = useMemo(
    () => ({ messages, openMessage, open, close, markDelivered, dismiss, refetch: fetchMessages }),
    [messages, openMessage, open, close, markDelivered, dismiss, fetchMessages],
  )

  return <InAppMessageCtx.Provider value={value}>{children}</InAppMessageCtx.Provider>
}
