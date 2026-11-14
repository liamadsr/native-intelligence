'use client'

/**
 * A call's audio in its capture's properties (migration 650): the call
 * recorder keeps one sound file of the call for 30 days. While it is kept it
 * plays here, with a Download button to keep a copy and the day it will be
 * deleted; once deleted it says the day it was, and nothing plays. A call
 * whose audio is still on its way says so; a capture with no audio draws
 * nothing.
 *
 * Only a capture a team call's recorder filled (metadata.source 'team_call')
 * asks the server at all: every other capture keeps no sound, and its page
 * makes no request for one. The server reads the capture as the person
 * first (its RLS: the owner and the conversation's readers), and each link,
 * to play or to download, is made for them when asked, signed and an hour
 * long; nothing is fetched before Play.
 */

import { useEffect, useRef, useState } from 'react'
import { AudioLines, Download, Loader2, Pause, Play } from 'lucide-react'
import { toast } from 'sonner'
import { openExternalUrl } from '@/lib/open-external'
import type { CaptureAudioView } from '@/lib/capture-feed/audio'

/** "13 Dec 2026", in the person's own way of writing dates. */
export function audioDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** "4:05", "1:02:09". */
export function clock(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms < 0) return '0:00'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** A link is renewed this long before it runs out (or at half its life, if that is sooner), so no request is ever made on a dead one. */
export const LINK_MARGIN_MS = 60_000
/** The longest a link may take to come (first Play), or a renewal to come and load, before the player gives the control back. */
export const RENEW_WAIT_MS = 15_000

/**
 * A link to the file, and when it runs out, on two clocks: the wall clock (it runs on while the
 * computer sleeps, which the link's life does too) and the page's own steady one (it never steps
 * back when the device's clock is set back). Either saying "run out" is enough.
 */
interface AudioLink {
  url: string
  /** Epoch ms. */
  until: number
  /** performance.now() ms. */
  steadyUntil: number
  /** How long it lasts, ms. */
  life: number
}

async function audioLink(captureId: string, fileId: string, as: 'play' | 'download', signal?: AbortSignal): Promise<AudioLink | null> {
  try {
    const res = await fetch(`/api/account/captures/${captureId}/audio?file=${fileId}&as=${as}`, signal ? { signal } : undefined)
    if (!res.ok) return null
    const json = (await res.json()) as { url?: string; expiresIn?: number }
    if (typeof json.url !== 'string' || !/^https?:/.test(json.url)) return null
    const life = (typeof json.expiresIn === 'number' && json.expiresIn > 0 ? json.expiresIn : 3600) * 1000
    return { url: json.url, until: Date.now() + life, steadyUntil: performance.now() + life, life }
  } catch {
    return null
  }
}

/** Has this link run out, or is about to (within the margin: a minute, or half its life when that is shorter)? Pure. */
export function linkStale(link: Pick<AudioLink, 'until' | 'steadyUntil' | 'life'> | null, wallNow: number, steadyNow: number): boolean {
  if (!link) return true
  const margin = Math.min(LINK_MARGIN_MS, link.life / 2)
  return wallNow > link.until - margin || steadyNow > link.steadyUntil - margin
}

/** A capture's files, or null while unknown (and for a capture with none to ask about). */
function useCaptureAudio(captureId: string, wanted: boolean): CaptureAudioView[] | null {
  const [files, setFiles] = useState<CaptureAudioView[] | null>(null)
  useEffect(() => {
    if (!wanted) return
    let alive = true
    void fetch(`/api/account/captures/${captureId}/audio`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { files?: CaptureAudioView[] } | null) => {
        if (alive) setFiles(Array.isArray(json?.files) ? json.files : [])
      })
      .catch(() => {
        if (alive) setFiles([])
      })
    return () => {
      alive = false
    }
  }, [captureId, wanted])
  return wanted ? files : null
}

