'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { ThinkingOrb } from 'thinking-orbs'
import { cn } from '@/lib/utils'
import { useTeams } from './teams-context'

/** The element the curtain covers: the dashboard's chat row (dashboard-shell ChatRow). */
export const CONTENT_PANEL_ID = 'ni-content-panel'

/**
 * "Wipe & reveal" workspace transition, scoped to the main content panel.
 *
 * Switching workspaces is a pure in-place context update (no navigation) — but
 * a bare context swap flickers: teams clear, lists empty, then repopulate a beat
 * later as `/api/account/teams` (and downstream entity fetches) resolve. This
 * provider hides that seam behind a branded transition that covers only the
 * content panel (the tab bar, chat strip, and sidebar stay put):
 *
 *   1. WIPE IN   — a curtain sweeps across the content panel, covering it.
 *   2. COMMIT    — at the wipe's peak (panel fully covered) we run the caller's
 *                  switch fn, so the underlying re-fetch churn is never seen.
 *   3. SETTLE    — we wait for the new workspace's data to land (teams stop
 *                  loading), bounded by a MIN (so the motion always reads as
 *                  intentional) and a MAX (so a slow/failed fetch can't trap us).
 *   4. REVEAL    — the curtain sweeps away, unveiling the new workspace, with the
 *                  workspace name briefly announced in the center.
 *
 * The curtain mounts into the chat stage (`#ni-content-panel`,
 * CONTENT_PANEL_ID: the dashboard's chat row) via a portal so it inherits its
 * clip. The reveal cue is `useTeams().loading`: teams are
 * cleared+refetched on every workspace change, so its loading edge is a reliable
 * "new workspace is ready" proxy. Everything else (entities, realtime)
 * re-subscribes off the same workspaceId change and rides the same curtain.
 */

interface TransitionTarget {
  id: string
  name: string
  logoUrl: string | null
}

interface WorkspaceTransitionValue {
  /**
   * Run `commit` behind a full-screen wipe. `commit` performs the actual
   * workspace switch (cookie POST + setCurrentId). The overlay covers the app
   * before `commit` fires and reveals once the new workspace's data settles.
   */
  beginTransition: (target: TransitionTarget, commit: () => void) => void
  isTransitioning: boolean
}

const WorkspaceTransitionCtx = createContext<WorkspaceTransitionValue>({
  beginTransition: (_target, commit) => commit(),
  isTransitioning: false,
})

// Timing — the curtain must feel deliberate but never sticky.
const WIPE_IN_MS = 120 // cover is instant; brief beat before committing the switch
const REVEAL_MS = 500 // sweep off to reveal the new workspace
const MIN_COVERED_MS = 560 // floor on time spent covered (motion legibility)
const MAX_COVERED_MS = 2600 // ceiling — reveal even if data never settles
const SETTLE_GRACE_MS = 120 // small pad after loading flips false

type Phase = 'idle' | 'covering' | 'covered' | 'revealing'

export function WorkspaceTransitionProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const { loading: teamsLoading } = useTeams()

  const [phase, setPhase] = useState<Phase>('idle')
  const [target, setTarget] = useState<TransitionTarget | null>(null)

  // Refs for orchestration that must survive re-renders / not retrigger effects.
  const coveredAtRef = useRef<number>(0)
  const sawLoadingRef = useRef(false) // confirmed teams entered the loading state
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  const clearTimers = useCallback(() => {
    timersRef.current.forEach(clearTimeout)
    timersRef.current = []
  }, [])

  useEffect(() => () => clearTimers(), [clearTimers])

  const reveal = useCallback(() => {
    setPhase((p) => (p === 'covered' ? 'revealing' : p))
  }, [])

  const beginTransition = useCallback(
    (next: TransitionTarget, commit: () => void) => {
      // Guard against re-entrancy: ignore if a transition is already in flight.
      if (phase !== 'idle') return

      clearTimers()
      sawLoadingRef.current = false
      setTarget(next)
      setPhase('covering')

      // At the wipe's peak the app is fully covered — commit the switch now so
      // none of the teardown/refetch flicker is visible.
      const coverTimer = setTimeout(() => {
        coveredAtRef.current = Date.now()
        setPhase('covered')
        commit()

        // Hard ceiling: reveal no matter what, so a hung fetch never traps the UI.
        const maxTimer = setTimeout(reveal, MAX_COVERED_MS)
        timersRef.current.push(maxTimer)
      }, WIPE_IN_MS)
      timersRef.current.push(coverTimer)
    },
    [phase, clearTimers, reveal],
  )

  // SETTLE: once covered, watch teams loading. We want to reveal after teams have
  // *finished* loading for the new workspace. Because the commit triggers a
  // clear→fetch, loading goes true then false; we wait for the falling edge,
  // then honor the MIN_COVERED floor before revealing.
  useEffect(() => {
    if (phase !== 'covered') return

    if (teamsLoading) {
      sawLoadingRef.current = true
      return
    }

    // teamsLoading === false. Reveal once we've (a) seen loading flip true at
    // least once (the new fetch actually started) OR enough time elapsed that
    // we assume it already resolved, AND (b) the MIN floor is satisfied.
    const elapsed = Date.now() - coveredAtRef.current
    const waitForFloor = Math.max(0, MIN_COVERED_MS - elapsed)
    const settled = sawLoadingRef.current || elapsed > 250

    if (!settled) return

    const t = setTimeout(reveal, waitForFloor + SETTLE_GRACE_MS)
    timersRef.current.push(t)
    return () => clearTimeout(t)
  }, [phase, teamsLoading, reveal])

  const handleRevealComplete = useCallback(() => {
    setPhase('idle')
    setTarget(null)
    clearTimers()
  }, [clearTimers])

  // Teardown is timer-driven (setTimeout works regardless of tab visibility),
  // so the curtain always clears even if the CSS wipe transition never fires
  // (e.g. a backgrounded tab, where transitionend wouldn't arrive). The
  // curtain's onTransitionEnd is a faster path when the wipe does run.
  useEffect(() => {
    if (phase !== 'revealing') return
    const t = setTimeout(handleRevealComplete, REVEAL_MS + 80)
    return () => clearTimeout(t)
  }, [phase, handleRevealComplete])

  const isTransitioning = phase !== 'idle'
  const covered = phase === 'covered' || phase === 'covering'

  // The curtain is scoped to the main content panel (not the whole app), so it
  // mounts into that panel via a portal. Resolved at render — only while a switch
  // is in flight, which is always client-side. If the panel isn't present the
  // curtain simply doesn't render; the timer-driven teardown still completes the
  // switch silently.
  const portalTarget =
    typeof document !== 'undefined' && isTransitioning
      ? document.getElementById(CONTENT_PANEL_ID)
      : null

  return (
    <WorkspaceTransitionCtx.Provider value={{ beginTransition, isTransitioning }}>
      {children}
      {isTransitioning &&
        target &&
        portalTarget &&
        createPortal(
          <WorkspaceCurtain
            phase={phase}
            covered={covered}
            target={target}
            onRevealComplete={handleRevealComplete}
          />,
          portalTarget,
        )}
    </WorkspaceTransitionCtx.Provider>
  )
}

