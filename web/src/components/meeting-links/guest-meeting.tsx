'use client'

/**
 * A meeting guest's page (calls plan, phase 7): someone without an account
 * who opened a meeting link. Light on purpose: no app around it, and the
 * LiveKit SDK is fetched only once a member has let them in
 * (src/lib/team-calls/call-session.ts loads it on connect).
 *
 *   1. Their name, a camera preview (off until they turn it on), and, when
 *      the meeting's call has notes or a recording on, a plain statement of
 *      it before anything of theirs is sent. Pressing "Ask to join" is when
 *      the browser asks for the microphone, never before.
 *   2. The lobby: they wait until someone in the call lets them in. Their
 *      page asks the server every 3 seconds while it is on screen (it has
 *      no database session), and stops while the tab is hidden.
 *   3. The call: who is in it, their own mic, camera and screen, Leave. No
 *      team chat, no member list beyond who is in the call, no notes or
 *      recording controls; a badge says when either is on (asked every 10
 *      seconds). The server decides what they have said go to (each notes
 *      round, and the recording): when notes or a recording come on that they
 *      haven't, it takes their publishing away in LiveKit, the page sees that
 *      at once (the permission event), holds their microphone and shows the
 *      notice; "Join with microphone" records their go and gives it back.
 *      With no member left in the call, the page says the host has left (the
 *      sweeper ends a call left to guests after a few minutes). Where the
 *      call's notes are shown in the call (TEAM_CALL_LIVE_AGENT), the guest
 *      can open what has been said since they came in: the call's own words
 *      only, never the members' summary, and only while they are in it.
 *
 * Nothing runs without a reason: no animation loop, no timer while hidden.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Mic, MicOff, MonitorUp, PhoneOff, Video, VideoOff, Volume2, WifiOff } from 'lucide-react'
import { Mark } from '@/components/logo'
import { cn } from '@/lib/utils'
import { TeamCallSession, type CallEnd, type CallSnapshot, type TeamCallJoin } from '@/lib/team-calls/call-session'
import { MEETING_GUEST_NAME_MAX, MEETING_LOBBY_POLL_MS, cleanGuestName } from '@/lib/meeting-links/shape'
import { CallBadges, IconButton, TileView, callErrorLine, deviceNotice, initialsOf } from '@/components/team-calls/call-tiles'
import { GuestCallNotes } from '@/components/team-calls/call-live-notes'

type Done = 'declined' | 'removed' | 'left' | 'ended' | 'inactive' | 'full' | 'limited' | 'early' | 'elsewhere' | 'error'

type Phase =
  | { kind: 'entry'; error?: string }
  | { kind: 'asking' }
  | { kind: 'waiting' }
  | { kind: 'joining' }
  | { kind: 'call'; session: TeamCallSession }
  | { kind: 'done'; why: Done }

interface OnNow {
  notes: boolean
  recording: boolean
}

const DONE_COPY: Record<Done, { title: string; body: string; again?: boolean }> = {
  declined: { title: 'You weren’t let in', body: 'Someone in the meeting declined your request.' },
  removed: { title: 'You were removed from the meeting', body: 'You can’t join it again from this link.' },
  left: { title: 'You left the meeting', body: 'You can close this page.', again: true },
  ended: { title: 'The meeting ended', body: 'You can close this page.', again: true },
  inactive: { title: 'This link is no longer active', body: 'Ask the person who sent it for a new one.' },
  full: { title: 'Too many people are waiting', body: 'Try again in a few minutes.', again: true },
  limited: { title: 'Too many tries', body: 'Wait a minute, then try again.', again: true },
  early: { title: 'This meeting hasn’t started yet', body: 'Come back closer to its start.' },
  elsewhere: { title: 'You joined somewhere else', body: 'This page left the call.' },
  error: { title: 'Something went wrong', body: 'Try again in a moment.', again: true },
}

async function post(url: string, body?: unknown): Promise<Response | null> {
  try {
    return await fetch(url, { method: 'POST', headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch {
    return null
  }
}

/** What a refused request means, by its code. */
async function doneOf(res: Response | null): Promise<Done> {
  if (!res) return 'error'
  const json = (await res.json().catch(() => null)) as { code?: string } | null
  switch (json?.code) {
    case 'MEETING_INACTIVE':
      return 'inactive'
    case 'MEETING_EARLY':
      return 'early'
    case 'LOBBY_FULL':
      return 'full'
    case 'RATE_LIMITED':
      return 'limited'
    default:
      return 'error'
  }
}

