'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Plus, Search, Sparkles, Users } from 'lucide-react'
import { ThinkingOrb } from 'thinking-orbs'
import { cn } from '@/lib/utils'
import { MACOS_TRAFFIC_LIGHT_WIDTH } from '@/lib/platform'
import { useHasTrafficLights } from '@/components/desktop-titlebar'
import { useOptionalRecordingStable } from '@/hooks/recording-context'
import { useSwitchWorkspace, useWorkspaces, type WorkspaceItem } from '../workspace-switcher'
import { useTeams } from '../teams-context'
import { CreateWorkspaceWizard } from '../create-workspace-wizard'
import { OPEN_WORKSPACES_EVENT } from '../workspaces-veil-events'

/**
 * The workspaces veil: every workspace you belong to, behind the app.
 *
 * Opening it ("View all workspaces") sends the whole app — header,
 * chat, windows — into the background: it shrinks into the card of the
 * workspace you're in and fades away there, while the other workspaces' cards
 * come up around it. Picking the card marked "You're here" brings the app
 * straight back out of it. Picking another switches to that workspace while the
 * app is out of sight, then brings the app forward out of THAT card — so the
 * switch needs no curtain of its own: the veil is the curtain.
 *
 * The app moves as one piece — `#ni-shell-root`, scaled and faded with the
 * Web Animations API — so nothing inside it is laid out again or remounted:
 * it's the same live app, just further away. While the veil is up the app is
 * inert (no focus, no pointer), and keys stop at the veil, so the app's
 * single-key shortcuts can't act on a page you can't see.
 */

/**
 * closed    — no veil; the app is where it always is.
 * receding  — the app is shrinking into the current workspace's card.
 * open      — the cards are up; the app is hidden in the background.
 * switching — a workspace was picked; its data is loading behind the veil.
 * emerging  — the app is growing back out of a card.
 */
type Phase = 'closed' | 'receding' | 'open' | 'switching' | 'emerging'

const SHELL_ID = 'ni-shell-root'
/** Above the veil (z-46) while the app is in flight, so it's seen shrinking
 *  over the cards and growing back over them. */
const SHELL_FLIGHT_Z = '47'

const RECEDE_MS = 560
const EMERGE_MS = 520
/** Slow to leave, quick through the middle, settling into the card. */
const RECEDE_EASE = 'cubic-bezier(0.55, 0, 0.1, 1)'
/** Out of the card fast, easing into place. */
const EMERGE_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'
/** With reduced motion the app just fades out and back. */
const FADE_MS = 180
/** The app's corners while it's in flight — a card, not a screen. */
const FLIGHT_RADIUS_PX = 22

/** The card the app lands in fades up as the app fades into it. */
const HERE_CARD_DELAY_MS = 300
/** The other cards come up one after another as the app gets out of the way. */
const CARD_DELAY_MS = 140
const CARD_STAGGER_MS = 40
const CARD_DELAY_MAX_MS = 520

/** A pick shows "Opening…" at least this long, so the switch reads as one. */
const MIN_SWITCH_MS = 450
/** …and never longer: the app comes forward even if the data hangs. */
const MAX_SWITCH_MS = 3000
/** If the new workspace's teams fetch hasn't started by now, it isn't going to. */
const SETTLE_PROBE_MS = 250

/** Enough workspaces that a search box earns its place. */
const SEARCH_THRESHOLD = 7

type Fit = { x: number; y: number; s: number }

/** The app scaled to fit inside `rect` and centred on it — the app "in" a card.
 *  With no card to aim at (the search filtered it out), toward the middle. */
function fitInto(rect: DOMRect | null): Fit {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (!rect || rect.width === 0 || rect.height === 0 || vw === 0 || vh === 0) {
    const s = 0.6
    return { x: (vw * (1 - s)) / 2, y: (vh * (1 - s)) / 2, s }
  }
  const s = Math.min(rect.width / vw, rect.height / vh)
  return { x: rect.left + (rect.width - vw * s) / 2, y: rect.top + (rect.height - vh * s) / 2, s }
}

