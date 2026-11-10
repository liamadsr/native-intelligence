'use client'

/**
 * The live view of the agent's computer (docs/plans/cloud-browser.md, C3):
 * its real Chrome, streamed over VNC from the person's cloud browser, opened
 * from the side panel's computer card or by the agent (open_browser).
 *
 * View-only until the person presses Take over: the server then lets input
 * through (a fresh viewer token with control), and the agent's task stops at
 * its next step. Hand back returns the browser to the agent.
 *
 * The hub's token goes as the WebSocket's first message; once the hub says
 * `ok`, noVNC takes the socket and the client says `go`. A drop connects again
 * with a fresh token, backing off (1 s … 30 s) and giving up after a few tries
 * in a row. Only opening the view (or the person's Wake / Try again) may wake
 * the browser: connecting again by itself never does, so a forgotten window
 * shows "Asleep" instead of keeping the browser up. A window in the background
 * for 30 s lets go of the stream and connects again when it's back. A hand
 * back in another window (`driver-changed`) connects again here too, so input
 * ends everywhere at once.
 *
 * Closing the view while driving hands the browser back (so does leaving the
 * page); the agent's own close_browser never ends the person's session.
 *
 * On a Mac, ⌘-shortcuts reach the cloud Chrome as Ctrl-shortcuts, and ⌘ alone
 * never reaches it (noVNC would send it as Alt): ⌘V pastes this Mac's
 * clipboard (through the paste event, then Ctrl+V), and a copy in the cloud
 * lands on this Mac's clipboard.
 *
 * noVNC (rfb.mjs, scripts/cloud-browser/build-assets.mjs) loads only when a
 * live view opens. Flat cost otherwise: nothing runs while it is closed; a
 * minute's ping keeps a visible view's browser awake.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Hand, Loader2, MousePointer2, ShieldBan, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDesktopOS } from '@/components/desktop-titlebar'
import { useAssistantName } from '@/lib/voice/assistant-name-store'
import { closeLiveView, handBackOnExit, liveViewTicket, refreshComputer, setDriver, useComputer } from '@/lib/cloud-browser/computer-client'
import { BlockedSitesPanel } from './blocked-sites-panel'
import { blockSite, refreshBlockedSites, unblockSite, useBlockedSites } from './blocked-sites-store'

/** The subset of noVNC's RFB this view uses. */
interface Rfb extends EventTarget {
  viewOnly: boolean
  scaleViewport: boolean
  resizeSession: boolean
  focusOnClick: boolean
  sendKey(keysym: number, code: string | null, down?: boolean): void
  clipboardPasteFrom(text: string): void
  focus(): void
  disconnect(): void
}
type RfbConstructor = new (target: HTMLElement, channel: WebSocket, options?: { shared?: boolean }) => Rfb

