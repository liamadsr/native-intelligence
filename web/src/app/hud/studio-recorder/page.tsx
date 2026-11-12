'use client'

/**
 * The Studio recording control (desktop: src-tauri/src/commands/studio_recorder.rs
 * studio_recorder_show_control loads {origin}/hud/studio-recorder?session=<id>
 * into the transparent, always-on-top, content-protected `studio-recorder`
 * window, so it never shows in the recording). A pill: the recording dot and
 * time, the microphone's level, Stop, and Cancel (a second click confirms:
 * it deletes the take). Drag it anywhere by its body.
 *
 * It only talks to the desktop: `studio-recorder://status` for the time and
 * level, `studio-recorder://stopped` to go away when the take ends from the
 * Studio page, `studio-recorder://error` to say the capture stopped. Stop
 * here is the same studio_recorder_stop the Studio page calls; the page
 * learns the result from `studio-recorder://stopped`.
 */
import { useHudTheme } from '@/lib/hud-theme'
import { StudioRecorderError, studioRecorder } from '@/lib/tauri-bridge'
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

export default function StudioRecorderControlPage() {
  useHudTheme()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [level, setLevel] = useState(0)
  const [phase, setPhase] = useState<Phase>('recording')
  const [message, setMessage] = useState<string | null>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    document.title = 'Recording'
    setSessionId(new URLSearchParams(window.location.search).get('session'))
  }, [])

  useEffect(() => {
    if (!sessionId) return
    const offStatus = studioRecorder.onStatus((status) => {
      if (status.sessionId !== sessionId) return
      setElapsedMs(status.elapsedMs)
      // Ease the meter down so it reads as a level, not a flicker.
      setLevel((prev) => Math.max(status.levels?.mic ?? 0, prev * 0.6))
    })
    const offStopped = studioRecorder.onStopped((event) => {
      if (event.sessionId !== sessionId) return
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
      offStopped()
      offError()
    }
  }, [sessionId])

  useEffect(() => () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
  }, [])

  const stop = useCallback(async () => {
    if (!sessionId || phase === 'finishing') return
    setPhase('finishing')
    try {
      await studioRecorder.stop(sessionId)
      void studioRecorder.hideControl().catch(() => {})
    } catch (e) {
      if (e instanceof StudioRecorderError && e.code === 'not-found') {
        void studioRecorder.hideControl().catch(() => {})
        return
      }
      setMessage(e instanceof Error ? e.message : 'The take could not be saved.')
      setPhase('failed')
    }
  }, [sessionId, phase])

  const cancel = useCallback(async () => {
    if (!sessionId || phase === 'finishing') return
    if (phase !== 'confirm-cancel') {
      setPhase('confirm-cancel')
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      confirmTimer.current = setTimeout(() => setPhase((p) => (p === 'confirm-cancel' ? 'recording' : p)), 3000)
      return
    }
    setPhase('finishing')
    await studioRecorder.cancel(sessionId).catch(() => {})
    void studioRecorder.hideControl().catch(() => {})
  }, [sessionId, phase])

  const finishing = phase === 'finishing'
  const meter = Math.min(1, Math.max(0, level))

  return (
    <>
      <style>{PAGE_CSS}</style>
      <div className="flex h-screen w-screen items-center justify-center p-1">
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
      </div>
    </>
  )
}