const AT_HOME = 'translate(0px, 0px) scale(1)'
const inCard = (fit: Fit) => `translate(${fit.x}px, ${fit.y}px) scale(${fit.s})`

function recedeFrames(fit: Fit, reduced: boolean): Keyframe[] {
  if (reduced) return [{ opacity: 1 }, { opacity: 0 }]
  return [
    { offset: 0, transform: AT_HOME, opacity: 1, borderRadius: '0px' },
    { offset: 0.2, borderRadius: `${FLIGHT_RADIUS_PX}px` },
    // Whole until it's well on its way, then it fades into the card.
    { offset: 0.5, opacity: 1 },
    { offset: 1, transform: inCard(fit), opacity: 0, borderRadius: `${FLIGHT_RADIUS_PX}px` },
  ]
}

function emergeFrames(fit: Fit, reduced: boolean): Keyframe[] {
  if (reduced) return [{ opacity: 0 }, { opacity: 1 }]
  return [
    { offset: 0, transform: inCard(fit), opacity: 0, borderRadius: `${FLIGHT_RADIUS_PX}px` },
    { offset: 0.3, opacity: 1 },
    { offset: 0.8, borderRadius: `${FLIGHT_RADIUS_PX}px` },
    { offset: 1, transform: AT_HOME, opacity: 1, borderRadius: '0px' },
  ]
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Resolves when `animation` finishes or is cancelled — or after `ms` regardless,
 *  since a hidden tab can hold a finish back indefinitely. */
function whenDone(animation: Animation, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms + 100)
    animation.finished.then(
      () => { clearTimeout(timer); resolve() },
      () => { clearTimeout(timer); resolve() },
    )
  })
}

/** Play `frames` on the app, holding the last frame until it's cancelled.
 *  Where the Web Animations API is missing (tests) it lands at once. */
function fly(el: HTMLElement, frames: Keyframe[], ms: number, easing: string) {
  if (typeof el.animate !== 'function') return { animation: null, done: Promise.resolve() }
  const animation = el.animate(frames, { duration: ms, easing, fill: 'forwards' })
  return { animation, done: whenDone(animation, ms) }
}

/** Take the app out of play while the veil is up: it can't be focused or
 *  clicked, and it flies above the veil. */
function holdShell(shell: HTMLElement) {
  shell.setAttribute('inert', '')
  shell.style.pointerEvents = 'none'
  shell.style.transformOrigin = '0 0'
  shell.style.zIndex = SHELL_FLIGHT_Z
  shell.style.willChange = 'transform, opacity'
  shell.style.boxShadow = '0 30px 90px -20px rgba(0, 0, 0, 0.55)'
}

/**
 * Park the app — hidden, at its real size — once it has landed in its card.
 *
 * The flight is only what you see. Whatever in the app measures itself on
 * screen (a browser card's stage, the roaming bots' ledges) reads
 * getBoundingClientRect, which includes the app's transform: measured while
 * the app sat scaled into a card — as a workspace switched behind the veil —
 * they came out at a sixth of their size and kept it. So between
 * flights the app is untransformed and simply invisible, and lays itself out
 * true. Hidden before the held frame goes, so nothing paints in between.
 */
function parkShell(shell: HTMLElement, flight: Animation | null) {
  shell.style.opacity = '0'
  shell.style.visibility = 'hidden'
  shell.style.willChange = ''
  flight?.cancel()
}

function releaseShell(shell: HTMLElement) {
  shell.removeAttribute('inert')
  for (const prop of ['pointerEvents', 'transformOrigin', 'zIndex', 'willChange', 'boxShadow', 'visibility', 'opacity'] as const) {
    shell.style[prop] = ''
  }
}

/**
 * Have everything that measures on screen measure again. Something measured
 * mid-flight (a tab's title arriving, the workspace pill folding its name
 * away) read the flight's transform too, and no real resize will come along
 * to correct it — so the veil sends one when the app lands.
 */
function remeasure() {
  window.dispatchEvent(new Event('resize'))
}

/** Run `fn` once what's on screen now has painted. A frame's rAF callbacks run
 *  just before it paints, so a task queued from one runs just after — and a
 *  hidden tab paints no frames, so a fallback runs it after a beat anyway. */
