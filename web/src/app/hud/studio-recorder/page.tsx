'use client'

/**
 * The Studio recording control (desktop: src-tauri/src/commands/studio_recorder.rs
 * studio_recorder_show_control loads {origin}/hud/studio-recorder?session=<id>
 * into the transparent, always-on-top, content-protected `studio-recorder`
 * window, so it never shows in the recording). A pill: the recording dot and
 * time, the microphone's level, Stop, and Cancel (a second click confirms:
 * it deletes the take). Drag it anywhere by its body.
 *
 * With a script or a checklist for the take, and a desktop build that can grow the control
 * (studio_recorder_control_size), the pill opens into a panel under it: the script, following the speaker from
 * the words heard live (`studio-recorder://live-words`), and the checklist (components/studio/prompter). The panel
 * is the same content-protected window, so it is never in the recording either. Resize it from its corner; the
 * button beside Cancel folds it back to the pill. The content comes from the Studio page (lib/studio/prompter/channel.ts).
 *
 * It only talks to the desktop: `studio-recorder://status` for the time and
 * level, `studio-recorder://stopped` to go away when the take ends from the
 * Studio page, `studio-recorder://error` to say the capture stopped. Stop
 * here is the same studio_recorder_stop the Studio page calls; the page
 * learns the result from `studio-recorder://stopped`.
 *
 * Development: ?session=dev&simulate=1 plays a made-up take through the panel (dev-harness.ts; not in production builds).
 */
import { useHudTheme } from '@/lib/hud-theme'
import { StudioRecorderError, studioRecorder } from '@/lib/tauri-bridge'
import { askForContent, dropHandoff, readHandoff, sayHello, type PrompterHandoff } from '@/lib/studio/prompter/channel'
import { hear, NOTHING_HEARD, type Heard, type LiveWordsEvent } from '@/lib/studio/prompter/live-words'
import { PrompterPanel } from '@/components/studio/prompter/PrompterPanel'
import { useCallback, useEffect, useRef, useState } from 'react'

type Phase = 'recording' | 'confirm-cancel' | 'finishing' | 'failed'

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0')
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

const PAGE_CSS = `
html, body { height: 100%; min-height: 0 !important; background: transparent !important; color-scheme: normal !important; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; -webkit-user-select: none; user-select: none; }
nextjs-portal { display: none !important; }
@keyframes studio-rec-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .35 } }
`

/** The pill's size, and the panel's first size (then the person's, remembered on this computer). */
const PILL = { width: 300, height: 56 }
const PANEL_DEFAULT = { width: 420, height: 480 }
const PANEL_KEY = 'ni:studio:prompter-panel-size'
/** How often an open panel is fitted to its display again (one unplugged or rearranged). */
const REFIT_MS = 5000

function readPanelSize(): { width: number; height: number } {
  try {
    const v = JSON.parse(localStorage.getItem(PANEL_KEY) ?? 'null') as { width?: unknown; height?: unknown } | null
    if (v && typeof v.width === 'number' && typeof v.height === 'number') return { width: v.width, height: v.height }
  } catch { /* a preference only */ }
  return PANEL_DEFAULT
}