/** A plain URL import: the bundle is a static asset, never part of the app's own. */
const RFB_URL = '/cloud-browser/rfb.mjs'
let rfbModule: Promise<RfbConstructor> | null = null
let rfbLoader = (): Promise<RfbConstructor> =>
  import(/* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ RFB_URL)
    .then((module: { default: RfbConstructor }) => module.default)
function loadRfb(): Promise<RfbConstructor> {
  rfbModule ??= rfbLoader()
  return rfbModule
}
/** Test-only: noVNC without the static asset. */
export function __setRfbLoaderForTests(loader: () => Promise<RfbConstructor>) { rfbLoader = loader; rfbModule = null }

const PING_MS = 60_000
const CONTROL_L = 0xffe3
/** Waits between tries in a row; the view gives up after the last. */
const RETRY_MS = [1000, 2000, 4000, 8000, 16_000, 30_000]
/** A window in the background this long lets go of the stream. */
const HIDDEN_PAUSE_MS = 30_000
/** ⌘V with no paste event within this long reads the clipboard itself. */
const PASTE_FALLBACK_MS = 300
const UNREACHABLE = 'Your browser could not be reached.'
type Phase =
  | { kind: 'connecting'; waking: boolean }
  | { kind: 'live'; control: boolean }
  | { kind: 'asleep' }
  | { kind: 'paused' }
  | { kind: 'error'; message: string }

export function CloudBrowserLiveView() {
  const { viewOpen } = useComputer()
  if (!viewOpen || typeof document === 'undefined') return null
  return createPortal(<LiveViewWindow />, document.body)
}

function LiveViewWindow() {
  const { name } = useAssistantName()
  const computer = useComputer()
  const device = useDesktopOS() === 'windows' ? 'this PC' : 'this Mac'
  const screenRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<Rfb | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'connecting', waking: true })
  // Each attempt connects once; only the opening one and the person's own Wake / Try again may wake the browser.
  const [attempt, setAttempt] = useState({ n: 0, wake: true })
  const [paused, setPaused] = useState(false)
  // The person's own list of sites the agent never uses (blocked-sites-store.ts), over the screen.
  const [sitesOpen, setSitesOpen] = useState(false)
  const failures = useRef(0)
  const connect = useCallback((wake: boolean) => setAttempt(previous => ({ n: previous.n + 1, wake })), [])
  const control = phase.kind === 'live' && phase.control

  // The driver changed in another window: connect again, with input or without.
  const epoch = useRef(computer.viewEpoch)
  useEffect(() => {
    if (computer.viewEpoch === epoch.current) return
    epoch.current = computer.viewEpoch
    connect(false)
  }, [computer.viewEpoch, connect])

  useEffect(() => {
    if (paused) { setPhase({ kind: 'paused' }); return }
    let cancelled = false
    let socket: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    setPhase({ kind: 'connecting', waking: attempt.wake })
    const fail = (message: string) => {
      if (cancelled) return
      failures.current++
      if (failures.current > RETRY_MS.length) { setPhase({ kind: 'error', message }); return }
      setPhase({ kind: 'connecting', waking: false })
      retry = setTimeout(() => connect(false), RETRY_MS[failures.current - 1])
    }
    void (async () => {
      const ticket = await liveViewTicket('view', attempt.wake)
      if (cancelled) return
      if (ticket.state === 'asleep') { setPhase({ kind: 'asleep' }); return }
      // The server said why (not set up, could not start): the person decides when to try again.
      if (ticket.state === 'error') { setPhase({ kind: 'error', message: ticket.message }); return }
      // Running (perhaps just started, the first time): the card shows it now, not at its next read.
      void refreshComputer()
      const RFB = await loadRfb().catch(() => null)
      if (cancelled) return
      if (!RFB) { setPhase({ kind: 'error', message: 'The live view could not load.' }); return }
      socket = new WebSocket(ticket.viewerUrl)
      socket.onopen = () => socket?.send(ticket.token)
      // Until noVNC takes the socket: the hub refused it (a stale token, too many viewers) or went away.
      socket.onclose = event => {
        if (cancelled || rfbRef.current) return
        if (event.code === 4429) { setPhase({ kind: 'error', message: 'Too many windows are watching your browser. Close one, then try again.' }); return }
        fail(UNREACHABLE)
      }
      // The hub's answer; noVNC replaces these handlers as it takes the socket.
      socket.onmessage = event => {
        if (cancelled || !socket || !screenRef.current || typeof event.data !== 'string') return
        let ok: { ok?: boolean; control?: boolean } = {}
        try { ok = JSON.parse(event.data) } catch { /* not the hub's answer */ }
        if (!ok.ok) return
        const rfb = new RFB(screenRef.current, socket, { shared: true })
        rfb.scaleViewport = true
        rfb.resizeSession = false
        rfb.viewOnly = !ok.control
        rfb.addEventListener('connect', () => { failures.current = 0 })
        rfb.addEventListener('clipboard', ((e: CustomEvent<{ text: string }>) => {
          void navigator.clipboard?.writeText(e.detail.text).catch(() => {})
        }) as EventListener)
        // Still open: come back with a fresh token (a control token ends with its lifetime; a sleeping browser stays asleep).
        rfb.addEventListener('disconnect', () => { rfbRef.current = null; fail(UNREACHABLE) })
        rfbRef.current = rfb
        socket.send('go')
        setPhase({ kind: 'live', control: ok.control === true })
      }
    })()
    return () => {
      cancelled = true
      clearTimeout(retry)
      rfbRef.current?.disconnect()
      rfbRef.current = null
      if (socket && socket.readyState <= WebSocket.OPEN) socket.close()
    }
  }, [attempt, connect, paused])

  // A window in the background lets go of the stream after a while, and connects again (never waking) when it's back.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onVisibility = () => {
      clearTimeout(timer)
      if (document.visibilityState === 'hidden') { timer = setTimeout(() => setPaused(true), HIDDEN_PAUSE_MS); return }
      setPaused(previous => {
        if (previous) { failures.current = 0; connect(false) }
        return false
      })
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility) }
  }, [connect])

  // Watching keeps the browser awake.
  useEffect(() => {
    if (phase.kind !== 'live') return
    const ping = () => { if (document.visibilityState === 'visible') void fetch('/api/account/browser/live/ping', { method: 'POST' }).catch(() => {}) }
    const timer = setInterval(ping, PING_MS)
    return () => clearInterval(timer)
  }, [phase.kind])

  // Leaving the page while driving hands the browser back.
  useEffect(() => {
    window.addEventListener('pagehide', handBackOnExit)
    return () => window.removeEventListener('pagehide', handBackOnExit)
  }, [])

  // ⌘-shortcuts as Ctrl-shortcuts in the cloud Chrome; ⌘ alone never reaches it; ⌘V through the paste event, with this Mac's clipboard.
  useEffect(() => {
    if (!control) return
    const swallowed = new Set<string>()
    let pasteFallback: ReturnType<typeof setTimeout> | undefined
    const sendCtrl = (keysym: number, code: string) => {
      const rfb = rfbRef.current
      if (!rfb) return
      rfb.sendKey(CONTROL_L, 'ControlLeft', true)
      rfb.sendKey(keysym, code, true)
      rfb.sendKey(keysym, code, false)
      rfb.sendKey(CONTROL_L, 'ControlLeft', false)
    }
    const paste = (text: string | undefined) => {
      if (!text || !rfbRef.current) return
      rfbRef.current.clipboardPasteFrom(text)
      sendCtrl(0x76, 'KeyV')
    }
    const onKey = (e: KeyboardEvent) => {
      if (!screenRef.current?.contains(document.activeElement)) return
      const swallow = () => { e.preventDefault(); e.stopImmediatePropagation() }
      if (e.key === 'Meta') { swallow(); return }
      if (e.type === 'keyup') { if (swallowed.delete(e.code)) swallow(); return }
      if (!e.metaKey || e.ctrlKey || e.key.length !== 1) return
      swallowed.add(e.code)
      if (e.key.toLowerCase() === 'v') {
        // noVNC never sees it, and the browser still fires its paste event.
        e.stopImmediatePropagation()
        clearTimeout(pasteFallback)
        pasteFallback = setTimeout(() => { void navigator.clipboard?.readText().then(paste, () => {}) }, PASTE_FALLBACK_MS)
        return
      }
      swallow()
      sendCtrl(e.key.toLowerCase().charCodeAt(0), e.code)
    }
    const onPaste = (e: ClipboardEvent) => {
      if (!screenRef.current?.contains(document.activeElement)) return
      clearTimeout(pasteFallback)
      e.preventDefault()
      paste(e.clipboardData?.getData('text/plain'))
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    window.addEventListener('paste', onPaste, true)
    return () => {
      clearTimeout(pasteFallback)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
      window.removeEventListener('paste', onPaste, true)
    }
  }, [control])

  // Esc closes a view-only window; while driving, Esc is the cloud Chrome's. With the sites panel open, Esc is the panel's.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !control && !sitesOpen) closeLiveView() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [control, sitesOpen])

  const tryAgain = () => { failures.current = 0; connect(true) }
  const takeOver = async () => { if (await setDriver('person')) connect(false) }
  const handBack = async () => { if (await setDriver('agent')) connect(false) }
  const state = control ? 'You’re driving' : computer.busy ? `${name} is working` : 'Watching'
  const note = phase.kind === 'connecting' ? (phase.waking ? 'Waking your browser…' : 'Connecting…')
    : phase.kind === 'asleep' ? 'Your browser is asleep.'
    : phase.kind === 'paused' ? 'Paused while this window is in the background.'
    : phase.kind === 'error' ? phase.message : ''

  return (
    // data-ni-browser + ph-no-capture: the screen and the blocked sites are the person's browsing,
    // kept out of Sentry breadcrumbs (isInBrowserSurface) and PostHog capture and replay.
    <div data-cloud-browser-live-view="" data-ni-browser="" className="ph-no-capture fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]">
      <div role="dialog" aria-modal="true" aria-label={`${name}’s computer`}
        // As wide as fits: the screen keeps 16:10 under the header and the driving note.
        className="flex max-h-full w-full max-w-[min(1280px,calc((100dvh_-_7.5rem)*1.6))] flex-col overflow-hidden rounded-2xl border border-border/60 bg-background shadow-2xl">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border/60 px-4">
          <span className={cn('size-2 shrink-0 rounded-full', phase.kind === 'live' ? 'bg-emerald-500' : phase.kind === 'error' ? 'bg-red-500'
            : phase.kind === 'asleep' || phase.kind === 'paused' ? 'bg-muted-foreground/40' : 'bg-amber-500')} aria-hidden />
          <h2 className="truncate text-sm font-medium">{name}’s computer</h2>
          <span data-live-view-state="" className="truncate text-xs text-muted-foreground">
            {phase.kind === 'live' ? state : phase.kind === 'error' ? 'Not connected' : phase.kind === 'asleep' ? 'Asleep' : phase.kind === 'paused' ? 'Paused' : note}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <button type="button" data-live-view-blocked-sites="" aria-label="Blocked sites" title="Sites your agent never uses"
              aria-expanded={sitesOpen} onClick={() => setSitesOpen(open => !open)}
              className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ShieldBan aria-hidden className="size-4" />
            </button>
            {phase.kind === 'live' && (control ? (
              <button type="button" data-live-view-hand-back="" onClick={() => void handBack()}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Hand aria-hidden className="size-3.5" /> Hand back to {name}
              </button>
            ) : (
              <button type="button" data-live-view-take-over="" onClick={() => void takeOver()}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-3 text-xs font-medium text-background hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <MousePointer2 aria-hidden className="size-3.5" /> Take over
              </button>
            ))}
            <button type="button" aria-label={control ? `Close and hand back to ${name}` : 'Close'} onClick={() => closeLiveView()}
              className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <X aria-hidden className="size-4" />
            </button>
          </div>
        </header>
        <div className="relative aspect-[16/10] w-full bg-neutral-950">
          <div ref={screenRef} data-live-view-screen="" className="absolute inset-0" />
          {sitesOpen && <SitesPanel onClose={() => setSitesOpen(false)} />}
          {phase.kind !== 'live' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-neutral-300">
              {phase.kind === 'connecting' ? <Loader2 aria-hidden className="size-5 animate-spin motion-reduce:animate-none" /> : null}
              <p>{note}</p>
              {(phase.kind === 'error' || phase.kind === 'asleep') && (
                <button type="button" onClick={tryAgain} className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs hover:bg-neutral-800">
                  {phase.kind === 'asleep' ? 'Wake' : 'Try again'}
                </button>
              )}
            </div>
          )}
        </div>
        {control && (
          <p className="shrink-0 border-t border-border/60 px-4 py-2 text-xs text-muted-foreground">
            {name} has stopped while you drive; closing this hands it back. Passwords and passkeys from {device} don’t reach the cloud browser: type them here.
          </p>
        )}
      </div>
    </div>
  )
}

/** The blocked-sites panel, its list loaded only once it opens. */
function SitesPanel({ onClose }: { onClose: () => void }) {
  const blocked = useBlockedSites()
  return (
    <BlockedSitesPanel currentSite={null} currentBlockedBy={null} blocked={blocked} onBlock={blockSite} onUnblock={unblockSite}
      onRetry={() => void refreshBlockedSites()} onClose={onClose} />
  )
}