function afterPaint(fn: () => void) {
  let ran = false
  const run = () => {
    if (ran) return
    ran = true
    fn()
  }
  requestAnimationFrame(() => setTimeout(run, 0))
  setTimeout(run, 100)
}

function slotRect(root: HTMLElement | null, id: string | null): DOMRect | null {
  if (!root || !id) return null
  return root.querySelector<HTMLElement>(`[data-veil-slot="${id}"]`)?.getBoundingClientRect() ?? null
}

function focusCard(root: HTMLElement | null, id: string | null) {
  const card = id ? root?.querySelector<HTMLElement>(`[data-veil-card="${id}"]`) : null
  ;(card ?? root)?.focus({ preventScroll: true })
}

/** The cards' order, fixed when the veil opens: the workspace you're in, then
 *  the rest by name. Fixed, so a switch doesn't reshuffle them under you. */
function orderFor(workspaces: WorkspaceItem[], currentId: string | null): string[] {
  return [...workspaces]
    .sort((a, b) => (a.id === currentId ? -1 : b.id === currentId ? 1 : a.name.localeCompare(b.name)))
    .map((w) => w.id)
}

/**
 * The brief's first prose line (under "## Overview" if there is one, else the
 * first line that isn't a heading) — one glance at what a workspace is about.
 */
function briefTeaser(content: string): string {
  const lines = content.split('\n')
  const hasOverview = content.toLowerCase().includes('## overview')
  let inOverview = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      inOverview = /overview/i.test(line)
      continue
    }
    if (inOverview || !hasOverview) return line.replace(/^[-*]\s*/, '')
  }
  return ''
}

/** Last-known teasers, kept across opens so the cards don't fill in late. */
let teaserCache: Record<string, string> = {}

function roleLabel(role: string): string {
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Member'
}

function memberLabel(count: number | undefined): string {
  const n = count ?? 1
  return `${n} ${n === 1 ? 'member' : 'members'}`
}

/** A stable tint per workspace for its initial tile. */
function hueFor(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return h
}