export function GuestMeeting({
  token,
  title,
  host,
  notes,
  recording,
  notesOffered = false,
  liveNotes = false,
  liveAgent = false,
}: {
  token: string
  title: string
  host: string | null
  notes: boolean
  recording: boolean
  /** The server offers notes: the microphone is sent as a member's is then (no DTX; a mute ends the track while notes are on). */
  notesOffered?: boolean
  /** The notes are the call recorder's: DTX stays on, and a mute only mutes. */
  liveNotes?: boolean
  /** The call's notes are shown in the call (phase 2): to a guest, what has been said since they came in. */
  liveAgent?: boolean
}) {
  const base = `/m/${token}`
  const [phase, setPhase] = useState<Phase>({ kind: 'entry' })
  const [name, setName] = useState('')
  const [onNow, setOnNow] = useState<OnNow>({ notes, recording })
  // Members in the call right now (the lobby poll): none means the host has left.
  const [membersInCall, setMembersInCall] = useState<number | null>(null)
  // Ask the lobby now (set by the poll effect): the server took their publishing away mid-call.
  const askNow = useRef<(() => void) | null>(null)
  const [camera, setCamera] = useState<'off' | 'on' | 'blocked'>('off')
  const preview = useRef<MediaStream | null>(null)
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  const stopPreview = useCallback(() => {
    for (const t of preview.current?.getTracks() ?? []) t.stop()
    preview.current = null
  }, [])
  useEffect(() => stopPreview, [stopPreview])

  const toggleCamera = useCallback(async () => {
    if (camera === 'on') {
      stopPreview()
      setCamera('off')
      return
    }
    try {
      preview.current = await navigator.mediaDevices.getUserMedia({ video: true })
      setCamera('on')
    } catch {
      setCamera('blocked')
    }
  }, [camera, stopPreview])

  const finish = useCallback(
    (why: Done) => {
      stopPreview()
      setPhase({ kind: 'done', why })
    },
    [stopPreview],
  )

  /** Admitted: a token, then into the room (the SDK is fetched now, not before). */
  const enter = useCallback(async () => {
    setPhase({ kind: 'joining' })
    // The server decides listen-only: from what this guest has said go to (each notes round, the recording).
    const fetchJoin = async (): Promise<{ join: TeamCallJoin; call: OnNow } | null> => {
      const res = await post(`${base}/token`)
      if (!res?.ok) return null
      const json = (await res.json().catch(() => null)) as { join?: TeamCallJoin; call?: { notes?: boolean; recording?: string } } | null
      if (!json?.join) return null
      return { join: json.join, call: { notes: json.call?.notes === true, recording: json.call?.recording === 'on' || json.call?.recording === 'starting' } }
    }
    const first = await fetchJoin()
    if (!first) {
      finish('ended')
      return
    }
    setOnNow(first.call)
    const session = new TeamCallSession(
      { callId: first.join.callId, channelId: '', channelKind: 'meeting', label: title, notesOffered, liveNotes },
      {
        refreshJoin: async () => (await fetchJoin())?.join ?? null,
        // "Join with microphone": the server records their go and lets their connection publish.
        allowPublish: async () => (await post(`${base}/notice`))?.ok === true,
        // The server held them for a notice mid-call: ask what is on now, at once.
        onPublishBlocked: () => askNow.current?.(),
        hangUp: async () => {
          await post(`${base}/leave`)
        },
        onEnded: (why: CallEnd) => finish(why === 'removed' ? 'removed' : why === 'left' ? 'left' : why === 'elsewhere' ? 'elsewhere' : 'ended'),
      },
    )
    // Held for the notice: the server gave a listen-only token (notes or a recording came on after they asked).
    const holdMic = first.join.canPublish === false
    const wantCamera = !!preview.current && !holdMic
    stopPreview()
    session.setNotesMode(first.call.notes)
    setPhase({ kind: 'call', session })
    await session.connect(first.join, { holdMic })
    if (wantCamera && session.getSnapshot().phase === 'connected') await session.toggleCamera()
  }, [base, title, notesOffered, liveNotes, finish, stopPreview])

  // The lobby, and the call's notes and recording while in it: asked while the page is on screen.
  const waiting = phase.kind === 'waiting'
  const inCall = phase.kind === 'call'
  useEffect(() => {
    if (!waiting && !inCall) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    const every = waiting ? MEETING_LOBBY_POLL_MS : 10_000
    const ask = async () => {
      timer = null
      if (stopped || document.visibilityState !== 'visible') return
      let res: Response | null = null
      try {
        res = await fetch(`${base}/lobby`, { cache: 'no-store' })
      } catch {
        res = null
      }
      if (stopped) return
      if (res?.status === 401) {
        if (phaseRef.current.kind === 'waiting') setPhase({ kind: 'entry', error: 'Your place in the lobby was lost. Ask to join again.' })
        return
      }
      const json = res?.ok
        ? ((await res.json().catch(() => null)) as { state?: string; notes?: boolean; recording?: string; open?: boolean; membersInCall?: number } | null)
        : null
      if (stopped) return
      if (json) {
        setOnNow({ notes: json.notes === true, recording: json.recording === 'on' || json.recording === 'starting' })
        setMembersInCall(typeof json.membersInCall === 'number' ? json.membersInCall : null)
        if (phaseRef.current.kind === 'waiting') {
          if (json.state === 'admitted') return void enter()
          if (json.state === 'declined') return finish('declined')
          if (json.state === 'removed') return finish('removed')
          if (json.state === 'left') return finish(json.open === false ? 'inactive' : 'ended')
        }
      }
      timer = setTimeout(() => void ask(), every)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !timer) void ask()
    }
    document.addEventListener('visibilitychange', onVisible)
    timer = setTimeout(() => void ask(), waiting ? 0 : every)
    askNow.current = () => {
      if (timer) clearTimeout(timer)
      void ask()
    }
    return () => {
      stopped = true
      askNow.current = null
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [waiting, inCall, base, enter, finish])

  // Notes on: a mute ends the microphone track, as a member's does (each unmuted stretch its own file).
  const callSession = phase.kind === 'call' ? phase.session : null
  useEffect(() => {
    callSession?.setNotesMode(onNow.notes)
  }, [callSession, onNow.notes])

  // The tab closing while waiting or in the call: they went.
  useEffect(() => {
    if (!waiting && !inCall) return
    const onHide = () => {
      if (navigator.sendBeacon) navigator.sendBeacon(`${base}/leave`)
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [waiting, inCall, base])

  const ask = useCallback(async () => {
    const clean = cleanGuestName(name)
    if (!clean) {
      setPhase({ kind: 'entry', error: 'Use 1 to 60 letters for your name.' })
      return
    }
    setPhase({ kind: 'asking' })
    // The browser asks for the microphone now, not before. Refused: they join listening only (the call says so).
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const t of mic.getTracks()) t.stop()
    } catch {
      // The call's own notice says how to allow it.
    }
    const res = await post(`${base}/join`, { name: clean })
    if (res?.ok) {
      setPhase({ kind: 'waiting' })
      return
    }
    if (res?.status === 400) {
      const json = (await res.json().catch(() => null)) as { error?: string } | null
      setPhase({ kind: 'entry', error: json?.error ?? 'Check your name, then try again.' })
      return
    }
    finish(await doneOf(res))
  }, [name, base, finish])

  const cancel = useCallback(async () => {
    await post(`${base}/leave`)
    finish('left')
  }, [base, finish])

  if (phase.kind === 'call')
    return <GuestCall session={phase.session} title={title} onNow={onNow} hostGone={membersInCall === 0} notesBase={liveAgent ? base : undefined} />


  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground" data-guest-meeting={phase.kind}>
      <div className="w-full max-w-lg">
        <div className="mb-5 flex items-center gap-2 text-sm text-muted-foreground">
          <Mark className="h-6 fill-foreground" />
          {host && <span data-guest-host="">{host}’s meeting</span>}
        </div>
        <h1 className="text-2xl font-semibold tracking-tight" data-guest-title="">
          {title}
        </h1>

        {phase.kind === 'done' ? (
          <DoneCard why={phase.why} onAgain={() => setPhase({ kind: 'entry' })} />
        ) : phase.kind === 'waiting' || phase.kind === 'joining' ? (
          <div className="mt-6 rounded-3xl border border-border bg-card p-6 text-card-foreground shadow-sm" data-guest-waiting="">
            <p className="text-base font-semibold">{phase.kind === 'joining' ? 'Joining…' : 'Waiting for someone to let you in'}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {phase.kind === 'joining' ? 'You were let in.' : 'Someone in the meeting will see that you’re here. Keep this page open.'}
            </p>
            <OnNowNotice onNow={onNow} className="mt-4" />
            {phase.kind === 'waiting' && (
              <button type="button" onClick={() => void cancel()} className="mt-5 rounded-full bg-muted px-4 py-2 text-sm font-medium hover:bg-accent" data-guest-cancel="">
                Cancel
              </button>
            )}
          </div>
        ) : (
          <div className="mt-6 rounded-3xl border border-border bg-card p-5 text-card-foreground shadow-sm sm:p-6" data-guest-entry="">
            <Preview stream={camera === 'on' ? preview.current : null} name={name} />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void toggleCamera()}
                aria-pressed={camera === 'on'}
                data-guest-camera={camera}
                className={cn('flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium', camera === 'on' ? 'bg-foreground text-background' : 'bg-muted text-foreground hover:bg-accent')}
              >
                {camera === 'on' ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
                {camera === 'on' ? 'Camera on' : 'Camera off'}
              </button>
              <span className="text-xs text-muted-foreground">Your microphone is asked for when you join.</span>
            </div>
            {camera === 'blocked' && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">Your camera is blocked. You can allow it in your browser’s site settings, or join without it.</p>}
            <OnNowNotice onNow={onNow} className="mt-4" />
            <form
              className="mt-4 flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                void ask()
              }}
            >
              <label className="text-sm font-medium" htmlFor="guest-name">
                Your name
              </label>
              <input
                id="guest-name"
                name="name"
                autoComplete="name"
                maxLength={MEETING_GUEST_NAME_MAX}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="How the others will see you"
                className="h-11 rounded-xl border border-input bg-background px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
                data-guest-name=""
              />
              {phase.kind === 'entry' && phase.error && (
                <p className="text-sm text-red-600 dark:text-red-400" data-guest-error="">
                  {phase.error}
                </p>
              )}
              <button
                type="submit"
                disabled={phase.kind === 'asking' || !name.trim()}
                className="h-11 rounded-full bg-foreground px-5 text-sm font-semibold text-background hover:bg-foreground/90 disabled:opacity-50"
                data-guest-ask=""
              >
                {phase.kind === 'asking' ? 'Asking…' : 'Ask to join'}
              </button>
            </form>
            <p className="mt-4 text-xs text-muted-foreground">Only the name you type and when you joined are kept with this meeting.</p>
          </div>
        )}
      </div>
    </main>
  )
}