function WorkspaceCurtain({
  phase,
  covered,
  target,
  onRevealComplete,
}: {
  phase: Phase
  covered: boolean
  target: TransitionTarget
  onRevealComplete: () => void
}) {
  const revealing = phase === 'revealing'

  // The cover panel is opaque from the very first frame — the screen behind is
  // blocked instantly on switch, never partially visible. On reveal we run a
  // clip-path transition that sweeps the panel off to the left. Teardown is
  // timer-driven in the provider, so a missing transitionend (e.g. a
  // backgrounded tab) can't trap it.
  const revealClip = 'inset(0 0 0 100%)'
  const coverClip = 'inset(0 0% 0 0)'

  return (
    <div
      className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center overflow-hidden"
      style={{ contain: 'strict' }}
    >
      {/* The cover panel. Matches the content panel's surface; sits fully opaque
          while covered, then sweeps off on reveal. */}
      <div
        className="absolute inset-0 bg-background"
        style={{
          clipPath: revealing ? revealClip : coverClip,
          WebkitClipPath: revealing ? revealClip : coverClip,
          transition: revealing
            ? 'clip-path 500ms cubic-bezier(0.65,0,0.35,1)'
            : undefined,
        }}
        onTransitionEnd={(e) => {
          if (revealing && e.propertyName.includes('clip')) onRevealComplete()
        }}
      >
        {/* Soft brand wash so the curtain isn't a flat fill. Kept subtle and
            top-anchored; no edge band (a static right-edge glow read as a
            washed-out vertical stripe rather than tracking the moving wipe). */}
        <div
          className="absolute inset-0 opacity-50"
          style={{
            background:
              'radial-gradient(120% 120% at 50% 0%, hsl(var(--primary) / 0.12), transparent 55%)',
          }}
        />
      </div>

      {/* Center announcement — the workspace you're entering. Visible only while
          covered; fades/scales as the reveal begins. */}
      <div
        className={cn(
          'relative z-10 flex flex-col items-center gap-4',
          'transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none',
          covered ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-2 scale-95 opacity-0',
        )}
      >
        <CurtainMark target={target} />
        <div className="flex flex-col items-center gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
            Switching to
          </span>
          <span className="max-w-[20rem] text-balance break-words px-4 text-center text-lg font-semibold text-foreground">
            {target.name}
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * The big mark shown center-screen during the curtain.
 *
 * Shows the thinking orb at its 64px preset rather than the workspace logo or
 * initial: the curtain is a *waiting* moment, so a live animation reads as
 * progress where a static letter read as a stalled frame. The workspace name
 * directly below already identifies where you're going.
 */
function CurtainMark({ target }: { target: TransitionTarget }) {
  return (
    <div className="relative grid h-16 w-16 place-items-center">
      <ThinkingOrb
        state="connecting"
        size={64}
        theme="auto"
        aria-label={`Switching to ${target.name}`}
      />
    </div>
  )
}

export function useWorkspaceTransition() {
  return useContext(WorkspaceTransitionCtx)
}
