'use client'

/**
 * The live agent's HUD on web (one-chat plan, Slice 3; Liam, 10-15: "let's
 * also make it show on web"): the desktop's HUD (AgentHudView) as a floating,
 * draggable panel over the app for the length of a call. Above the app, below
 * its modals (z-45; dialogs and popovers sit at z-50).
 *
 *   - <LiveHudMount /> is what the dashboard mounts (3b): it shows the panel
 *     only while a live capture records, and only where no desktop HUD window
 *     exists (not in the desktop app). Client-only: nothing renders until it
 *     has mounted, so the server's HTML and the first client render agree.
 *   - The panel reads the recording context directly (it lives under
 *     /account): its feed is ./in-page-hud-feed.tsx, its Voice ID clicks and
 *     the header's recording controls (pause / resume, stop, back to the
 *     capture) run through the recording's own handlers, the top bar pill's,
 *     and before each chat send it pushes the transcript
 *     (flushTranscriptForAgent) — no Tauri relay. The goal line saves
 *     through the recording window's own write (./save-hud-goal.ts), called
 *     directly. While it's up the top bar's pill steps aside
 *     (claimHudRecordingControls).
 *   - It moves by dragging anywhere that isn't a control; where it was left is
 *     remembered per device and kept on screen (./web-hud-position.ts),
 *     re-checked when the window resizes.
 *   - Escape collapses the chat (the chat's own box handles it first).
 *   - The chat box's audio-reactive glow reads the recording's own level
 *     store (getLevels / subscribeLevels: the capture's mic, ~10 Hz), the
 *     same levels the main composer's call glow used (./hud-audio-levels.ts).
 *
 * Idle-cheap: no timers, no animation; a drag writes the transform straight to
 * the element and renders once, on release.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent } from 'react'
import { useOptionalRecordingStable } from '@/hooks/recording-context'
import { isDesktopApp } from '@/lib/platform'
import { runVoiceIdHudAction, type VoiceIdHudAction } from '@/lib/live-agent/voice-id-hud'
import { claimHudRecordingControls, runHudRecordingAction, type HudRecordingAction } from '@/lib/live-agent/hud-recording'
import { openActiveCapture } from '@/components/capture/recording-status'
import { saveHudGoal } from './save-hud-goal'
import { useHudTelemetry } from './use-hud-telemetry'
import { AgentHudView } from './agent-hud-view'
import type { AgentHudActions, HudFeedStore } from './hud-feed'
import { gainedCaptureLevel, type HudAudioLevels } from './hud-audio-levels'
import { InPageHudFeed, inPageHudFeed, inPageHudHandlers } from './in-page-hud-feed'
import {
  clampHudPosition,
  defaultHudPosition,
  hudSizeIn,
  readHudPosition,
  writeHudPosition,
  type HudPoint,
  type HudSize,
} from './web-hud-position'

/** What a press on starts or uses rather than moving the panel. */
const CONTROLS =
  'button, a, input, textarea, select, label, [role="button"], [role="tab"], [role="option"], [role="menuitem"], [data-scrolls], [contenteditable="true"], [data-radix-popper-content-wrapper]'

const subscribeNothing = () => () => {}

/** The panel, only while a live capture records and only off the desktop app. */
export function LiveHudMount() {
  const recording = useOptionalRecordingStable()
  const mounted = useSyncExternalStore(subscribeNothing, () => true, () => false)
  if (!mounted || isDesktopApp()) return null
  const captureId = recording?.isRecording ? recording.captureId : null
  if (!captureId) return null
  return <WebHud key={captureId} captureId={captureId} />
}

export function WebHud({ captureId, store = inPageHudFeed }: { captureId: string; store?: HudFeedStore }) {
  const [live, setLive] = useState(true)
  const onLiveChange = useCallback((v: boolean) => setLive(v), [])
  return (
    <>
      <InPageHudFeed captureId={captureId} store={store} onLiveChange={onLiveChange} />
      {live && <WebHudPanel captureId={captureId} store={store} />}
    </>
  )
}

function viewport(): HudSize {
  return { width: window.innerWidth, height: window.innerHeight }
}