export default function StudioRecorderControlPage() {
  useHudTheme()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [simulate, setSimulate] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [level, setLevel] = useState(0)
  const [phase, setPhase] = useState<Phase>('recording')
  const [message, setMessage] = useState<string | null>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The prompter: the take's content, the words heard, and whether the control is grown into its panel.
  const [content, setContent] = useState<PrompterHandoff | null>(null)
  const [heard, setHeard] = useState<Heard>(NOTHING_HEARD)
  const [panel, setPanel] = useState<'closed' | 'open' | 'unavailable'>('closed')
  const size = useRef(PANEL_DEFAULT)

  useEffect(() => {
    document.title = 'Recording'
    const params = new URLSearchParams(window.location.search)
    setSessionId(params.get('session'))
    setSimulate(params.get('simulate') === '1')
  }, [])

  const hasContent = !!content && (content.lines.length > 0 || content.items.length > 0)

  /** Grow into the panel (or fold back): an older desktop build can't, and keeps the pill. */
  const openPanel = useCallback(async (open: boolean) => {
    if (simulate) { setPanel(open ? 'open' : 'closed'); return }
    try {
      if (open) size.current = readPanelSize()
      await studioRecorder.controlSize(open ? size.current.width : PILL.width, open ? size.current.height : PILL.height)
      setPanel(open ? 'open' : 'closed')
    } catch {
      setPanel(open ? 'unavailable' : 'closed')
    }
  }, [simulate])

  // The content: the copy the Studio page left for this take, then the page's own answer (and any later change).
  useEffect(() => {
    if (!sessionId || simulate) return
    const left = readHandoff(sessionId)
    if (left) setContent(left)
    let got = !!left
    const off = askForContent(sessionId, (handoff) => { got = true; setContent(handoff) })
    // The page may not be listening yet at the very start: ask again a few times.
    let tries = 0
    const again = setInterval(() => {
      if (got || ++tries > 10) { clearInterval(again); return }
      const stored = readHandoff(sessionId)
      if (stored) { got = true; setContent(stored); return }
      sayHello(sessionId)
    }, 1500)
    return () => { off(); clearInterval(again) }
  }, [sessionId, simulate])

  // Opened on its own the first time there is something to show.
  const autoOpened = useRef(false)
  useEffect(() => {
    if (!hasContent || autoOpened.current) return
    autoOpened.current = true
    void openPanel(true)
  }, [hasContent, openPanel])

  // An open panel stays on its display (one unplugged or rearranged).
  useEffect(() => {
    if (panel !== 'open' || simulate) return
    const t = setInterval(() => { void studioRecorder.controlSize(size.current.width, size.current.height).catch(() => {}) }, REFIT_MS)
    return () => clearInterval(t)
  }, [panel, simulate])

  // Development: a made-up take (the production build has no such branch).
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' && simulate) {
      let stop = () => {}
      void import('./dev-harness').then(({ DEMO, playTake, devHarnessAllowed }) => {
        if (!devHarnessAllowed()) return
        setContent(DEMO)
        stop = playTake((event) => setHeard((h) => hear(h, event)), setElapsedMs)
      })
      return () => stop()
    }
  }, [simulate])

  useEffect(() => {
    if (!sessionId || simulate) return
    const offStatus = studioRecorder.onStatus((status) => {
      if (status.sessionId !== sessionId) return
      setElapsedMs(status.elapsedMs)
      // Ease the meter down so it reads as a level, not a flicker.
      setLevel((prev) => Math.max(status.levels?.mic ?? 0, prev * 0.6))
    })
    const offWords = studioRecorder.onLiveWords((event: LiveWordsEvent) => {
      if (event.sessionId === sessionId) setHeard((h) => hear(h, event))
    })
    const offStopped = studioRecorder.onStopped((event) => {
      if (event.sessionId !== sessionId) return
      dropHandoff(sessionId)
      void studioRecorder.hideControl().catch(() => {})
    })
    const offError = studioRecorder.onError((event) => {
      if (event.sessionId && event.sessionId !== sessionId) return
      if (event.fatal) {
        setMessage(event.message || 'The recording stopped.')
        setPhase('failed')
      }
    })
    return () => {
      offStatus()
      offWords()
      offStopped()
      offError()
    }
  }, [sessionId, simulate])

  useEffect(() => () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
  }, [])

  const stop = useCallback(async () => {
    if (!sessionId || phase === 'finishing') return
    setPhase('finishing')
    if (simulate) return
    try {
      await studioRecorder.stop(sessionId)
      dropHandoff(sessionId)
      void studioRecorder.hideControl().catch(() => {})
    } catch (e) {
      if (e instanceof StudioRecorderError && e.code === 'not-found') {
        void studioRecorder.hideControl().catch(() => {})
        return
      }
      setMessage(e instanceof Error ? e.message : 'The take could not be saved.')
      setPhase('failed')
    }
  }, [sessionId, phase, simulate])

  const cancel = useCallback(async () => {
    if (!sessionId || phase === 'finishing') return
    if (phase !== 'confirm-cancel') {
      setPhase('confirm-cancel')
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      confirmTimer.current = setTimeout(() => setPhase((p) => (p === 'confirm-cancel' ? 'recording' : p)), 3000)
      return
    }
    setPhase('finishing')
    if (simulate) return
    await studioRecorder.cancel(sessionId).catch(() => {})
    dropHandoff(sessionId)
    void studioRecorder.hideControl().catch(() => {})
  }, [sessionId, phase, simulate])

  // The panel's corner: drag to resize (the app clamps it and keeps it on screen).
  const resize = useRef<{ x: number; y: number; w: number; h: number; frame: number } | null>(null)
  const onResizeDown = (e: React.PointerEvent) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    resize.current = { x: e.screenX, y: e.screenY, w: size.current.width, h: size.current.height, frame: 0 }
  }
  const onResizeMove = (e: React.PointerEvent) => {
    const r = resize.current
    if (!r || r.frame) return
    const want = { width: r.w + e.screenX - r.x, height: r.h + e.screenY - r.y }
    r.frame = requestAnimationFrame(async () => {
      try { if (!simulate) size.current = await studioRecorder.controlSize(want.width, want.height) } catch { /* stays as it was */ }
      if (resize.current) resize.current.frame = 0
    })
  }
  const onResizeUp = () => {
    resize.current = null
    try { localStorage.setItem(PANEL_KEY, JSON.stringify(size.current)) } catch { /* a preference only */ }
  }

  const finishing = phase === 'finishing'
  const meter = Math.min(1, Math.max(0, level))
  const open = panel === 'open' && hasContent

  const pill = (
    <div
      data-tauri-drag-region
      className="flex h-full w-full items-center gap-3 rounded-full border border-black/10 bg-white/90 pl-4 pr-1.5 text-neutral-900 shadow-lg backdrop-blur-xl dark:border-white/10 dark:bg-neutral-900/90 dark:text-neutral-100"
    >
      <span
        data-tauri-drag-region
        aria-hidden
        className="size-2.5 shrink-0 rounded-full bg-red-500"
        style={{ animation: phase === 'recording' || phase === 'confirm-cancel' ? 'studio-rec-pulse 1.4s ease-in-out infinite' : undefined }}
      />
      {phase === 'failed' ? (
        <span data-tauri-drag-region className="min-w-0 flex-1 truncate text-xs text-red-600 dark:text-red-400" title={message ?? undefined}>
          {message}
        </span>
      ) : (
        <>
          <span data-tauri-drag-region className="w-14 shrink-0 font-mono text-sm tabular-nums" aria-label="Recording time">
            {finishing ? 'Saving' : clock(elapsedMs)}
          </span>
          <span
            data-tauri-drag-region
            className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-black/10 dark:bg-white/15"
            role="meter"
            aria-label="Microphone level"
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={Number(meter.toFixed(2))}
          >
            <span
              className="block h-full rounded-full bg-emerald-500 transition-[width] duration-150 ease-out"
              style={{ width: `${Math.round(meter * 100)}%` }}
            />
          </span>
        </>
      )}
      {hasContent && panel !== 'unavailable' ? (
        <button
          type="button"
          onClick={() => void openPanel(!open)}
          className="h-8 shrink-0 rounded-full px-2 text-xs font-medium text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
          aria-label={open ? 'Hide the script and checklist' : 'Show the script and checklist'}
          aria-expanded={open}
        >
          {open ? 'Hide' : content?.lines.length ? 'Script' : 'List'}
        </button>
      ) : null}
      <button
        type="button"
        onClick={cancel}
        disabled={finishing}
        className="h-8 shrink-0 rounded-full px-2.5 text-xs font-medium text-neutral-600 hover:bg-black/5 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-white/10"
        aria-label={phase === 'confirm-cancel' ? 'Confirm: delete this take' : 'Cancel the take'}
      >
        {phase === 'confirm-cancel' ? 'Delete?' : 'Cancel'}
      </button>
      <button
        type="button"
        onClick={stop}
        disabled={finishing || !sessionId}
        className="flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-red-500 px-3.5 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-60"
        aria-label="Stop recording"
      >
        <span aria-hidden className="size-2.5 rounded-[2px] bg-white" />
        {phase === 'failed' ? 'Save' : 'Stop'}
      </button>
    </div>
  )

  return (
    <>
      <style>{PAGE_CSS}</style>
      {open && content ? (
        <div className="flex h-screen w-screen flex-col gap-1.5 p-1">
          <div className="h-12 shrink-0">{pill}</div>
          <div className="relative flex min-h-0 flex-1 flex-col rounded-2xl border border-black/10 bg-white/95 p-3 shadow-lg backdrop-blur-xl dark:border-white/10 dark:bg-neutral-900/95"
            style={{ userSelect: 'text', WebkitUserSelect: 'text' }}>
            <PrompterPanel lines={content.lines} items={content.items} heard={heard} following={content.following} variant="hud" className="min-h-0 flex-1" />
            <span
              role="separator"
              aria-label="Resize"
              onPointerDown={onResizeDown}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeUp}
              onPointerCancel={onResizeUp}
              className="absolute bottom-0.5 right-0.5 size-4 cursor-nwse-resize rounded-br-2xl"
              style={{ background: 'linear-gradient(135deg, transparent 50%, rgba(127,127,127,.45) 50%, rgba(127,127,127,.45) 60%, transparent 60%, transparent 70%, rgba(127,127,127,.45) 70%, rgba(127,127,127,.45) 80%, transparent 80%)' }}
            />
          </div>
        </div>
      ) : (
        <div className="flex h-screen w-screen items-center justify-center p-1">{pill}</div>
      )}
    </>
  )
}
