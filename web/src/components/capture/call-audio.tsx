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

async function audioLink(captureId: string, fileId: string, as: 'play' | 'download'): Promise<string | null> {
  try {
    const res = await fetch(`/api/account/captures/${captureId}/audio?file=${fileId}&as=${as}`)
    if (!res.ok) return null
    const json = (await res.json()) as { url?: string }
    return typeof json.url === 'string' && /^https?:/.test(json.url) ? json.url : null
  } catch {
    return null
  }
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
  /** The day it will be deleted, said for this one ('one'), for all the parts above too ('several': under the last), or not here (null). */
  note?: 'one' | 'several' | null
}) {
  const audio = useRef<HTMLAudioElement | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'paused'>('idle')
  const [at, setAt] = useState(0)
  const [length, setLength] = useState(file.durationMs ?? 0)
  const [downloading, setDownloading] = useState(false)
  const retried = useRef(false)

  const start = async () => {
    const el = audio.current
    if (!el) return
    if (state === 'playing') {
      el.pause()
      return
    }
    if (!el.src) {
      setState('loading')
      const url = await audioLink(captureId, file.id, 'play')
      if (!url) {
        setState('idle')
        toast('That audio can’t be played.')
        return
      }
      el.src = url
    }
    try {
      await el.play()
    } catch {
      setState('paused')
    }
  }

  const download = async () => {
    if (downloading) return
    setDownloading(true)
    const url = await audioLink(captureId, file.id, 'download')
    setDownloading(false)
    if (!url) {
      toast('That audio can’t be downloaded.')
      return
    }
    // The link names the file: the browser (or, in the desktop app, the person's own) saves it.
    await openExternalUrl(url)
  }

  const progress = length > 0 ? Math.min(1, at / length) : 0
  return (
    <div data-capture-call-audio="ready" className="space-y-1.5 px-3 py-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-capture-call-audio-play=""
          aria-label={state === 'playing' ? `Pause ${label.toLowerCase()}` : `Play ${label.toLowerCase()}`}
          onClick={() => void start()}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-85 disabled:opacity-60"
          disabled={state === 'loading'}
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
                const el = audio.current
                if (el && length > 0) el.currentTime = (Number(e.target.value) / 1000) * (length / 1000)
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
        onPause={() => setState('paused')}
        onEnded={() => setState('paused')}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime * 1000)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration
          if (Number.isFinite(d) && d > 0) setLength(d * 1000)
        }}
        onError={() => {
          // The hour's link ran out while the page was open: one fresh link, then give up.
          const el = audio.current
          if (!el || retried.current) {
            setState('idle')
            return
          }
          retried.current = true
          el.removeAttribute('src')
          el.load()
          void start()
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
  // Every part of a call is deleted the same day (30 days from the call): said once, under the last kept one.
  const lastReady = files.map((f) => f.state).lastIndexOf('ready')
  const readyCount = files.filter((f) => f.state === 'ready').length
  return (
    <div data-capture-call-audio-files="" className="py-0.5">
      {files.map((f, i) => (
        <CallAudioFile
          key={f.id}
          captureId={captureId}
          file={f}
          label={several ? `Call audio, part ${i + 1}` : 'Call audio'}
          note={i !== lastReady ? null : readyCount > 1 ? 'several' : 'one'}
        />
      ))}
    </div>
  )
}
