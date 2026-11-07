'use client'

/**
 * Spoken asks (Interactive mode) in one ChatPanel: following the reply to a
 * turn the panel sent for one (@/lib/voice/voice-ask-delivery), and reporting
 * back on its delivery, so Interactive mode knows when to open its follow-up
 * window (components/read-aloud/interactive-voice-host.tsx).
 *
 * The turn is the one whose user message is the first new one after the
 * send (none of the messages the chat had just before it: by id, since
 * retention may trim the head of the thread); its reply, the assistant
 * messages after it. Read-aloud follows that reply (the panel calls followNextTurn
 * before sending), so:
 *   speaking()          read-aloud shows one of the reply's messages speaking;
 *   settle('spoken')    it stops showing it once the turn is over;
 *   settle('interrupted') it stops while the turn still streams (another
 *                       reader, a new turn), or the host cut it (onInterrupt:
 *                       a barge-in, which stops the reading here);
 *   settle('silent')    the turn ended with nothing read aloud (no text, or no
 *                       read-aloud here), after VOICE_ASK_SETTLE_GRACE_MS for its
 *                       last sentences to start;
 *   settle('failed')    it ended in an error, its turn never showed up
 *                       (VOICE_ASK_START_TIMEOUT_MS), or the panel went away.
 * A newer ask takes over: the older one is settled `interrupted`.
 *
 * `ownsBusyTurn` says whether the chat's latest turn is a spoken ask's, so a
 * new ask replaces it (as voice mode's turns do) instead of waiting for it.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import type { ReadAloudHandle } from '@/hooks/use-read-aloud'
import type { VoiceAskDelivery, VoiceAskOutcome } from '@/lib/voice/voice-ask-delivery'

type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error'
const isBusy = (s: ChatStatus) => s === 'submitted' || s === 'streaming'

/** The turn over with nothing read aloud: wait this long for its last sentences to start. */
export const VOICE_ASK_SETTLE_GRACE_MS = 400
/** The turn never showed up in the chat this long after the send: it failed. */
export const VOICE_ASK_START_TIMEOUT_MS = 20_000

interface Tracked {
  delivery: VoiceAskDelivery
  /** The messages the chat had just before the send. */
  before: ReadonlySet<string>
  /** Its user message, once it is in the chat. */
  userId: string | null
  /** Read-aloud showed its reply speaking. */
  spoke: boolean
  timer: ReturnType<typeof setTimeout> | null
}

export interface VoiceAskReplies {
  /** Follow the reply to the turn about to be sent for `delivery`, the chat
   *  holding `before` just before the send. */
  track: (delivery: VoiceAskDelivery, before: readonly UIMessage[]) => void
  /** The send didn't happen after all: settle `delivery` with `outcome`. */
  drop: (delivery: VoiceAskDelivery, outcome: VoiceAskOutcome) => void
  /** The chat's latest turn is a spoken ask's. */
  ownsBusyTurn: () => boolean
}

export function useVoiceAskReplies({
  messages,
  status,
  readAloud,
}: {
  messages: UIMessage[]
  status: ChatStatus
  readAloud: ReadAloudHandle
}): VoiceAskReplies {
  const trackedRef = useRef<Tracked | null>(null)
  /** The user message of the latest spoken ask's turn. */
  const voiceUserIdRef = useRef<string | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const statusRef = useRef(status)
  statusRef.current = status
  const readAloudRef = useRef(readAloud)
  readAloudRef.current = readAloud

  const settle = useCallback((t: Tracked, outcome: VoiceAskOutcome) => {
    if (trackedRef.current !== t) return
    trackedRef.current = null
    if (t.timer) clearTimeout(t.timer)
    t.delivery.settle(outcome)
  }, [])

  const track = useCallback(
    (delivery: VoiceAskDelivery, before: readonly UIMessage[]) => {
      const previous = trackedRef.current
      if (previous) settle(previous, 'interrupted')
      const t: Tracked = { delivery, before: new Set(before.map((m) => m.id)), userId: null, spoke: false, timer: null }
      trackedRef.current = t
      // A barge-in: the desktop has silenced the reply; stop following it.
      delivery.onInterrupt(() => {
        if (trackedRef.current !== t) return
        readAloudRef.current.interrupt()
        settle(t, 'interrupted')
      })
      t.timer = setTimeout(() => {
        if (t.userId === null) settle(t, 'failed')
      }, VOICE_ASK_START_TIMEOUT_MS)
    },
    [settle],
  )

  const drop = useCallback(
    (delivery: VoiceAskDelivery, outcome: VoiceAskOutcome) => {
      const t = trackedRef.current
      if (t?.delivery === delivery) settle(t, outcome)
      else delivery.settle(outcome)
    },
    [settle],
  )

  const ownsBusyTurn = useCallback(() => {
    const list = messagesRef.current
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === 'user') return voiceUserIdRef.current !== null && list[i].id === voiceUserIdRef.current
    }
    return false
  }, [])

  const speakingId = readAloud.speakingMessageId
  useEffect(() => {
    const t = trackedRef.current
    if (!t) return
    if (t.userId === null) {
      const mine = messages.find((m) => m.role === 'user' && !t.before.has(m.id))
      if (!mine) return
      t.userId = mine.id
      voiceUserIdRef.current = mine.id
    }
    const busy = isBusy(status)
    const userAt = messages.findIndex((m) => m.id === t.userId)
    const replyIds = new Set(
      userAt < 0 ? [] : messages.slice(userAt + 1).flatMap((m) => (m.role === 'assistant' ? [m.id] : [])),
    )
    const speakingReply = speakingId !== null && replyIds.has(speakingId)
    if (speakingReply && !t.spoke) {
      t.spoke = true
      t.delivery.speaking()
    }
    if (t.spoke) {
      if (!speakingReply) settle(t, busy ? 'interrupted' : 'spoken')
      return
    }
    if (busy) return
    // Over, with nothing read aloud yet: the last sentences may start a moment
    // after the stream settles.
    if (t.timer) clearTimeout(t.timer)
    t.timer = setTimeout(() => {
      if (trackedRef.current !== t || t.spoke) return
      settle(t, statusRef.current === 'error' ? 'failed' : 'silent')
    }, VOICE_ASK_SETTLE_GRACE_MS)
  }, [messages, status, speakingId, settle])

  // The panel going away: nothing will report on it any more.
  useEffect(
    () => () => {
      const t = trackedRef.current
      if (t) settle(t, 'failed')
    },
    [settle],
  )

  return useMemo(() => ({ track, drop, ownsBusyTurn }), [track, drop, ownsBusyTurn])
}
