'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * F2 — client adoption of the durable home conversation on first land
 * (conversational onboarding, "the dashboard is the reveal").
 *
 * On a fresh account's first landing there is NO client conversation id
 * (the device has no main chat stored yet). When the member just finished
 * onboarding, the signup researcher's brief was written into (or is being
 * written into) their HOME thread (`chat_conversations.is_home`, migration
 * 330: the one conversation per person per workspace, A3). This hook
 * discovers that conversation (POST /api/account/chat-history/home) and
 * returns its id so the main chat runs it in onboarding mode (the
 * Realtime bridge takes every row and the brief placeholder). The
 * main chat is the home thread anyway (one-chat Slice 1); the brief then renders via the resync fetch (if already written) or
 * arrives live via Realtime INSERT (the skip-race, if the researcher finishes
 * after land).
 *
 * ADOPT AT MOST ONCE — three guards so a returning user is NEVER hijacked:
 *   1. `alreadyPersistedConversation` — the caller passes true when the client
 *      already has a persisted conversationId (localStorage). We no-op; the
 *      user's own thread wins, forever.
 *   2. A per-workspace localStorage "adopted" bit — set the instant we adopt, so
 *      a later boot does NOT re-run the onboarding mode.
 *   3. A recent-completion window — only adopt within RECENT_COMPLETION_MS of
 *      onboarding_completed_at, so a long-dormant account that cleared its
 *      localStorage doesn't get an empty onboarding conversation forced open.
 *
 * Returns null until (and unless) adoption applies. Adoption also requires
 * onboarding_progress.research to exist — i.e. the researcher actually ran, so
 * there's a brief (or a pending one) to reveal.
 *
 * The returned id is scoped to the workspace it was adopted in: a workspace
 * switch resets it to null first, so a stale adoption from workspace A can
 * never bind into B's chat (the per-workspace adopt-once bit still stops A
 * from being re-adopted when the user comes back).
 */

/** How long after onboarding completion the home conversation may be adopted. */
export const RECENT_COMPLETION_MS = 72 * 60 * 60 * 1000
/** Grace for client/server clock skew (completedAt is server-stamped). */
const CLOCK_SKEW_MS = 30 * 1000

/** The adopt-once flags' localStorage prefix (the dev reset clears them all). */
export const HOME_ADOPTED_KEY_PREFIX = 'dial8:home-conversation-adopted:'

/** localStorage key for the per-workspace adopt-once flag. */
export function homeAdoptedKey(workspaceId: string): string {
  return `${HOME_ADOPTED_KEY_PREFIX}${workspaceId}`
}

interface OnboardingPayload {
  member?: {
    onboardingCompletedAt?: string | null
    onboardingProgress?: {
      research?: unknown
    }
  }
}

/** Whether `completedAt` (ISO) is within the recent window ending at `now`. A
 *  missing/unparseable stamp is not recent; a slightly-future stamp is tolerated
 *  (clock skew) but a clearly far-future one is rejected as data nonsense. */
export function isRecentlyCompleted(
  completedAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!completedAt) return false
  const t = Date.parse(completedAt)
  if (Number.isNaN(t)) return false
  const age = now - t
  return age >= -CLOCK_SKEW_MS && age <= RECENT_COMPLETION_MS
}

export function useHomeConversationAdoption(opts: {
  workspaceId: string | null | undefined
  /** True when the client already tracks a conversation (returning user) — the
   *  hard no-hijack gate. */
  alreadyPersistedConversation: boolean
}): string | null {
  const { workspaceId, alreadyPersistedConversation } = opts
  const [adoptedId, setAdoptedId] = useState<string | null>(null)
  // The workspace the current adoptedId belongs to. Only a CHANGE of workspace
  // resets the adoption — the other dep (alreadyPersistedConversation) flips
  // true once the adopted thread itself is persisted, and must not unpin it.
  const adoptedForWorkspaceRef = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    if (adoptedForWorkspaceRef.current !== workspaceId) {
      adoptedForWorkspaceRef.current = workspaceId
      setAdoptedId(null)
    }
    // Hard gates before any network: a returning user with their own thread, or
    // an already-adopted workspace, is never touched.
    if (!workspaceId) return
    if (alreadyPersistedConversation) return
    let alreadyAdopted = false
    try {
      alreadyAdopted = localStorage.getItem(homeAdoptedKey(workspaceId)) === '1'
    } catch {
      /* ignore storage errors — treat as not-adopted */
    }
    if (alreadyAdopted) return

    let cancelled = false
    const controller = new AbortController()

    void (async () => {
      try {
        const res = await fetch('/api/account/onboarding', {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (cancelled) return
        if (!res.ok) return
        const data = (await res.json()) as OnboardingPayload
        const completedAt = data.member?.onboardingCompletedAt ?? null
        const hasResearch = data.member?.onboardingProgress?.research != null
        // Only adopt for a member who just completed onboarding AND actually ran
        // research (so there's a brief to reveal). Otherwise leave chat alone.
        if (!hasResearch || !isRecentlyCompleted(completedAt)) return

        const homeRes = await fetch('/api/account/chat-history/home', {
          method: 'POST',
          signal: controller.signal,
        })
        if (cancelled) return
        if (!homeRes.ok) return
        const home = (await homeRes.json()) as { conversationId?: string }
        if (cancelled) return
        if (!home.conversationId) return

        // Persist the adopt-once bit BEFORE surfacing the id, so even a fast
        // remount can't double-adopt.
        try {
          localStorage.setItem(homeAdoptedKey(workspaceId), '1')
        } catch {
          /* ignore — the in-memory adoptedId still prevents re-adopt this session */
        }
        setAdoptedId(home.conversationId)
      } catch {
        /* best-effort — no adoption on any failure; normal chat is unaffected */
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [workspaceId, alreadyPersistedConversation])

  return adoptedId
}
