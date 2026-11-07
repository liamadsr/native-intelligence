'use client'

/**
 * `agent-alert` when a clarifying question (ask_user) arrives
 * in a LIVE chat reply — the moment the QuestionPopover opens for it.
 *
 * Only live arrivals: a question already pending when the panel mounts (chat
 * history, a restored tab, a reload) is remembered as seen and never plays,
 * and so is one that turns up while no reply has streamed for LIVE_GRACE_MS
 * (a chat switched in from history). A question plays once its input is
 * complete (the key is its full text), so a streamed partial never plays.
 *
 * The key is the question's text (`askKey`), the same key a work run's
 * `work_needs_you` notification carries for the question it parked on, so the
 * same question surfacing through both paths is one sound.
 */

import { useEffect, useRef } from 'react'
import { playAlertSound } from './alerts'
import { askKey } from './triggers'

/** How long after the last streamed chunk a new question still counts as live. */
export const ASK_LIVE_GRACE_MS = 4000

const ASK_TOOLS: ReadonlySet<string> = new Set(['ask_user'])
const ANSWERED: ReadonlySet<string> = new Set(['output-available', 'output-error', 'output-denied'])

interface MessageLike {
  role: string
  parts?: ReadonlyArray<unknown>
}

interface PendingAsk {
  toolCallId: string
  /** The input has finished streaming. */
  complete: boolean
  text: string
}

function toolName(part: Record<string, unknown>): string | null {
  if (part.type === 'dynamic-tool') return typeof part.toolName === 'string' ? part.toolName : null
  if (typeof part.type === 'string' && part.type.startsWith('tool-')) return part.type.slice(5)
  return null
}

function asPendingAsk(raw: unknown): PendingAsk | null {
  if (!raw || typeof raw !== 'object') return null
  const part = raw as Record<string, unknown>
  const name = toolName(part)
  if (!name || !ASK_TOOLS.has(name)) return null
  if (typeof part.toolCallId !== 'string' || !part.toolCallId) return null
  const state = typeof part.state === 'string' ? part.state : ''
  if (ANSWERED.has(state)) return null
  const questions = (part.input as { questions?: unknown } | undefined)?.questions
  const first = Array.isArray(questions) ? (questions[0] as { question?: unknown } | undefined) : undefined
  const text = typeof first?.question === 'string' ? first.question : ''
  return { toolCallId: part.toolCallId, complete: state !== 'input-streaming' && text.trim() !== '', text }
}

/** Unanswered asks in `messages` (all of them, or only the current turn's). */
function pendingAsks(messages: ReadonlyArray<MessageLike>, currentTurnOnly: boolean): PendingAsk[] {
  const out: PendingAsk[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user') {
      if (currentTurnOnly) break
      continue
    }
    if (m.role !== 'assistant') continue
    for (const part of m.parts ?? []) {
      const ask = asPendingAsk(part)
      if (ask) out.push(ask)
    }
  }
  return out
}

export function useAskArrivalSound(messages: ReadonlyArray<MessageLike>, status: string): void {
  const seenRef = useRef<Set<string> | null>(null)
  const liveAtRef = useRef(0)

  useEffect(() => {
    const now = Date.now()
    if (status === 'submitted' || status === 'streaming') liveAtRef.current = now
    if (!seenRef.current) {
      // First look: whatever is pending now is history.
      seenRef.current = new Set(pendingAsks(messages, false).map((a) => a.toolCallId))
      return
    }
    const seen = seenRef.current
    const live = now - liveAtRef.current < ASK_LIVE_GRACE_MS
    for (const ask of pendingAsks(messages, true)) {
      if (seen.has(ask.toolCallId) || !ask.complete) continue
      seen.add(ask.toolCallId)
      if (live) void playAlertSound({ sound: 'agent-alert', key: askKey(ask.text) })
    }
  }, [messages, status])
}