export function WorkspacesVeil() {
  const { workspaces, currentId, refresh } = useWorkspaces()
  const switchTo = useSwitchWorkspace()
  const { loading: teamsLoading } = useTeams()
  const trafficLights = useHasTrafficLights()

  const [phase, setPhase] = useState<Phase>('closed')
  /** The cards are up (flips a frame after the veil mounts, so they rise in). */
  const [entered, setEntered] = useState(false)
  const [order, setOrder] = useState<string[]>([])
  /** The workspace being opened: loading behind the veil, then coming forward. */
  const [target, setTarget] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [teasers, setTeasers] = useState<Record<string, string>>(() => teaserCache)
  /** Re-runs the settle check when nothing else will (see SETTLE_PROBE_MS). */
  const [settleProbe, setSettleProbe] = useState(0)

  const veilRef = useRef<HTMLDivElement>(null)
  // Latest values for handlers that outlive a render (window events, the end
  // of a flight).
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const currentIdRef = useRef(currentId)
  currentIdRef.current = currentId
  const workspacesRef = useRef(workspaces)
  workspacesRef.current = workspaces
  const queryRef = useRef(query)
  queryRef.current = query
  /** The app's flight in progress. Each flight bumps `id`, so the end of one
   *  that was superseded is ignored. */
  const flightRef = useRef<{ id: number; animation: Animation | null }>({ id: 0, animation: null })
  const switchRef = useRef<{ id: string; at: number; sawLoading: boolean } | null>(null)
  /** A workspace just created, to open once it shows up in the list. */
  const pendingPickRef = useRef<string | null>(null)

  const open = useCallback(() => {
    if (phaseRef.current !== 'closed' || !document.getElementById(SHELL_ID)) return
    setOrder(orderFor(workspacesRef.current, currentIdRef.current))
    setQuery('')
    setTarget(null)
    setEntered(false)
    setPhase('receding')
  }, [])

  /** The app is home again: hand it back and take the veil down. */
  const landHome = useCallback((flight: number) => {
    if (flightRef.current.id !== flight) return
    flightRef.current.animation?.cancel()
    flightRef.current.animation = null
    const shell = document.getElementById(SHELL_ID)
    if (shell) releaseShell(shell)
    switchRef.current = null
    setTarget(null)
    setPhase('closed')
    remeasure()
  }, [])

  /** Bring the app forward out of `fromId`'s card. */
  const emerge = useCallback(
    (fromId: string | null) => {
      const shell = document.getElementById(SHELL_ID)
      const reduced = prefersReducedMotion()
      const fit = fitInto(slotRect(veilRef.current, fromId))
      const flight = ++flightRef.current.id
      setEntered(false)
      setTarget(fromId)
      setPhase('emerging')
      if (!shell) {
        landHome(flight)
        return
      }
      holdShell(shell)
      // Out of its parking, into the first frame of the flight — in the same
      // task, so nothing paints in between.
      shell.style.visibility = ''
      shell.style.opacity = ''
      flightRef.current.animation?.cancel()
      const { animation, done } = fly(shell, emergeFrames(fit, reduced), reduced ? FADE_MS : EMERGE_MS, EMERGE_EASE)
      flightRef.current.animation = animation
      void done.then(() => landHome(flight))
    },
    [landHome],
  )

  const close = useCallback(() => {
    const phaseNow = phaseRef.current
    if (phaseNow === 'open') {
      emerge(currentIdRef.current)
      return
    }
    if (phaseNow !== 'receding') return
    // Still on its way in: send it straight back the way it came.
    const animation = flightRef.current.animation
    const flight = ++flightRef.current.id
    setEntered(false)
    setTarget(currentIdRef.current)
    setPhase('emerging')
    if (!animation) {
      landHome(flight)
      return
    }
    animation.reverse()
    void whenDone(animation, Number(animation.currentTime ?? 0)).then(() => landHome(flight))
  }, [emerge, landHome])
  const closeRef = useRef(close)
  closeRef.current = close

  const recording = useOptionalRecordingStable()
  const switchToRef = useRef(switchTo)
  switchToRef.current = switchTo
  const recordingRef = useRef(false)
  recordingRef.current = recording?.isRecording ?? false

  const pick = useCallback(
    (id: string) => {
      if (phaseRef.current !== 'open') return
      if (id === currentIdRef.current) {
        emerge(id)
        return
      }
      // No switching away from a capture that's recording. Let the switch
      // refuse, and say why, without a moment of "Opening…" first.
      if (recordingRef.current) {
        switchToRef.current(id, { curtain: false })
        return
      }
      switchRef.current = { id, at: Date.now(), sawLoading: false }
      setTarget(id)
      setPhase('switching')
      // Focus rides with the pick. The other cards are disabled while it
      // loads, and a disabled card drops focus to the page — where keys would
      // reach the app's shortcuts. (WebKit never focuses a clicked button.)
      focusCard(veilRef.current, id)
      // "Opening…" first, the switch once it's on screen. The switch
      // re-renders the whole app for the new workspace in one long task, and
      // run inside the click it held the card back until that was done — a
      // frozen beat, seconds on a big workspace, then "Opening…" at last. The
      // curtain always covered first and switched after; so does the veil.
      // The app is out of sight, so no curtain of its own.
      afterPaint(() => {
        if (switchRef.current?.id !== id) return
        if (switchToRef.current(id, { curtain: false })) return
        // Refused after all (a capture started in between): back to the cards.
        switchRef.current = null
        setTarget(null)
        setPhase('open')
      })
    },
    [emerge],
  )

  // ── Receding: the app shrinks into its card ──────────────────────────────
  useLayoutEffect(() => {
    if (phase !== 'receding') return
    const shell = document.getElementById(SHELL_ID)
    if (!shell) return
    holdShell(shell)
    const reduced = prefersReducedMotion()
    const fit = fitInto(slotRect(veilRef.current, currentIdRef.current))
    const flight = ++flightRef.current.id
    flightRef.current.animation?.cancel()
    const { animation, done } = fly(shell, recedeFrames(fit, reduced), reduced ? FADE_MS : RECEDE_MS, RECEDE_EASE)
    flightRef.current.animation = animation
    // The app is inert now, so focus moves into the veil: Enter goes back.
    focusCard(veilRef.current, currentIdRef.current)
    const frame = requestAnimationFrame(() => setEntered(true))
    void done.then(() => {
      if (flightRef.current.id !== flight) return
      parkShell(shell, flightRef.current.animation)
      flightRef.current.animation = null
      setPhase('open')
      remeasure()
    })
    return () => cancelAnimationFrame(frame)
  }, [phase])

  // ── Switching: come forward once the new workspace has settled ───────────
  // Its teams refetch on the switch, so their loading edge is the cue — the
  // same one the switch curtain uses. Bounded both ways: long enough that the
  // pick reads, never so long that a hung fetch holds the app back.
  useEffect(() => {
    if (phase !== 'switching') return
    const pending = switchRef.current
    if (!pending) return
    if (teamsLoading) {
      pending.sawLoading = true
      return
    }
    const elapsed = Date.now() - pending.at
    if (!pending.sawLoading && elapsed < SETTLE_PROBE_MS) {
      const timer = setTimeout(() => setSettleProbe((n) => n + 1), SETTLE_PROBE_MS - elapsed)
      return () => clearTimeout(timer)
    }
    const timer = setTimeout(() => emerge(pending.id), Math.max(0, MIN_SWITCH_MS - elapsed))
    return () => clearTimeout(timer)
  }, [phase, teamsLoading, settleProbe, emerge])

  useEffect(() => {
    if (phase !== 'switching') return
    const pending = switchRef.current
    if (!pending) return
    const timer = setTimeout(() => emerge(pending.id), MAX_SWITCH_MS)
    return () => clearTimeout(timer)
  }, [phase, emerge])

  // A workspace made from the veil opens as soon as the list has it.
  useEffect(() => {
    const id = pendingPickRef.current
    if (!id || phase !== 'open' || !workspaces.some((w) => w.id === id)) return
    pendingPickRef.current = null
    pick(id)
  }, [workspaces, phase, pick])

  // ── Asked for from anywhere ──────────────────────────────────────────────
  useEffect(() => {
    const onOpen = () => open()
    window.addEventListener(OPEN_WORKSPACES_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_WORKSPACES_EVENT, onOpen)
  }, [open])

  const mounted = phase !== 'closed'

  // Keys stop at the veil. The app's shortcuts listen on the document, so a
  // key pressed in here never reaches them — nothing acts on the hidden app.
  useEffect(() => {
    const root = veilRef.current
    if (!mounted || !root) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (queryRef.current) setQuery('')
        else closeRef.current()
      }
      e.stopPropagation()
    }
    root.addEventListener('keydown', onKeyDown)
    return () => root.removeEventListener('keydown', onKeyDown)
  }, [mounted])

  // Each card's one-line brief. Fetched per open; the last answer shows first.
  useEffect(() => {
    if (!mounted) return
    let cancelled = false
    fetch('/api/account/workspace/briefs')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { briefs?: Record<string, { content?: string } | null> } | null) => {
        if (cancelled || !data?.briefs) return
        const next: Record<string, string> = {}
        for (const [id, brief] of Object.entries(data.briefs)) {
          const teaser = brief?.content ? briefTeaser(brief.content) : ''
          if (teaser) next[id] = teaser
        }
        teaserCache = next
        setTeasers(next)
      })
      .catch(() => {
        /* briefs are extra — the cards stand without them */
      })
    return () => {
      cancelled = true
    }
  }, [mounted])

  // Never leave the app held if the veil goes away mid-flight.
  useEffect(
    () => () => {
      flightRef.current.id++
      flightRef.current.animation?.cancel()
      const shell = document.getElementById(SHELL_ID)
      if (shell) releaseShell(shell)
    },
    [],
  )

  if (!mounted) return null

  const byId = new Map(workspaces.map((w) => [w.id, w]))
  // Anything new since the veil opened (a workspace just made) goes last.
  const listed = [...order.filter((id) => byId.has(id)), ...workspaces.map((w) => w.id).filter((id) => !order.includes(id))]
  const q = query.trim().toLowerCase()
  const cards = listed
    .map((id) => byId.get(id)!)
    .filter((w) => !q || w.name.toLowerCase().includes(q) || (w.description ?? '').toLowerCase().includes(q))

  const shown = entered && phase !== 'emerging'
  const rising = phase === 'receding'
  const busyId = phase === 'switching' ? target : null
  let others = 0

  return (
    <div
      ref={veilRef}
      role="dialog"
      aria-modal="true"
      aria-label="Workspaces"
      tabIndex={-1}
      data-workspaces-veil={phase}
      className="fixed inset-0 z-[46] flex select-none flex-col outline-none"
    >
      {/* What's behind the app: a deeper surface than any of its own, lit from
          the top, so the app reads as a thing that moved away across it. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div
          className="absolute inset-0 dark:hidden"
          style={{ background: 'radial-gradient(ellipse 90% 60% at 50% 0%, hsl(0 0% 100% / 0.85), transparent 70%), hsl(0 0% 89%)' }}
        />
        <div
          className="absolute inset-0 hidden dark:block"
          style={{ background: 'radial-gradient(ellipse 90% 60% at 50% 0%, hsl(0 0% 100% / 0.07), transparent 70%), hsl(0 0% 0%)' }}
        />
      </div>

      <div
        data-tauri-drag-region
        className={cn(
          'relative flex h-14 shrink-0 items-center gap-2 pr-5 transition-opacity duration-300',
          shown ? 'opacity-100' : 'opacity-0',
        )}
        style={{ paddingLeft: trafficLights ? MACOS_TRAFFIC_LIGHT_WIDTH + 12 : 20 }}
      >
        <h2 className="text-sm font-semibold text-foreground">Workspaces</h2>
        <span className="text-sm text-muted-foreground">{workspaces.length}</span>
        <div className="ml-auto flex items-center gap-2">
          {workspaces.length >= SEARCH_THRESHOLD && (
            <div className="relative flex items-center">
              <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search workspaces…"
                aria-label="Search workspaces"
                className="h-8 w-56 select-text rounded-full border border-border bg-card pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-foreground/30"
              />
            </div>
          )}
          <button
            type="button"
            onClick={close}
            className="flex h-8 items-center gap-2 rounded-full border border-border bg-card px-3 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Back
            <kbd className="rounded border border-border px-1 text-[10px] font-medium text-muted-foreground">Esc</kbd>
          </button>
        </div>
      </div>

      {/* Empty space is the way back, like the rest of the room behind a card. */}
      <div
        className="relative min-h-0 flex-1 overflow-y-auto"
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('[data-veil-card]')) close()
        }}
      >
        <div className="flex min-h-full items-center justify-center px-8 pb-20 pt-4">
          <div className="flex max-w-[1240px] flex-wrap justify-center gap-5">
            {cards.map((ws) => {
              const here = ws.id === currentId
              const delay = here ? HERE_CARD_DELAY_MS : Math.min(CARD_DELAY_MS + CARD_STAGGER_MS * others++, CARD_DELAY_MAX_MS)
              return (
                <VeilCard
                  key={ws.id}
                  ws={ws}
                  here={here}
                  teaser={teasers[ws.id] ?? null}
                  shown={shown}
                  delay={rising ? delay : 0}
                  busy={busyId === ws.id}
                  dimmed={!!busyId && busyId !== ws.id}
                  onPick={() => pick(ws.id)}
                />
              )
            })}
            {!q && (
              <div data-veil-slot="new" className="w-[280px]">
                <button
                  type="button"
                  data-veil-card="new"
                  onClick={() => setCreating(true)}
                  disabled={!!busyId}
                  className={cn(
                    'flex h-[176px] w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-foreground/15 text-muted-foreground outline-none',
                    'transition-[opacity,translate,scale,border-color,color] ease-out hover:border-foreground/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
                    shown ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-2.5 scale-[0.97] opacity-0',
                    !!busyId && 'opacity-40',
                  )}
                  style={{
                    transitionDuration: shown ? '320ms' : '160ms',
                    transitionDelay: rising ? `${Math.min(CARD_DELAY_MS + CARD_STAGGER_MS * others, CARD_DELAY_MAX_MS)}ms` : '0ms',
                  }}
                >
                  <span className="grid h-10 w-10 place-items-center rounded-xl border border-dashed border-current">
                    <Plus className="h-4 w-4" />
                  </span>
                  <span className="text-sm font-medium">New workspace</span>
                </button>
              </div>
            )}
            {q && cards.length === 0 && (
              <p className="py-16 text-sm text-muted-foreground">No workspaces match “{query.trim()}”.</p>
            )}
          </div>
        </div>
      </div>

      {creating && (
        <CreateWorkspaceWizard
          userEmail={null}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false)
            pendingPickRef.current = id
            void refresh()
          }}
        />
      )}
    </div>
  )
}