function WebHudPanel({ captureId, store }: { captureId: string; store: HudFeedStore }) {
  const feed = useSyncExternalStore(store.subscribe, store.get, store.get)
  const recording = useOptionalRecordingStable()
  const flush = recording?.flushTranscriptForAgent

  const sendVoiceIdAction = useCallback(
    (action: VoiceIdHudAction) => {
      if (inPageHudHandlers.current) runVoiceIdHudAction(action, captureId, inPageHudHandlers.current)
    },
    [captureId],
  )
  const beforeSend = useCallback(async () => {
    await flush?.(captureId)
  }, [flush, captureId])
  // The header's recording controls: the recording's own handlers (read when
  // clicked, so the callback stays stable).
  const recordingRef = useRef(recording)
  recordingRef.current = recording
  const sendRecordingAction = useCallback(
    (action: HudRecordingAction) => {
      const r = recordingRef.current
      if (!r) return
      runHudRecordingAction(action, captureId, {
        pauseRecording: r.pauseRecording,
        resumeRecording: r.resumeRecording,
        stopRecording: r.stopRecording,
        openCapture: openActiveCapture,
      })
    },
    [captureId],
  )
  // The goal line's saves: the recording window's own write, here in this page.
  const saveGoal = useCallback((goal: string) => saveHudGoal(captureId, goal), [captureId])
  // What this panel saw, for PostHog (./use-hud-telemetry.ts).
  const onSayShown = useHudTelemetry({ host: 'page', captureId, nudges: feed.nudges, hasConversation: !!feed.conversation })
  const actions = useMemo<AgentHudActions>(
    () => ({ sendVoiceIdAction, beforeSend, sendRecordingAction, saveGoal, onSayShown }),
    [sendVoiceIdAction, beforeSend, sendRecordingAction, saveGoal, onSayShown],
  )
  // The call's audio level for the chat box's glow: the recording's level store.
  const getLevels = recording?.getLevels
  const subscribeLevels = recording?.subscribeLevels
  const audioLevels = useMemo<HudAudioLevels | null>(
    () => (getLevels && subscribeLevels ? { get: () => gainedCaptureLevel(getLevels()), subscribe: subscribeLevels } : null),
    [getLevels, subscribeLevels],
  )
  // Up: the controls are here, so the top bar's pill steps aside.
  useEffect(() => claimHudRecordingControls(captureId), [captureId])

  // Where it sits: remembered, else bottom-right; always on screen.
  const [place, setPlace] = useState<{ pos: HudPoint; size: HudSize }>(() => {
    const vp = viewport()
    const size = hudSizeIn(vp)
    const saved = readHudPosition()
    return { size, pos: saved ? clampHudPosition(saved, size, vp) : defaultHudPosition(size, vp) }
  })
  useEffect(() => {
    const onResize = () => {
      setPlace((prev) => {
        const vp = viewport()
        const size = hudSizeIn(vp)
        const pos = clampHudPosition(prev.pos, size, vp)
        return pos.x === prev.pos.x && pos.y === prev.pos.y && size.width === prev.size.width && size.height === prev.size.height
          ? prev
          : { pos, size }
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const panelRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; dx: number; dy: number; pos: HudPoint } | null>(null)
  useLayoutEffect(() => {
    const el = panelRef.current
    if (el) el.style.transform = `translate3d(${place.pos.x}px, ${place.pos.y}px, 0)`
  }, [place.pos])

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      const target = e.target as Element | null
      if (!target?.closest || target.closest(CONTROLS)) return
      e.preventDefault()
      e.currentTarget.setPointerCapture?.(e.pointerId)
      drag.current = { id: e.pointerId, dx: e.clientX - place.pos.x, dy: e.clientY - place.pos.y, pos: place.pos }
    },
    [place.pos],
  )
  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const d = drag.current
      if (!d || d.id !== e.pointerId) return
      d.pos = clampHudPosition({ x: e.clientX - d.dx, y: e.clientY - d.dy }, place.size, viewport())
      if (panelRef.current) panelRef.current.style.transform = `translate3d(${d.pos.x}px, ${d.pos.y}px, 0)`
    },
    [place.size],
  )
  const endDrag = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    writeHudPosition(d.pos)
    setPlace((prev) => ({ ...prev, pos: d.pos }))
  }, [])

  // Escape collapses the chat, wherever focus is (but never over a dialog,
  // which takes its own Escape).
  const [expanded, setExpanded] = useState(false)
  const [collapseRequest, setCollapseRequest] = useState(0)
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return
      setCollapseRequest((n) => n + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  return (
    <div
      ref={panelRef}
      data-web-hud
      data-capture-id={captureId}
      role="complementary"
      aria-label="Live agent"
      className="fixed left-0 top-0 z-[45] cursor-grab touch-none select-none active:cursor-grabbing"
      style={{ width: place.size.width, height: place.size.height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <AgentHudView
        host="page"
        feed={feed}
        actions={actions}
        collapseRequest={collapseRequest}
        onChatExpandedChange={setExpanded}
        audioLevels={audioLevels}
        className="cursor-auto [&_textarea]:select-text"
      />
    </div>
  )
}
