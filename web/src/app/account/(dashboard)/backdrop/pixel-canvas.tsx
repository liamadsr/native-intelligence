'use client'

import { useEffect, useRef } from 'react'
import { isDesktopApp } from '@/lib/platform'
import {
  PIXEL_FOCUS_EVENT,
  PIXEL_FRAME_MS,
  isInteractionIdle,
  mainFocusBroadcastApplies,
  shouldRunPixelCanvas,
} from './pixel-canvas-gate'
import { getThisWebviewLabel } from '@/lib/tauri-bridge'
import { listenScoped } from '@/lib/tauri-unlisten'

/** Lightweight canvas pixel grid — twinkling dots on a subtle grid, dev-friendly aesthetic */
export function PixelCanvas({ opacity = 0.8 }: { opacity?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // The canvas twinkle used to run its full-resolution rAF loop in EVERY case,
  // including where nothing renders: because all tabs stay mounted
  // (display:none when inactive), in every hidden tab. That's 60fps of wasted
  // paint per hidden surface, which piles up during a live meeting. We now
  // fully STOP the loop whenever nobody can see it move — tab inactive,
  // document hidden, window unfocused, or no pointer/keyboard input for a
  // minute — and restart it cleanly when any of those return (see
  // pixel-canvas-gate.ts for the pure decision + the setTimeout-wrapped-rAF
  // cadence rationale).
  // Apply the requested opacity by DIMMING THE PAINT (ctx.globalAlpha), not via a
  // CSS `opacity` on the <canvas> element. An element-level opacity < 1 promotes
  // the canvas to its own compositing layer, and a composited layer INSIDE the
  // glass content panel breaks that panel's backdrop-filter — Chromium then
  // samples the opaque shell background (bg-sidebar) instead of the photo behind
  // it, so the whole panel renders flat white (no glass). Baking the alpha into
  // the draw keeps the element at opacity:1 (no layer), so the glass survives.
  const opacityRef = useRef(opacity)
  useEffect(() => { opacityRef.current = opacity }, [opacity])


  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Frame scheduling holds at most ONE live handle at a time: a pending
    // frame timer OR a pending rAF, never both. See schedule() below.
    let raf: number | null = null
    let frameTimer: ReturnType<typeof setTimeout> | null = null
    // Focus / interaction gate inputs (module-pure decision in
    // pixel-canvas-gate.ts). Same clock basis as the rAF timestamp.
    let windowFocused = typeof document.hasFocus === 'function' ? document.hasFocus() : true
    let lastInteraction = performance.now()
    let interactionIdle = false
    const dpr = window.devicePixelRatio || 1
    const CELL = 24 // grid cell size in CSS pixels
    const DOT = 2   // dot size in CSS pixels

    // Pixel state: each dot has a phase offset for its twinkle, plus a static
    // vignette factor (distance-from-center falloff) precomputed per layout so
    // the per-frame loop combines twinkle and drifting coverage with that falloff.
    // Shared zero-length instance for the hidden-tab (0x0) state — see resize().
    const EMPTY_CELLS = new Float32Array(0)
    let cols = 0
    let rows = 0
    let phases: Float32Array = EMPTY_CELLS
    let vignettes: Float32Array = EMPTY_CELLS
    // Cache each cell's spatial waves at resize; drift then needs only four
    // trig calls per frame, instead of two extra trig calls per dot.
    let patchSinA: Float32Array = EMPTY_CELLS
    let patchCosA: Float32Array = EMPTY_CELLS
    let patchSinB: Float32Array = EMPTY_CELLS
    let patchCosB: Float32Array = EMPTY_CELLS

    function resize(width: number, height: number) {
      // A zero box is a hidden tab (display:none), not a layout. Computing the
      // vignette here would divide by width/2 === 0 and fill the array with NaN,
      // which slips past every `<= 0` / `< 0.01` skip in paint() (NaN compares
      // false) and ends up writing a 'NaN' string key onto the paths array. Take
      // an explicit empty state instead: zero cells, zero-length arrays, and a
      // freed backing store while the tab is hidden.
      if (width <= 0 || height <= 0) {
        canvas!.width = 0
        canvas!.height = 0
        cols = 0
        rows = 0
        phases = EMPTY_CELLS
        vignettes = EMPTY_CELLS
        patchSinA = patchCosA = patchSinB = patchCosB = EMPTY_CELLS
        return
      }
      canvas!.width = width * dpr
      canvas!.height = height * dpr
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      cols = Math.ceil(width / CELL) + 1
      rows = Math.ceil(height / CELL) + 1
      phases = new Float32Array(cols * rows)
      vignettes = new Float32Array(cols * rows)
      patchSinA = new Float32Array(cols * rows)
      patchCosA = new Float32Array(cols * rows)
      patchSinB = new Float32Array(cols * rows)
      patchCosB = new Float32Array(cols * rows)
      for (let i = 0; i < phases.length; i++) {
        phases[i] = Math.random() * Math.PI * 2
      }
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const dx = (col * CELL - width / 2) / (width / 2)
          const dy = (row * CELL - height / 2) / (height / 2)
          const dist = Math.sqrt(dx * dx + dy * dy)
          const idx = row * cols + col
          vignettes[idx] = Math.max(0, 1 - dist * 0.8)
          const waveA = col * 0.28 + row * 0.19
          const waveB = col * 0.11 - row * 0.25
          patchSinA[idx] = Math.sin(waveA)
          patchCosA[idx] = Math.cos(waveA)
          patchSinB[idx] = Math.sin(waveB)
          patchCosB[idx] = Math.cos(waveB)
        }
      }
    }

    // Backing-store reallocation is DEBOUNCED, not per-delivery. Writing
    // canvas.width/height allocates a fresh backing store, and in WKWebView that
    // store lives in the GPU process — every realloc is a new remote surface, so
    // it costs an IPC round trip. The ResizeObserver delivers once per rendered
    // frame while a window is being resized, so reallocating on each
    // delivery floods that channel for the whole drag and stalls the main thread
    // the drag itself runs on. Instead the OLD backing store keeps drawing
    // through the burst: the content is decorative dots at low alpha, so the
    // transient crop/stretch is invisible, and the trailing realloc settles the
    // true size.
    const RESIZE_SETTLE_MS = 180
    const initialRect = canvas.getBoundingClientRect()
    let pendingWidth = initialRect.width
    let pendingHeight = initialRect.height
    let resizeTimer: ReturnType<typeof setTimeout> | null = null

    resize(pendingWidth, pendingHeight)

    const applyPendingResize = () => {
      resizeTimer = null
      resize(pendingWidth, pendingHeight)
      // Repaint NOW instead of waiting out the frame timer. A realloc clears the
      // backing store, so at PIXEL_FRAME_MS cadence the settle would blank the
      // pattern for a batch of frames. When the loop is paused this is a single
      // paint with no reschedule — pausing freezes a drawn frame, and after a
      // realloc the frozen frame would otherwise be empty.
      const running = raf != null || frameTimer != null
      stop()
      if (running) raf = requestAnimationFrame(draw)
      else paint(performance.now())
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (!entry) return
      const rect = entry.contentRect
      if (rect.width === pendingWidth && rect.height === pendingHeight) return
      const isZero = rect.width <= 0 || rect.height <= 0
      const wasZero = pendingWidth <= 0 || pendingHeight <= 0
      pendingWidth = rect.width
      pendingHeight = rect.height
      if (resizeTimer != null) clearTimeout(resizeTimer)
      resizeTimer = null
      // A zero<->non-zero transition is a tab being hidden or shown
      // (display:none), not resize churn: settle it SYNCHRONOUSLY. Going to zero
      // frees the hidden tab's backing store right away; coming back from zero
      // reallocates and repaints in the same frame, so an activated tab never
      // shows a blank canvas for the debounce window. A window resize never
      // crosses zero, so the burst-coalescing this debounce exists for is
      // untouched.
      if (isZero || wasZero) applyPendingResize()
      // Trailing edge only, and it ALWAYS runs — resetting the timer on each
      // delivery is what collapses a drag burst into one realloc, but the final
      // delivery must still settle or the canvas keeps the stale size forever.
      else resizeTimer = setTimeout(applyPendingResize, RESIZE_SETTLE_MS)
    })
    observer.observe(canvas)

    // The twinkle and drifting patches are gradual, so ~12fps is visually
    // identical to 60fps. Alpha is quantized to a few levels so all dots of a
    // level batch into ONE filled Path2D — a handful of canvas commands per
    // frame instead of a per-dot fillStyle+fillRect pair. Both matter most in
    // the desktop app: WKWebView renders canvas remotely, so EVERY canvas
    // command is an IPC display-list item to the GPU process — the unthrottled
    // per-dot loop (~5k commands/frame at 60fps) burned >50% CPU while idle and
    // stalled the main thread on IPC backpressure, felt as chat typing lag.
    // (PIXEL_FRAME_MS lives in pixel-canvas-gate.ts with the run gate.)
    const ALPHA_LEVELS = 12
    const MAX_ALPHA = 0.45 // brightness peaks at 0.45; vignette only dims
    // One fill color per level, at the level's midpoint alpha (max quantization
    // error ~0.02 alpha — invisible at these dim levels, and the per-dot phase
    // offsets scatter neighbors across levels so there's no visible banding).
    const bucketColors: string[] = []
    let foreground = ''
    const updateColors = () => {
      const fg = getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim()
      if (fg === foreground) return false
      foreground = fg
      const [fgH, fgS, fgL] = fg.split(/\s+/)
      for (let i = 0; i < ALPHA_LEVELS; i++) {
        const a = ((i + 0.5) * MAX_ALPHA) / ALPHA_LEVELS
        bucketColors[i] = `hsla(${fgH}, ${fgS}, ${fgL}, ${a})`
      }
      return true
    }
    updateColors()
    // Mode changes update the root class; color themes also override its style.
    // Repaint once even while the twinkle is paused, without restarting its loop.
    const themeObserver = new MutationObserver(() => {
      if (updateColors()) paint(performance.now())
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    })
    // Schedule the next frame at the DRAW cadence: a PIXEL_FRAME_MS timeout
    // that then asks for ONE rAF (for vsync alignment + background clamping).
    // The old loop re-registered rAF every display frame and early-returned
    // ~90% of the time — at 60–120Hz that's a constant stream of callback
    // servicings + JSCallbackData allocations that kept WebKit's rendering-
    // update timer hot for a 12.5fps effect (2026-08-05 incident analysis).
    // Cadence is unchanged (~80ms rounded up to the next vsync, same as the
    // old ≥80ms throttle), so the twinkle looks identical.
    const schedule = () => {
      frameTimer = setTimeout(() => {
        frameTimer = null
        raf = requestAnimationFrame(draw)
      }, PIXEL_FRAME_MS)
    }

    function draw(t: number) {
      raf = null
      // Interaction-idle pause: nobody has touched pointer or keyboard for a
      // minute — freeze the last-painted frame (no clear, no reschedule) until
      // input resumes (the interaction listeners below flip the gate back).
      if (isInteractionIdle(t, lastInteraction)) {
        interactionIdle = true
        return
      }
      // Reschedule before drawing so a slow draw can't kill the loop, and so
      // stop() always has a live handle to cancel.
      schedule()
      paint(t)
    }

    /** One frame, no scheduling — also the paint the resize settle triggers. */
    function paint(t: number) {
      const w = canvas!.width / dpr
      const h = canvas!.height / dpr
      ctx!.clearRect(0, 0, w, h)
      // Dim the whole pattern to the requested opacity here instead of on the
      // element (see opacityRef note above — element opacity would break the
      // panel's backdrop-filter glass).
      ctx!.globalAlpha = opacityRef.current

      const time = t * 0.001 // seconds
      const driftSinA = Math.sin(time * 0.6)
      const driftCosA = Math.cos(time * 0.6)
      const driftSinB = Math.sin(time * 0.4)
      const driftCosB = Math.cos(time * 0.4)

      // Iteration bounds come from the ALLOCATED array, so being in range is
      // structural rather than a checked invariant: resize() writes cols, rows,
      // phases and vignettes together, and a hidden tab's empty state (cols=0,
      // zero-length arrays) makes this loop a no-op with no NaN and no clamp.
      const paths: (Path2D | null)[] = new Array(ALPHA_LEVELS).fill(null)
      for (let idx = 0; idx < phases.length; idx++) {
        const vignette = vignettes[idx]
        if (vignette <= 0) continue
        const phase = phases[idx]

        const row = (idx / cols) | 0
        const col = idx - row * cols
        // Uneven patches drift across the grid while individual dots twinkle.
        // The threshold leaves gaps between clusters instead of a uniform field.
        const patch = 0.5 + 0.25 * (
          patchSinA[idx] * driftCosA - patchCosA[idx] * driftSinA +
          patchSinB[idx] * driftCosB + patchCosB[idx] * driftSinB
        )
        const coverage = Math.max(0, (patch - 0.35) / 0.65)
        if (coverage === 0) continue
        const speed = 0.8 + (phase % 1) * 0.8
        const brightness = 0.25 + Math.sin(time * speed + phase) * 0.2

        const alpha = brightness * vignette * coverage
        if (alpha < 0.01) continue

        let bucket = Math.floor((alpha / MAX_ALPHA) * ALPHA_LEVELS)
        if (bucket >= ALPHA_LEVELS) bucket = ALPHA_LEVELS - 1
        const path = (paths[bucket] ??= new Path2D())
        path.rect(col * CELL - DOT / 2, row * CELL - DOT / 2, DOT, DOT)
      }
      for (let i = 0; i < ALPHA_LEVELS; i++) {
        const path = paths[i]
        if (!path) continue
        ctx!.fillStyle = bucketColors[i]
        ctx!.fill(path)
      }
    }

    const start = () => {
      if (raf == null && frameTimer == null) raf = requestAnimationFrame(draw)
    }
    const stop = () => {
      if (raf != null) cancelAnimationFrame(raf)
      raf = null
      if (frameTimer != null) clearTimeout(frameTimer)
      frameTimer = null
    }
    // Run the loop iff someone can actually see it move: the document isn't
    // backgrounded (OS tab switch / minimized window), the
    // WINDOW is focused (the desktop shell disables background throttling, so
    // an unfocused-but-visible window would otherwise burn all workday), and
    // the user has interacted within the last minute. The decision itself is
    // the pure gate in pixel-canvas-gate.ts.
    const syncRunning = () => {
      const visible = shouldRunPixelCanvas({
        documentHidden: document.hidden,
        windowFocused,
        interactionIdle,
      })
      if (visible) start()
      else stop()
    }

    const onVisibility = () => syncRunning()
    document.addEventListener('visibilitychange', onVisibility)

    // Any pointer/keyboard input feeds the idle gate (and wakes it). Handlers
    // are two field writes — safe at pointermove rates.
    const onInteraction = () => {
      lastInteraction = performance.now()
      if (interactionIdle) {
        interactionIdle = false
        syncRunning()
      }
    }
    window.addEventListener('pointerdown', onInteraction, { passive: true })
    window.addEventListener('pointermove', onInteraction, { passive: true })
    window.addEventListener('keydown', onInteraction, { passive: true })
    window.addEventListener('wheel', onInteraction, { passive: true })

    // Window focus/blur. Regaining focus counts as interaction (the user came
    // back — resume immediately even if the idle clock had expired).
    //
    // `broadcast` marks the main-focus broadcast, which is only subscribed in
    // the window labelled 'main' (see below) — there it describes THIS window's
    // own focus and is authoritative, so it must not be second-guessed: the
    // Tauri IPC event can land before WebKit propagates DOM focus, and a
    // hasFocus() veto would then skip the idle reset on exactly the cmd-tab
    // resume the native event exists to provide. `broadcastIsForeign` is the
    // pop-out case (a future wiring where the broadcast describes some OTHER
    // window): treating it as interaction there would restart a 60-second idle
    // clock, and the loop with it, in a window nobody touched.
    const onWindowFocusChange = (focused: boolean, broadcastIsForeign = false) => {
      windowFocused = focused
      const trustFocus =
        !broadcastIsForeign || (typeof document.hasFocus === 'function' && document.hasFocus())
      if (focused && trustFocus) {
        lastInteraction = performance.now()
        interactionIdle = false
      }
      syncRunning()
    }
    const onWinFocus = () => onWindowFocusChange(true)
    const onWinBlur = () => onWindowFocusChange(false)
    window.addEventListener('focus', onWinFocus)
    window.addEventListener('blur', onWinBlur)

    // Desktop focus, per window. Native focus events are preferred over DOM
    // focus/blur because they fire on cmd-tab even when the window stays visible
    // (with background throttling disabled the DOM signals can miss that) and
    // they ignore focus handed to our own HUD windows.
    //
    // Two sources, in preference order:
    //  1. `window-focus-changed` — emitted per-window, window-TARGETED, so it is
    //     authoritative for whichever window receives it. Subscribed scoped to
    //     this webview: a global listener registers as EventTarget::Any and
    //     would pick up every OTHER window's targeted emits too.
    //  2. `main-focus-changed` — a BROADCAST describing only the main window.
    //     Authoritative in the main window; in a pop-out it is somebody else's
    //     focus, and trusting it re-armed the twinkle here whenever main was
    //     focused, so side-by-side windows both animated into the one shared
    //     WKWebView GPU process (the typing-lag incident). Pop-outs use DOM
    //     focus/blur instead.
    // Older shells emit only (2), which is why the label-based wiring stands on
    // its own; there is nothing to feature-detect — (1) just never fires.
    let cancelled = false
    // Each Tauri subscription's disposer (listenScoped: safe before it
    // resolves, handlers gated). Pushed only while not cancelled.
    const stopFocus: Array<() => void> = []
    if (isDesktopApp()) {
      void (async () => {
        const label = await getThisWebviewLabel()
        if (cancelled) return
        // Authoritative once it starts arriving; suppresses the broadcast so a
        // newer shell can't have both driving the same field.
        let perWindowSeen = false
        // An older shell without the per-window event rejects; swallowed.
        stopFocus.push(listenScoped((gate) =>
          import('@tauri-apps/api/webviewWindow').then(({ getCurrentWebviewWindow }) =>
            getCurrentWebviewWindow().listen<boolean>(
              PIXEL_FOCUS_EVENT,
              gate((e) => {
                perWindowSeen = true
                onWindowFocusChange(e.payload)
              }),
            ),
          ),
        ))
        if (!mainFocusBroadcastApplies(label)) return
        // Only 'main' subscribes today, so the broadcast is this window's own
        // focus and is authoritative — see the trustFocus note above.
        const broadcastIsForeign = label !== 'main'
        // An older desktop build without the event rejects; swallowed (DOM
        // signals still cover it).
        stopFocus.push(listenScoped((gate) =>
          import('@/lib/tauri-bridge').then(({ tauriBridge }) =>
            tauriBridge.onMainFocusChanged(gate((focused) => {
              if (perWindowSeen) return
              onWindowFocusChange(focused, broadcastIsForeign)
            })),
          ),
        ))
      })()
    }

    paint(performance.now()) // show the initial pattern even when the loop is paused
    syncRunning() // kick off per the initial (ref) state

    return () => {
      stop()
      observer.disconnect()
      themeObserver.disconnect()
      if (resizeTimer != null) clearTimeout(resizeTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pointerdown', onInteraction)
      window.removeEventListener('pointermove', onInteraction)
      window.removeEventListener('keydown', onInteraction)
      window.removeEventListener('wheel', onInteraction)
      window.removeEventListener('focus', onWinFocus)
      window.removeEventListener('blur', onWinBlur)
      cancelled = true
      for (const stopOne of stopFocus.splice(0)) stopOne()
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full pointer-events-none"
      // No CSS opacity here on purpose — the dimming is baked into the paint via
      // ctx.globalAlpha (see opacityRef note above). An element opacity < 1 would
      // create a compositing layer that breaks the glass panel's backdrop-filter.
    />
  )
}