/** One kept file: play and pause, where it is, Download, and the day it will be deleted. */
export function CallAudioPlayer({
  captureId,
  file,
  label,
  note = 'one',
}: {
  captureId: string
  file: CaptureAudioView
  label: string
  /** The day it will be deleted, said for this one ('one'), for every part when they share it ('several': under the last), or not here (null). */
  note?: 'one' | 'several' | null
}) {
  const audio = useRef<HTMLAudioElement | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'paused'>('idle')
  const [at, setAt] = useState(0)
  const [length, setLength] = useState(file.durationMs ?? 0)
  const [downloading, setDownloading] = useState(false)
  // The person asked for sound (Play), until they pause or it ends: a link renewed mid-listen plays on.
  const wantPlay = useRef(false)
  // Where to go on from once a renewed link's file is loaded.
  const resumeAt = useRef<number | null>(null)
  // A wait under way: a link being fetched (the first Play, or a renewal) or a renewed file loading,
  // from the moment it starts to when it settles: loaded, given up, paused, or the player gone. Every
  // other trigger waits for it; Pause drops it.
  const renewing = useRef(false)
  // Each wait's number: an answer that comes for one already given up (or paused) is dropped.
  const attempt = useRef(0)
  // Its new link is set on the element: an error from now on is the fresh link's own.
  const freshSet = useRef(false)
  // The current link (null: none yet, or given up).
  const link = useRef<AudioLink | null>(null)
  // Where it was when the player gave up: Play goes on from there with a fresh link.
  const resumeAfterGiveUp = useRef<number | null>(null)
  // The wait's clock, from before the link is fetched: given up after RENEW_WAIT_MS.
  const renewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    const el = audio.current
    return () => {
      // Gone (another page, another capture): no timer, no line said later, nothing loading.
      alive.current = false
      if (renewTimer.current) clearTimeout(renewTimer.current)
      renewTimer.current = null
      renewing.current = false
      if (el) {
        el.removeAttribute('src')
        el.load()
      }
    }
  }, [])

  const stale = () => linkStale(link.current, Date.now(), performance.now())

  const settle = () => {
    if (renewTimer.current) clearTimeout(renewTimer.current)
    renewTimer.current = null
    renewing.current = false
    freshSet.current = false
  }

  /**
   * Give the control back, with a line saying why (none when the person paused). The wait under way
   * is dropped, and so is the link (an element in error never plays again); where it was is kept,
   * and shown: Play then fetches a fresh link and goes on from there.
   */
  const giveUp = (line: string | null) => {
    const el = audio.current
    settle()
    attempt.current++
    const at = resumeAt.current ?? (el && el.currentTime > 0 ? el.currentTime : null)
    resumeAfterGiveUp.current = at
    resumeAt.current = null
    wantPlay.current = false
    link.current = null
    if (el) {
      el.removeAttribute('src')
      el.load()
    }
    if (!alive.current) return
    if (at !== null) setAt(at * 1000)
    setState(at === null ? 'idle' : 'paused')
    if (line) toast(line)
  }

  /** Start a wait: from now, not from when its link comes, it is given up after RENEW_WAIT_MS. */
  const begin = () => {
    renewing.current = true
    freshSet.current = false
    setState('loading')
    if (renewTimer.current) clearTimeout(renewTimer.current)
    renewTimer.current = setTimeout(() => {
      renewTimer.current = null
      if (renewing.current) giveUp('The audio is slow to load. Press play to try again.')
    }, RENEW_WAIT_MS)
  }

  /**
   * A fresh link on the element. 'dropped': the wait it was for ended before it came (given up,
   * paused, the player gone), so it changes nothing.
   */
  const load = async (): Promise<'set' | 'failed' | 'dropped'> => {
    const mine = ++attempt.current
    const fresh = await audioLink(captureId, file.id, 'play')
    const el = audio.current
    if (!alive.current || !el || mine !== attempt.current || !renewing.current) return 'dropped'
    if (!fresh) return 'failed'
    link.current = fresh
    el.src = fresh.url
    return 'set'
  }

  /**
   * A fresh link for the file, the place kept, and on where it was if it was playing. Used when
   * the link has run out, or is about to and the file is needed (Play, a move along the bar, a
   * stall), and when the browser says the old one failed. A request on a dead link does not always
   * fail loudly: WebKit (the desktop app, the iPhone) reads the refusal as the file and stalls, so
   * the player never waits for that. One renewal at a time: a second trigger while one is under
   * way (WebKit says `stalled` and `waiting` together) changes nothing: the old element's place it
   * carries is never better than the renewal's (a move along the bar sets that one itself). The
   * place is kept from the start, so a renewal that fails still knows it. Loading is asked for
   * outright (`preload` and `load()`), and the whole of it, the link's fetch included, is waited on
   * for RENEW_WAIT_MS at most; a fresh link that fails as well, or never comes or loads, gives the
   * control back with a line.
   */
  const renew = async (at: number) => {
    const el = audio.current
    if (!el || renewing.current) return
    begin()
    resumeAt.current = Number.isFinite(at) ? at : 0
    el.preload = 'auto'
    const got = await load()
    if (got === 'dropped') return
    if (got === 'failed') return giveUp('That audio can’t be played.')
    freshSet.current = true
    el.load()
  }

  const start = async () => {
    const el = audio.current
    if (!el) return
    if (renewing.current) {
      // Pause while the sound is on its way: the wait is dropped, and where it was kept.
      giveUp(null)
      return
    }
    if (state === 'playing') {
      wantPlay.current = false
      el.pause()
      return
    }
    wantPlay.current = true
    if (resumeAfterGiveUp.current !== null) {
      // After a give-up: a fresh link, on from where it stopped.
      const at = resumeAfterGiveUp.current
      resumeAfterGiveUp.current = null
      return renew(at)
    }
    if (!el.getAttribute('src')) {
      begin()
      resumeAt.current = null
      const got = await load()
      if (got === 'dropped') return
      if (got === 'failed') return giveUp('That audio can’t be played.')
      // The link came: the browser loads the file as it plays (it says when it is waiting).
      settle()
    } else if (stale()) {
      // Paused past the link's life: a fresh one first, on from the same place.
      return renew(el.currentTime)
    }
    try {
      await el.play()
    } catch {
      if (alive.current) setState('paused')
    }
  }

  /** A move along the bar: past the link's life, a fresh link first (a dead one would stall). */
  const seek = (seconds: number) => {
    const el = audio.current
    if (!el) return
    setAt(seconds * 1000)
    if (renewing.current) resumeAt.current = seconds
    else if (resumeAfterGiveUp.current !== null) resumeAfterGiveUp.current = seconds
    else if (stale()) void renew(seconds)
    else el.currentTime = seconds
  }

  const download = async () => {
    if (downloading) return
    setDownloading(true)
    // An answer that never comes gives the button back.
    const link = await audioLink(captureId, file.id, 'download', typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(RENEW_WAIT_MS) : undefined)
    setDownloading(false)
    if (!link) {
      toast('That audio can’t be downloaded.')
      return
    }
    // The link names the file: the browser (or, in the desktop app, the person's own) saves it.
    await openExternalUrl(link.url)
  }

  const progress = length > 0 ? Math.min(1, at / length) : 0
  return (
    <div data-capture-call-audio="ready" className="space-y-1.5 px-3 py-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-capture-call-audio-play=""
          aria-label={state === 'playing' || state === 'loading' ? `Pause ${label.toLowerCase()}` : `Play ${label.toLowerCase()}`}
          onClick={() => void start()}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-85"
        >
          {/* Solid glyphs at full strength (the app's `.lucide` rule dims every icon otherwise). */}
          {state === 'loading' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ opacity: 1 }} />
          ) : state === 'playing' ? (
            <Pause className="h-3 w-3 fill-current" style={{ opacity: 1 }} />
          ) : (
            <Play className="ml-0.5 h-3 w-3 fill-current" style={{ opacity: 1 }} />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="truncate text-foreground/80">{label}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {state === 'idle' ? clock(length) : `${clock(at)} / ${clock(length)}`}
            </span>
          </div>
          {/* Where it is: a thin bar, with the range over it to move (invisible, but a real control). */}
          <div className="relative mt-1.5 h-1 w-full rounded-full bg-muted">
            <div className="absolute inset-y-0 left-0 rounded-full bg-foreground/70" style={{ width: `${progress * 100}%` }} />
            <input
              type="range"
              aria-label="Position"
              min={0}
              max={1000}
              value={Math.round(progress * 1000)}
              disabled={state === 'idle' || state === 'loading'}
              onChange={(e) => {
                if (length > 0) seek((Number(e.target.value) / 1000) * (length / 1000))
              }}
              className="absolute -inset-y-1.5 inset-x-0 h-4 w-full cursor-pointer opacity-0 disabled:cursor-default"
            />
          </div>
        </div>
        <button
          type="button"
          data-capture-call-audio-download=""
          aria-label="Download the audio"
          title="Download"
          onClick={() => void download()}
          disabled={downloading}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-60"
        >
          {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-4 w-4" />}
        </button>
      </div>
      {note && (
        <p data-capture-call-audio-expires="" className="pl-9 text-xs text-muted-foreground">
          {note === 'several' ? 'These will be deleted on ' : 'Will be deleted on '}
          {audioDay(file.expiresAt)}. Download {note === 'several' ? 'them' : 'it'} to keep a copy.
        </p>
      )}
      <audio
        ref={audio}
        preload="none"
        onPlay={() => setState('playing')}
        onPause={() => setState((s) => (s === 'loading' ? s : 'paused'))}
        onEnded={() => {
          wantPlay.current = false
          setState('paused')
        }}
        onTimeUpdate={(e) => {
          // A place kept for a renewal, or after a give-up, stays shown (the element says 0 meanwhile).
          if (resumeAt.current === null && resumeAfterGiveUp.current === null) setAt(e.currentTarget.currentTime * 1000)
        }}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget
          const d = el.duration
          if (Number.isFinite(d) && d > 0) setLength(d * 1000)
          // The old link's, while the fresh one is still being fetched: the renewal goes on.
          if (renewing.current && !freshSet.current) return
          settle()
          const resume = resumeAt.current
          resumeAt.current = null
          if (resume === null) return
          // A renewed link: back to where it was, and on if it was playing.
          el.currentTime = resume
          setAt(resume * 1000)
          if (wantPlay.current) void el.play().catch(() => alive.current && setState('paused'))
          else setState('paused')
        }}
        onWaiting={(e) => {
          // Waiting on a link that has run out: it never comes in WebKit (see `renew`).
          if (wantPlay.current && stale()) void renew(e.currentTarget.currentTime)
        }}
        onStalled={(e) => {
          if (wantPlay.current && stale()) void renew(e.currentTarget.currentTime)
        }}
        onError={(e) => {
          if (!e.currentTarget.getAttribute('src')) return
          // The fresh link failed as well: give up. The old one failing while the fresh one is being
          // fetched changes nothing. Otherwise: renew.
          if (renewing.current) {
            if (freshSet.current) giveUp('That audio can’t be played.')
            return
          }
          void renew(e.currentTarget.currentTime)
        }}
        className="hidden"
      />
    </div>
  )
}

