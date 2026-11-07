'use client'

/**
 * Listen mode's highlight: a colourful border breathing around the window that
 * listen mode reads, so it is plain which screen supports it and, while it is
 * on, which screen the voice belongs to.
 *
 * Each content window is a ListenFrame (app/account/(dashboard)/content-windows.tsx).
 * The Listen targets inside it (./listen-target: an email thread, a document,
 * and the briefs of ./listen-brief) register their key with it while mounted,
 * and what comes next there if they offer one (Mail's next thread), for the
 * top bar's Next button (useListenNextHere), and their controls: how to pick
 * up their reading again, and what they say about themselves (a browser
 * page's tab title). Interactive mode (./interactive-voice-host) reads the
 * window in front's target through getFrontListenTarget: what the user was
 * listening to when they spoke, and the reading to resume once the reply and
 * its follow-up window are over.
 * A window that holds a target pulses when it is the window the user works
 * in, where what opens reads itself once listen mode is on, or when one of
 * its targets is the one reading (the section player's playingKey). It does
 * so whether listen mode is on or off (Liam, 2026-09-29: "the hue is always
 * visible, regardless if listen mode is on or off"): the hue marks the window
 * listen mode would read, and the toggle in the top bar (./listen-mode-toggle)
 * is what says whether it is on. Every other
 * window stays still, and so does every window while read-aloud can't play (a
 * capture recording, dictation, a browser) or the window isn't drawn (a
 * background tab, its card folded). Moving on to the next item swaps
 * its target out for a moment (a skeleton while the next email loads), so a
 * window only counts as holding none once that has lasted
 * LISTEN_TARGET_GAP_MS: browsing doesn't make the pulse dip at every step.
 *
 * The pulse is border-beam's `pulse-inner` (libraries.dev, MIT) in its mono
 * palette (grey and white, Liam's pick), brightened to read over a window
 * (LISTEN_PULSE_BRIGHTNESS), and otherwise as its docs ship it: full
 * strength, the preset's own breathe, at the window's own size, in the app's
 * theme (Liam, 2026-09-27: drawn small then scaled up to fill a big window,
 * it came to feel glitchy in the desktop app), with a wide soft edge glow of
 * its own under it that breathes on opacity alone (LISTEN_PULSE_HALO), so the
 * window reads as lit. It is an
 * overlay over the window's content that never takes a click (absolutely
 * positioned, pointer-events none, the window's inner radius), so the
 * window's layout is untouched. Its breathing runs on the library's shared frame loop, which
 * stops while no beam is active or on screen, and its own reduced-motion rule
 * turns it off under prefers-reduced-motion. The window losing what lit it
 * (focus moving away, its item closed) fades it out (`active` false), and it
 * unmounts once faded.
 *
 * border-beam is fetched the first time a window pulses (React.lazy), so the
 * dashboard's first load doesn't carry it (pinned by shell-heavy-deps.test.ts).
 *
 * Every Listen target renders inside a content window (TabContent mounts only
 * there), so there is no frameless surface to light. A target outside any
 * frame just registers with nothing.
 */

