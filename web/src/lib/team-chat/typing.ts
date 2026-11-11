'use client'

/**
 * Team chat's typing line (migration 559): "Rosa is typing…" under a channel
 * or a thread while someone writes there. A Supabase Realtime BROADCAST on
 * the channel's private topic (`team-chat-typing:<channel id>`): no table, no
 * polling, nothing stored. 559's policies let only the channel's readers hear
 * it and its posters say it.
 *
 * Sends are throttled (one per TYPING_THROTTLE_MS while the person keeps
 * typing, and one "stopped" when they send); a typer is shown for
 * TYPING_SHOW_MS after the last word of theirs, then dropped by one timer (no
 * frame loop, no interval). The payload is a member id and the thread, never
 * a name or a word: the page draws the name from its own member list, and
 * ignores its own id.
 *
 * One topic is joined once per page, however many views show the channel (a
 * card and the full page): each joins it here and leaves it, and the last to
 * leave closes it.
 */
import { createClient } from '@/lib/supabase/client'

export const TYPING_EVENT = 'typing'
/** At most one "typing" a person sends in this long. */
export const TYPING_THROTTLE_MS = 2_500
/** How long someone is shown typing after the last word of theirs arrives. */
export const TYPING_SHOW_MS = 4_500

export interface TypingSignal {
  member_id: string
  /** The thread they are typing in (its root), or null for the channel itself. */
  thread: string | null
  /** False: they stopped (sent, or emptied the box). */
  typing: boolean
}

type Listener = (signal: TypingSignal) => void

interface Joined {
  listeners: Set<Listener>
  send: (signal: TypingSignal) => void
  close: () => void
}

const joined = new Map<string, Joined>()

/** The private topic a channel's typing goes over (559's policies read it). */
export function typingTopic(channelId: string): string {
  return `team-chat-typing:${channelId}`
}

/** A payload as a signal, or null when it isn't one (anyone on the topic can send anything). */
export function parseTypingSignal(payload: unknown): TypingSignal | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (typeof p.member_id !== 'string' || !p.member_id) return null
  if (p.thread !== null && p.thread !== undefined && typeof p.thread !== 'string') return null
  return { member_id: p.member_id, thread: typeof p.thread === 'string' ? p.thread : null, typing: p.typing !== false }
}

function open(channelId: string): Joined {
  const supabase = createClient()
  const listeners = new Set<Listener>()
  let channel: ReturnType<typeof supabase.channel> | null = null
  let ready = false
  let closed = false
  // A private channel is joined with the person's own token (559's policies check it).
  void Promise.resolve(supabase.realtime?.setAuth?.())
    .catch(() => {})
    .finally(() => {
      if (closed) return
      channel = supabase
        .channel(typingTopic(channelId), { config: { private: true, broadcast: { self: false } } })
        .on('broadcast', { event: TYPING_EVENT }, (message: { payload?: unknown }) => {
          const signal = parseTypingSignal(message?.payload)
          if (signal) for (const listener of listeners) listener(signal)
        })
        .subscribe((status: string) => {
          ready = status === 'SUBSCRIBED'
        })
    })
  return {
    listeners,
    send: (signal) => {
      if (!ready || !channel) return
      void Promise.resolve(channel.send({ type: 'broadcast', event: TYPING_EVENT, payload: signal })).catch(() => {})
    },
    close: () => {
      closed = true
      if (channel) void supabase.removeChannel(channel)
    },
  }
}

/**
 * Join a channel's typing topic: `onSignal` hears the others; the returned
 * `send` says the person's own; `leave` when done (the last view to leave
 * closes the topic).
 */
export function joinTyping(channelId: string, onSignal: Listener): { send: (signal: TypingSignal) => void; leave: () => void } {
  let entry = joined.get(channelId)
  if (!entry) {
    entry = open(channelId)
    joined.set(channelId, entry)
  }
  const current = entry
  current.listeners.add(onSignal)
  return {
    send: (signal) => current.send(signal),
    leave: () => {
      current.listeners.delete(onSignal)
      if (current.listeners.size === 0 && joined.get(channelId) === current) {
        joined.delete(channelId)
        current.close()
      }
    },
  }
}