function VeilCard({
  ws,
  here,
  teaser,
  shown,
  delay,
  busy,
  dimmed,
  onPick,
}: {
  ws: WorkspaceItem
  here: boolean
  teaser: string | null
  shown: boolean
  delay: number
  busy: boolean
  dimmed: boolean
  onPick: () => void
}) {
  const blurb = ws.description || teaser
  return (
    // The slot never moves, so it's what the app measures to land in; the
    // card inside it rises in and lifts on hover.
    <div data-veil-slot={ws.id} className="w-[280px]">
      <button
        type="button"
        data-veil-card={ws.id}
        onClick={onPick}
        disabled={dimmed}
        aria-busy={busy || undefined}
        aria-label={here ? `${ws.name}, you're here. Go back to it` : `Switch to ${ws.name}`}
        className={cn(
          'group/card relative flex h-[176px] w-full flex-col rounded-2xl border bg-card p-4 text-left outline-none',
          'shadow-[0_12px_32px_-14px_rgba(0,0,0,0.35)] focus-visible:ring-2 focus-visible:ring-ring',
          'transition-[opacity,translate,scale,border-color,box-shadow] ease-out',
          here ? 'border-primary/40 ring-1 ring-primary/15' : 'border-border hover:border-foreground/25',
          shown ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-2.5 scale-[0.97] opacity-0',
          shown && !dimmed && 'hover:-translate-y-0.5 hover:shadow-[0_18px_40px_-14px_rgba(0,0,0,0.45)]',
          dimmed && 'opacity-40',
        )}
        style={{ transitionDuration: shown ? '320ms' : '160ms', transitionDelay: `${delay}ms` }}
      >
        <div className="flex items-start justify-between gap-2">
          <LogoTile ws={ws} />
          {busy ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <ThinkingOrb state="connecting" size={20} theme="auto" />
              Opening…
            </span>
          ) : here ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              You&apos;re here
            </span>
          ) : null}
        </div>
        <div className="mt-3 min-w-0">
          <div className="truncate text-[15px] font-semibold text-foreground">{ws.name}</div>
          {blurb && (
            <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-muted-foreground">
              {!ws.description && <Sparkles className="mr-1 inline h-3 w-3 -translate-y-px text-primary/60" />}
              {blurb}
            </p>
          )}
        </div>
        <div className="mt-auto flex items-center gap-2 text-[12px] text-muted-foreground">
          <span>{roleLabel(ws.role)}</span>
          <span className="text-muted-foreground/40">·</span>
          <span className="inline-flex items-center gap-1">
            <Users className="h-3 w-3" />
            {memberLabel(ws.member_count)}
          </span>
          <span className="ml-auto text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">{ws.plan}</span>
        </div>
      </button>
    </div>
  )
}

function LogoTile({ ws }: { ws: WorkspaceItem }) {
  if (ws.logo_url) {
    return <img src={ws.logo_url} alt="" className="h-11 w-11 shrink-0 rounded-xl object-cover" />
  }
  const hue = hueFor(ws.id)
  return (
    <div
      className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-base font-semibold text-foreground/80"
      style={{ background: `linear-gradient(135deg, hsl(${hue} 60% 55% / 0.24), hsl(${hue + 40} 60% 55% / 0.1))` }}
    >
      {ws.name.charAt(0).toUpperCase()}
    </div>
  )
}