import {
  Suspense,
  createContext,
  lazy,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react'
import type { BorderBeamProps } from 'border-beam'
import { useSectionPlayer } from '@/lib/read-aloud/section-player'
import type { ListenTargetAbout } from '@/lib/voice/voice-ask'

/**
 * The mono glow's brightness (border-beam's `brightness`, a CSS brightness()
 * on its layers), by the app's theme. border-beam draws mono in mid greys at
 * half the other palettes' opacity, and its pulse-inner preset then dims them
 * on dark (0.75) and lightens them on light (1.3), so over a window the glow
 * all but vanished (Liam, 2026-09-27: "increase the visibility and intensity
 * of the mono one"). On dark, brighter turns the greys toward white; on light,
 * darker turns them toward grey, both away from the background. Strength is
 * already its full 1.
 */
export const LISTEN_PULSE_BRIGHTNESS = { dark: 1.8, light: 0.6 } as const

/**
 * The pulse's own soft edge glow, under border-beam's. pulse-inner draws a
 * handful of card-sized accents, which over a whole window hardly show (Liam,
 * 2026-09-27: "I want to see a bigger hue on the main content area"). A wide
 * inset shadow, grey-white like the mono beam, that breathes on opacity
 * alone: painted once and then only composited, with none of the per-frame
 * cost of drawing the beam small and scaling it up.
 */
export const LISTEN_PULSE_HALO = {
  // 10% under the first cut (0.18 / 0.1): "a tad bit too much" (Liam).
  dark: 'inset 0 0 80px 8px rgba(255, 255, 255, 0.16)',
  light: 'inset 0 0 80px 8px rgba(0, 0, 0, 0.09)',
} as const

/** The halo's breathe: border-beam's pulse cycle (2.3 s), down to 45%. */
const HALO_BREATHE_MS = 2300
const HALO_LOW_OPACITY = 0.45

/** border-beam fades out in 0.5s and says so when it has. No fade runs under
 *  prefers-reduced-motion or in a hidden window (no animation, no event), so
 *  after this long it goes anyway. */
export const LISTEN_PULSE_FADE_OUT_MS = 1000

/** How long a window may hold no Listen target and still count as holding
 *  one: the next item loading in place of the last. */
export const LISTEN_TARGET_GAP_MS = 1200

/** The content window's inner radius: a chat card's `rounded-3xl` (1.5rem)
 *  less its 1px border, the curve its `overflow-hidden` clips to. */
const WINDOW_INNER_RADIUS = 'rounded-[calc(1.5rem-1px)]'
const WINDOW_INNER_RADIUS_PX = 23

// ── The frame's registry: which Listen targets are mounted in it ─────────────

/**
 * What a Listen target offers to move on to: Mail's "Next thread". The top
 * bar shows it as a button beside the Listen mode toggle while listen mode is
 * on (./listen-mode-toggle). `go` is the target's own stable caller, so a
 * re-render of the page never changes it (./listen-target).
 */
export interface ListenNext {
  label: string
  go: () => void
}

/**
 * What a Listen target hands its window for Interactive mode (stable: the
 * target's own callers, reading its latest props). `resume` reads its item
 * again, from where it was paused (the section player resumes a paused key at
 * its sentence); `describe` is what it says about itself, for a page in the
 * in-app browser its tab title and host.
 */
export interface ListenTargetControls {
  resume: () => void
  describe?: () => ListenTargetAbout | null
}

/** The window in front's Listen target, for Interactive mode. */
export interface FrontListenTarget extends ListenTargetControls {
  key: string
}

interface ListenFrameRegistry {
  /** A target mounted with this key, offering `next` or not, with its
   *  controls; the returned function unmounts it. */
  register: (key: string, next?: ListenNext | null, controls?: ListenTargetControls | null) => () => void
  subscribe: (listener: () => void) => () => void
  /** Any target mounted here. */
  hostsAny: () => boolean
  /** A target with this key mounted here. */
  hosts: (key: string) => boolean
  /** What comes next here: the latest mounted target's that offers one (null
   *  when none of the mounted ones does). With no target mounted, the last
   *  one's, so it holds while the next item loads in place of the last, as
   *  the window's report does (LISTEN_TARGET_GAP_MS). */
  next: () => ListenNext | null
  /** The latest mounted target that handed over its controls, or null. */
  front: () => FrontListenTarget | null
}

function createListenFrameRegistry(): ListenFrameRegistry {
  // key → how many targets with it are mounted (two surfaces may share one).
  const counts = new Map<string, number>()
  // The mounted targets' offers and controls, oldest first (null: none).
  const offers = new Set<{ key: string; next: ListenNext | null; controls: ListenTargetControls | null }>()
  let lastNext: ListenNext | null = null
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  const mountedNext = (): ListenNext | null => {
    let found: ListenNext | null = null
    for (const offer of offers) if (offer.next) found = offer.next
    return found
  }
  return {
    register(key, next = null, controls = null) {
      counts.set(key, (counts.get(key) ?? 0) + 1)
      const offer = { key, next, controls }
      offers.add(offer)
      notify()
      return () => {
        const left = (counts.get(key) ?? 1) - 1
        if (left > 0) counts.set(key, left)
        else counts.delete(key)
        if (offers.size === 1 && offers.has(offer)) lastNext = mountedNext()
        offers.delete(offer)
        notify()
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    hostsAny: () => counts.size > 0,
    hosts: (key) => counts.has(key),
    next: () => (offers.size > 0 ? mountedNext() : lastNext),
    front: () => {
      let found: FrontListenTarget | null = null
      for (const offer of offers) if (offer.controls) found = { key: offer.key, ...offer.controls }
      return found
    },
  }
}

const ListenFrameContext = createContext<ListenFrameRegistry | null>(null)

/** A Listen target telling the window around it that it is there, while it is
 *  mounted, under its key, what comes next there if it offers it, and its
 *  controls (keep `next` and `controls` stable: a new one re-registers).
 *  Outside a ListenFrame: nothing. */
export function useListenFrameTarget(
  listenKey: string,
  next: ListenNext | null = null,
  controls: ListenTargetControls | null = null,
): void {
  const registry = useContext(ListenFrameContext)
  useEffect(() => registry?.register(listenKey, next, controls), [registry, listenKey, next, controls])
}

// ── Is there something to listen to here? (the Listen mode toggle) ───────────

/**
 * The windows that can read something now: the window the user works in
 * (focused and drawn) holding a Listen target, that is an email, action or
 * document open in it. The Listen mode toggle in the top bar shows only while
 * one can, or while listen mode is on (Liam, 2026-09-27: "only shows when you
 * have the window that supports it on the foreground and there's actually
 * something it can read"). One window is focused at a time; a set keeps one
 * window's report from racing another's as focus moves.
 */
const readableFrames = new Set<object>()
const readableListeners = new Set<() => void>()

function setFrameReadable(frame: object, readable: boolean): void {
  if (readable === readableFrames.has(frame)) return
  if (readable) readableFrames.add(frame)
  else readableFrames.delete(frame)
  for (const listener of [...readableListeners]) listener()
}

function subscribeReadable(listener: () => void) {
  readableListeners.add(listener)
  return () => {
    readableListeners.delete(listener)
  }
}
const anyReadable = () => readableFrames.size > 0
const noneReadable = () => false

/** Whether the window the user works in has something listen mode can read. */
export function useListenReadableHere(): boolean {
  return useSyncExternalStore(subscribeReadable, anyReadable, noneReadable)
}

/** Tests: a window that can (or can't) read something, without mounting one. */
const TEST_FRAME = {}
export function __setListenReadableForTests(readable: boolean): void {
  setFrameReadable(TEST_FRAME, readable)
}

// ── The window in front's target (Interactive mode) ──────────────────────────

/** Stands in for the window in front's target in tests (undefined: the real one). */
let testFront: FrontListenTarget | null | undefined

/**
 * The Listen target in the window the user works in (by the rules of
 * useListenReadableHere: focused and drawn), the latest mounted there that
 * handed over its controls; null when there is none (nothing open to read,
 * or the next item still loading in place of the last).
 */
export function getFrontListenTarget(): FrontListenTarget | null {
  if (testFront !== undefined) return testFront
  for (const frame of readableFrames) {
    const front = (frame as Partial<ListenFrameRegistry>).front?.()
    if (front) return front
  }
  return null
}

/** Tests: the window in front's target (null: none; undefined: the real one). */
export function __setFrontListenTargetForTests(target: FrontListenTarget | null | undefined): void {
  testFront = target
}

// ── What comes next here? (the Next button beside the toggle) ────────────────

/**
 * What the window the user works in offers to move on to, by the same rules
 * as useListenReadableHere: focused and drawn, holding a Listen target that
 * offers it (Mail's next thread), held while the next item loads in place of
 * the last. Liam, 2026-10-02: "it would be cool if you can skip to the next
 * thread. And maybe that would be like a control that shows up conditionally
 * on the listen mode toggle at the top."
 */
const nextFrames = new Map<object, ListenNext>()
const nextListeners = new Set<() => void>()

function setFrameNext(frame: object, next: ListenNext | null): void {
  if ((nextFrames.get(frame) ?? null) === next) return
  if (next) nextFrames.set(frame, next)
  else nextFrames.delete(frame)
  for (const listener of [...nextListeners]) listener()
}

function subscribeNext(listener: () => void) {
  nextListeners.add(listener)
  return () => {
    nextListeners.delete(listener)
  }
}
const frontNext = (): ListenNext | null => nextFrames.values().next().value ?? null
const noNext = () => null

/** What the window the user works in offers to move on to, or null. */
export function useListenNextHere(): ListenNext | null {
  return useSyncExternalStore(subscribeNext, frontNext, noNext)
}

/** Tests: a window offering `next` (or nothing), without mounting one. */
export function __setListenNextForTests(next: ListenNext | null): void {
  setFrameNext(TEST_FRAME, next)
}

// ── border-beam, fetched on first use ────────────────────────────────────────

/** Stands in when border-beam's chunk doesn't come (offline, a deploy in
 *  between): no pulse until a reload, rather than an error in the window. */
const NoBeam: ComponentType<BorderBeamProps> = () => null

const BorderBeam = lazy<ComponentType<BorderBeamProps>>(() =>
  import('border-beam').then(
    (mod) => ({ default: mod.BorderBeam }),
    () => ({ default: NoBeam }),
  ),
)

// ── The app's theme (the `dark` class on <html>), not the system's ───────────

function subscribeThemeClass(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}
const getIsDark = () => document.documentElement.classList.contains('dark')
const getServerIsDark = () => false

// ── The frame ────────────────────────────────────────────────────────────────

export interface ListenFrameProps {
  /** The window the user works in: visible, and the focused window of its tab. */
  focused: boolean
  /** The page is drawn: its tab is in front. */
  drawn: boolean
  children: ReactNode
}

/**
 * Wraps a content window's content: the Listen targets inside register with
 * it, and it draws the pulse over the content. Its parent must be `relative`,
 * with the window's rounded corners (the pulse fills it, inset-0).
 */
export function ListenFrame({ focused, drawn, children }: ListenFrameProps) {
  const [registry] = useState(createListenFrameRegistry)
  return (
    <ListenFrameContext.Provider value={registry}>
      {children}
      <ListenFramePulse registry={registry} focused={focused} drawn={drawn} />
    </ListenFrameContext.Provider>
  )
}

/**
 * ListenFrame in its two halves, for a window whose content and frame live
 * apart: a chat card keeps its page in one place while its frame moves between
 * inline and full screen (chat-cards/show-tool-card.tsx). The registry wraps
 * the content, where the Listen targets are; the pulse draws in the frame as it
 * is now (its parent `relative`, with the window's rounded corners).
 */
export function ListenFrameRegistry({ children }: { children: ReactNode }) {
  const [registry] = useState(createListenFrameRegistry)
  return <ListenFrameContext.Provider value={registry}>{children}</ListenFrameContext.Provider>
}

export function ListenFramePulseHere({ focused, drawn }: Omit<ListenFrameProps, 'children'>) {
  const registry = useContext(ListenFrameContext)
  return registry ? <ListenFramePulse registry={registry} focused={focused} drawn={drawn} /> : null
}

const noTarget = () => false

/** Which window pulses (see the header). Its own component, so the player
 *  and the registry re-render only it, never the window. */
const ListenFramePulse = memo(function ListenFramePulse({
  registry,
  focused,
  drawn,
}: {
  registry: ListenFrameRegistry
  focused: boolean
  drawn: boolean
}) {
  const { supported, playingKey } = useSectionPlayer()
  const hostsTargetNow = useSyncExternalStore(registry.subscribe, registry.hostsAny, noTarget)
  // A target swapped for the next one (see LISTEN_TARGET_GAP_MS) is no gap.
  const hostsTarget = useHeldTrue(hostsTargetNow, LISTEN_TARGET_GAP_MS)
  const readingHere = useSyncExternalStore(
    registry.subscribe,
    () => playingKey !== null && registry.hosts(playingKey),
    noTarget,
  )
  // Listen mode on or off alike (see the header).
  const active = supported && drawn && hostsTarget && (readingHere || focused)

  // Tells the top bar's toggle whether this window can read something now:
  // the window the user works in, holding a target (held across the next
  // item loading, so the toggle doesn't blink out between emails).
  const readable = focused && drawn && hostsTarget
  useEffect(() => setFrameReadable(registry, readable), [registry, readable])
  useEffect(() => () => setFrameReadable(registry, false), [registry])

  // And what comes next there (useListenNextHere), by the same rule: the
  // registry holds the last target's offer through the next item loading.
  const nextHere = useSyncExternalStore(registry.subscribe, registry.next, noNext)
  const next = readable ? nextHere : null
  useEffect(() => setFrameNext(registry, next), [registry, next])
  useEffect(() => () => setFrameNext(registry, null), [registry])

  return <ListenPulse active={active} />
})

/** `value`, except that turning false only shows once it has stayed false
 *  for `ms`. */
function useHeldTrue(value: boolean, ms: number): boolean {
  const [held, setHeld] = useState(value)
  if (value && !held) setHeld(true)
  useEffect(() => {
    if (value || !held) return
    const timer = setTimeout(() => setHeld(false), ms)
    return () => clearTimeout(timer)
  }, [value, held, ms])
  return value || held
}

/** Mounted while active and through its fade-out, then gone: nothing at all
 *  in a window with nothing to read. */
function ListenPulse({ active }: { active: boolean }) {
  const [mounted, setMounted] = useState(active)
  if (active && !mounted) setMounted(true)

  // Faded without saying so (see LISTEN_PULSE_FADE_OUT_MS): unmount anyway.
  useEffect(() => {
    if (active || !mounted) return
    const timer = setTimeout(() => setMounted(false), LISTEN_PULSE_FADE_OUT_MS)
    return () => clearTimeout(timer)
  }, [active, mounted])

  if (!mounted) return null
  return (
    <ListenPulseBeam
      active={active}
      // Only once it is meant to be off: turned back on mid-fade, it stays.
      onFaded={active ? undefined : () => setMounted(false)}
    />
  )
}

function ListenPulseBeam({ active, onFaded }: { active: boolean; onFaded?: () => void }) {
  const isDark = useSyncExternalStore(subscribeThemeClass, getIsDark, getServerIsDark)
  return (
    <div
      aria-hidden
      data-listen-pulse={active ? 'on' : 'fading'}
      // Over the content (z-10 in the window), and under the workspace-switch
      // curtain (z-50). Never in the way: pointer-events none, which the
      // beam's own layers inherit.
      className={`pointer-events-none absolute inset-0 z-20 overflow-hidden ${WINDOW_INNER_RADIUS}`}
    >
      <ListenPulseHalo active={active} isDark={isDark} />
      {/* Nothing while its chunk loads: it fades in from nothing anyway. */}
      <Suspense fallback={null}>
        {/* The docs' pulse-inner in mono, brightened; the theme is the
            app's, which border-beam can't see. */}
        <BorderBeam
          size="pulse-inner"
          colorVariant="mono"
          theme={isDark ? 'dark' : 'light'}
          brightness={LISTEN_PULSE_BRIGHTNESS[isDark ? 'dark' : 'light']}
          borderRadius={WINDOW_INNER_RADIUS_PX}
          active={active}
          onDeactivate={onFaded}
          className="h-full"
        >
          {/* Carries the window's inner radius. */}
          <div className="h-full" style={{ borderRadius: WINDOW_INNER_RADIUS_PX }} />
        </BorderBeam>
      </Suspense>
    </div>
  )
}

/**
 * LISTEN_PULSE_HALO, fading in and out with the beam (0.5 s) and breathing
 * with it: an opacity animation the browser runs on its own (the Web
 * Animations API), so no frame of it costs a paint. Still under
 * prefers-reduced-motion, as border-beam is.
 */
function ListenPulseHalo({ active, isDark }: { active: boolean; isDark: boolean }) {
  const breatheRef = useRef<HTMLDivElement>(null)
  // Shown one frame after mounting, so it fades in rather than appearing.
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    const el = breatheRef.current
    if (!el || typeof el.animate !== 'function') return
    if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const breathe = el.animate([{ opacity: 1 }, { opacity: HALO_LOW_OPACITY }, { opacity: 1 }], {
      duration: HALO_BREATHE_MS,
      iterations: Infinity,
      easing: 'ease-in-out',
    })
    return () => breathe.cancel()
  }, [])

  return (
    <div
      data-listen-pulse-halo={active && shown ? 'on' : 'off'}
      className={`absolute inset-0 transition-opacity duration-500 ${WINDOW_INNER_RADIUS}`}
      style={{ opacity: active && shown ? 1 : 0 }}
    >
      <div
        ref={breatheRef}
        className={`h-full w-full ${WINDOW_INNER_RADIUS}`}
        style={{ boxShadow: LISTEN_PULSE_HALO[isDark ? 'dark' : 'light'], willChange: 'opacity' }}
      />
    </div>
  )
}
