'use client'

import { useEffect, useRef } from 'react'
import type { UIMessage } from '@ai-sdk/react'

/**
 * Skip-race placeholder for conversational onboarding (P1, item 6).
 *
 * When the user lands on the home conversation BEFORE the researcher's brief
 * message exists (the wizard's two beats can finish before one-shot research
 * is terminal — the "skip user" race), this shows a pending assistant bubble
 * that NARRATES research progress rather than a static string (the static
 * version is a visible regression from the old banner's instant render on the
 * common slow-research path). It ages as research advances and is superseded IN
 * PLACE the instant the real brief row arrives.
 *
 * How the in-place swap works with zero coordination:
 *   - the placeholder carries the SAME stable id as the real brief row
 *     (`onboarding-brief-<workspaceId>`), so useLiveConversation's merge-by-id
 *     REPLACES it the moment the Realtime INSERT (or resync fetch) lands.
 *   - the placeholder is client-only and marked saved, so autosave never
 *     persists it (it has no DB row of its own).
 *
 * Narration source: the DURABLE research status (GET /api/account/onboarding),
 * which the wizard's own companion treats as authoritative and reconciles its
 * stream against. We poll it while research is in-flight — a real, aging
 * narration, not the eve NDJSON stream (which is wizard-scoped and must not be
 * dragged into the always-mounted chat panel).
 *
 * Terminal-not-done safety net: finish_research authors a brief on EVERY
 * terminal path (including skipped/light runs), so the real row normally always
 * arrives. Only if research never reaches terminal (a crashed session) does the
 * placeholder, after a hard timeout, settle to an honest generic greeting so
 * the bubble never spins forever.
 */

const POLL_INTERVAL_MS = 2500
/** After this long with no terminal research + no brief row, settle the
 *  placeholder to a generic greeting rather than narrate forever. */
const GIVE_UP_MS = 90_000

type ResearchStatus = 'starting' | 'running' | 'done' | 'skipped' | 'error' | 'failed'

interface OnboardingPayload {
  member?: {
    onboardingProgress?: {
      research?: { status?: ResearchStatus }
    }
  }
}

/** The narration for a given in-flight research status. Ages as research
 *  advances; never claims knowledge it doesn't have. */
function narrate(status: ResearchStatus | undefined): string {
  switch (status) {
    case 'running':
      return 'Give me a sec — I\'m still reading up on your company and setting things up.'
    case 'starting':
    default:
      return 'Getting your workspace set up — one sec.'
  }
}

/** The honest fallback when research never lands a brief (crashed session). */
const GENERIC_GREETING =
  "Welcome in — I'm here to help you get started. Ask me anything, or start your first capture whenever you're ready."

function isTerminal(status: ResearchStatus | undefined): boolean {
  return status === 'done' || status === 'skipped' || status === 'error' || status === 'failed'
}

export function useOnboardingBriefPlaceholder(opts: {
  /** The adopted home conversation id — null disables the placeholder entirely
   *  (not an onboarding first-land). */
  homeConversationId: string | null | undefined
  /** Stable id the real brief row will use — the placeholder shares it so the
   *  real row supersedes it in place. */
  briefMessageId: string | null | undefined
  /** Current messages — to detect when the real brief row has arrived. */
  messages: UIMessage[]
  setMessages: (updater: (prev: UIMessage[]) => UIMessage[]) => void
  /** Mark the placeholder id saved so autosave never persists it. */
  markSaved: (ids: string[]) => void
}) {
  const { homeConversationId, briefMessageId, messages, setMessages, markSaved } = opts

  // Whether the REAL brief row has landed: a message with the stable id that is
  // NOT our placeholder (tagged onboarding_placeholder in metadata).
  const realBriefPresent = briefMessageId
    ? messages.some(
        (m) =>
          m.id === briefMessageId &&
          !(m as { metadata?: { onboarding_placeholder?: boolean } }).metadata
            ?.onboarding_placeholder,
      )
    : false

  const settledRef = useRef(false)
  const startedAtRef = useRef<number | null>(null)
  const setMessagesRef = useRef(setMessages)
  const markSavedRef = useRef(markSaved)
  useEffect(() => {
    setMessagesRef.current = setMessages
    markSavedRef.current = markSaved
  })

  // Upsert the placeholder text (client-only), keyed by the stable brief id.
  const showPlaceholder = useRef<(text: string) => void>(() => {})
  showPlaceholder.current = (text: string) => {
    if (!briefMessageId) return
    markSavedRef.current([briefMessageId])
    setMessagesRef.current((prev) => {
      const at = prev.findIndex((m) => m.id === briefMessageId)
      const msg = {
        id: briefMessageId,
        role: 'assistant' as const,
        parts: [{ type: 'text', text }],
        metadata: { onboarding_home: true, onboarding_placeholder: true },
      } as unknown as UIMessage
      if (at === -1) return [...prev, msg]
      // Don't clobber a real brief row that already replaced us.
      const existing = prev[at] as { metadata?: { onboarding_placeholder?: boolean } }
      if (!existing.metadata?.onboarding_placeholder) return prev
      const next = [...prev]
      next[at] = msg
      return next
    })
  }

  useEffect(() => {
    if (!homeConversationId || !briefMessageId) return
    if (realBriefPresent || settledRef.current) return
    startedAtRef.current = startedAtRef.current ?? Date.now()

    let cancelled = false
    const controller = new AbortController()
    let pollId: ReturnType<typeof setInterval> | null = null
    const stopPolling = () => {
      if (pollId !== null) clearInterval(pollId)
      pollId = null
    }

    const tick = async () => {
      // Settled to the generic greeting: never narrate over it again.
      if (settledRef.current) return stopPolling()
      try {
        const res = await fetch('/api/account/onboarding', {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!res.ok || cancelled) return
        const data = (await res.json()) as OnboardingPayload
        const status = data.member?.onboardingProgress?.research?.status
        // A read in flight when the give-up settled us: the greeting stands.
        if (cancelled || settledRef.current) return

        // Terminal + done means the brief was authored — the Realtime
        // INSERT / resync fetch will deliver the real row; keep the last
        // narration up until it supersedes us. Do nothing more here.
        if (isTerminal(status)) {
          // The brief row supersedes the placeholder via merge-by-id; nothing
          // left to narrate, so stop asking. If it somehow never arrives, the
          // give-up timer below settles us.
          stopPolling()
          return
        }
        // Still in-flight — narrate the current phase (ages over time).
        showPlaceholder.current(narrate(status))
      } catch {
        /* ignore — retried on the next tick */
      }
    }

    // Paint an immediate placeholder so first render is never empty, then poll.
    showPlaceholder.current(narrate('starting'))
    void tick()
    pollId = setInterval(() => void tick(), POLL_INTERVAL_MS)

    // Give-up: if no real brief and no terminal-done within the window, settle
    // to the honest generic greeting so the bubble never spins forever.
    const giveUpId = setTimeout(() => {
      if (cancelled || realBriefPresent) return
      settledRef.current = true
      stopPolling()
      showPlaceholder.current(GENERIC_GREETING)
    }, GIVE_UP_MS)

    return () => {
      cancelled = true
      controller.abort()
      stopPolling()
      clearTimeout(giveUpId)
    }
  }, [homeConversationId, briefMessageId, realBriefPresent])
}