/** What is on in the meeting's call, said before anything of theirs is sent. Nothing when neither is. */
function OnNowNotice({ onNow, className }: { onNow: OnNow; className?: string }) {
  if (!onNow.notes && !onNow.recording) return null
  const lines = [
    onNow.notes ? 'Notes are on in this meeting: what each person says is written down for its members.' : null,
    onNow.recording ? 'This meeting is being recorded, sound and video.' : null,
  ].filter(Boolean)
  return (
    <div className={cn('rounded-2xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm', className)} data-guest-notice="">
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
    </div>
  )
}

/** The camera preview, or their initials while it is off. */
function Preview({ stream, name }: { stream: MediaStream | null; name: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream
  }, [stream])
  return (
    <div className="relative aspect-video overflow-hidden rounded-2xl bg-muted" data-guest-preview={stream ? 'camera' : 'off'}>
      {stream ? (
        <video ref={ref} muted playsInline autoPlay className="h-full w-full -scale-x-100 object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-background text-lg font-semibold text-muted-foreground">{initialsOf(name.trim() || '?')}</span>
        </div>
      )}
    </div>
  )
}

function DoneCard({ why, onAgain }: { why: Done; onAgain: () => void }) {
  const copy = DONE_COPY[why]
  return (
    <div className="mt-6 rounded-3xl border border-border bg-card p-6 text-card-foreground shadow-sm" data-guest-done={why}>
      <p className="text-base font-semibold">{copy.title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{copy.body}</p>
      {copy.again && (
        <button type="button" onClick={onAgain} className="mt-5 rounded-full bg-muted px-4 py-2 text-sm font-medium hover:bg-accent">
          {why === 'left' || why === 'ended' ? 'Ask to join again' : 'Try again'}
        </button>
      )}
    </div>
  )
}

function useSnapshot(session: TeamCallSession): CallSnapshot {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
}

/** The guest in the call: everyone in it, their own controls, Leave. Nothing of the workspace. */
function GuestCall({ session, title, onNow, hostGone, notesBase }: { session: TeamCallSession; title: string; onNow: OnNow; hostGone: boolean; notesBase?: string }) {
  const snap = useSnapshot(session)
  const screens = snap.tiles.filter((t) => t.kind === 'screen')
  const people = snap.tiles.filter((t) => t.kind === 'person')
  const notices = [deviceNotice('mic', snap.mic, false), deviceNotice('camera', snap.camera, false)].filter((n): n is string => !!n)
  const cols = people.length <= 1 ? 'grid-cols-1' : people.length <= 4 ? 'grid-cols-2' : 'grid-cols-3'
  return (
    <main className="flex min-h-dvh flex-col bg-background text-foreground" data-guest-call={snap.phase}>
      <header className="flex h-14 shrink-0 items-center gap-2 px-4">
        <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
        <h1 className="min-w-0 truncate text-sm font-semibold">{title}</h1>
        <span className="text-xs text-muted-foreground">
          {snap.phase === 'connecting' ? (
            'Connecting…'
          ) : snap.phase === 'reconnecting' ? (
            <span className="flex items-center gap-1 font-medium text-amber-600 dark:text-amber-400">
              <WifiOff className="h-3.5 w-3.5" aria-hidden /> Reconnecting…
            </span>
          ) : snap.people === 1 ? (
            'Only you'
          ) : (
            `${snap.people} people`
          )}
        </span>
        <CallBadges notes={{ notes: onNow.notes, recording: onNow.recording ? 'on' : 'off' }} />
      </header>
      <div className="mx-auto w-full max-w-5xl min-h-0 flex-1 overflow-y-auto px-3 pb-2 sm:px-4">
        {hostGone && snap.phase === 'connected' && (
          <div data-guest-host-left="" className="mb-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
            <p className="text-sm font-semibold">The host has left</p>
            <p className="mt-1 text-xs text-muted-foreground">Nobody from the meeting is in the call. It ends in a few minutes unless someone comes back.</p>
          </div>
        )}
        {snap.micHeld && snap.phase !== 'error' && (
          <div data-guest-mic-held="" className="mb-3 rounded-2xl border border-sky-500/30 bg-sky-500/10 px-4 py-3">
            <p className="text-sm font-semibold">{onNow.notes ? 'Notes are on for this meeting' : 'This meeting is being recorded'}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {onNow.notes ? 'What each person says is written down for the meeting’s members.' : 'Its sound and video are recorded.'} Your microphone stays off until you choose to join with it.
            </p>
            <button type="button" onClick={() => void session.releaseMic()} className="mt-3 rounded-full bg-foreground px-3.5 py-1.5 text-xs font-semibold text-background hover:bg-foreground/90">
              Join with microphone
            </button>
          </div>
        )}
        {snap.phase === 'error' && (
          <div className="mb-3 flex items-center gap-3 rounded-xl bg-red-500/10 px-3 py-2.5">
            <p className="min-w-0 flex-1 text-xs text-red-800 dark:text-red-200">{callErrorLine(snap.error)}</p>
            <button type="button" onClick={() => void session.retry()} className="shrink-0 rounded-full bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent">
              Retry
            </button>
          </div>
        )}
        {screens.length > 0 && (
          <div className="mb-2 flex flex-col gap-2">
            {screens.map((t) => (
              <TileView key={t.key} tile={t} large />
            ))}
          </div>
        )}
        <div className={cn('grid gap-2', screens.length > 0 ? 'grid-cols-4' : cols)}>
          {people.map((t) => (
            <TileView key={t.key} tile={t} compact={screens.length > 0} />
          ))}
        </div>
        {notices.map((n) => (
          <p key={n} className="mt-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            {n}
          </p>
        ))}
        {/* The call's own words since they came in, never the members' summary (src/lib/team-calls/live-notes.ts). */}
        {notesBase && onNow.notes && snap.phase === 'connected' && <GuestCallNotes base={notesBase} />}
        {snap.needsAudioStart && (
          <button
            type="button"
            onClick={() => void session.startAudio()}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-primary/10 px-3 py-2 text-xs font-medium text-primary hover:bg-primary/15"
          >
            <Volume2 className="h-4 w-4" />
            Your browser paused the sound. Click to hear the call.
          </button>
        )}
      </div>
      <footer className="flex shrink-0 items-center justify-center gap-2 px-4 pb-6 pt-3">
        <IconButton label={snap.mic === 'on' ? 'Mute' : 'Unmute'} onClick={() => void session.toggleMic()} active={snap.mic !== 'on'} data-guest-mic={snap.mic}>
          {snap.mic === 'on' ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
        </IconButton>
        <IconButton label={snap.camera === 'on' ? 'Turn the camera off' : 'Turn the camera on'} onClick={() => void session.toggleCamera()} active={snap.camera === 'on'} data-guest-video={snap.camera}>
          {snap.camera === 'on' ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
        </IconButton>
        {snap.canShareScreen && (
          <IconButton label={snap.screen === 'on' ? 'Stop sharing your screen' : 'Share your screen'} onClick={() => void session.toggleScreen()} active={snap.screen === 'on'}>
            <MonitorUp className="h-5 w-5" />
          </IconButton>
        )}
        <IconButton label="Leave the meeting" onClick={() => void session.leave()} danger data-guest-leave="">
          <PhoneOff className="h-5 w-5" />
        </IconButton>
      </footer>
    </main>
  )
}