/** One file's row, whatever it is now. */
export function CallAudioFile({ captureId, file, label, note }: { captureId: string; file: CaptureAudioView; label: string; note?: 'one' | 'several' | null }) {
  if (file.state === 'ready') return <CallAudioPlayer captureId={captureId} file={file} label={label} note={note} />
  return (
    <div data-capture-call-audio={file.state} className="flex min-h-8 items-start gap-2 px-3 py-1.5 text-sm text-muted-foreground">
      <AudioLines className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{file.state === 'deleted' ? `${label} was deleted on ${audioDay(file.deletedAt ?? file.expiresAt)}.` : `Saving ${label.toLowerCase()}…`}</span>
    </div>
  )
}

/** A capture's call audio in its properties; nothing for a capture without any. */
export function CallAudioRow({ captureId, metadata }: { captureId: string; metadata: Record<string, unknown> | null | undefined }) {
  const files = useCaptureAudio(captureId, metadata?.source === 'team_call')
  if (!files || files.length === 0) return null
  const several = files.length > 1
  // Each file goes on its own day (30 days from the start of the round it was heard in). When the
  // kept ones share one day it is said once, under the last; when they differ, each says its own.
  const ready = files.filter((f) => f.state === 'ready')
  const lastReady = files.map((f) => f.state).lastIndexOf('ready')
  const oneDay = new Set(ready.map((f) => audioDay(f.expiresAt))).size <= 1
  const noteFor = (i: number): 'one' | 'several' | null => (files[i].state !== 'ready' ? null : !oneDay ? 'one' : i !== lastReady ? null : ready.length > 1 ? 'several' : 'one')
  return (
    <div data-capture-call-audio-files="" className="py-0.5">
      {files.map((f, i) => (
        <CallAudioFile
          key={f.id}
          captureId={captureId}
          file={f}
          label={several ? `Call audio, part ${i + 1}` : 'Call audio'}
          note={noteFor(i)}
        />
      ))}
    </div>
  )
}
