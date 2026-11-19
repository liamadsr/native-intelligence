'use client'

/**
 * A meeting guest's page (calls plan, phase 7): someone without an account
 * who opened a meeting link. Light on purpose: no app around it (the public
 * sky behind, clear glass on it: meeting-card.tsx), and the
 * LiveKit SDK is fetched only once a member has let them in
 * (src/lib/team-calls/call-session.ts loads it on connect).
 *
 *   1. Their name, a camera preview with a switch for the camera and one for
 *      the microphone (the browser is asked for both at once when the page
 *      opens, so one prompt covers them; the preview never leaves the page,
 *      and the microphone is only checked, not listened to), and, when
 *      the meeting's call has notes or a recording on (or every call starts
 *      with notes), a plain statement of it before anything of theirs is
 *      sent, with "By asking to join, you agree to this." Pressing "Ask to
 *      join" is then their go (the server records it: the join route), so
 *      once let in their microphone and camera are live at once, unless
 *      they switched either off here (muted, they join muted).
 *   2. The lobby: they wait until someone in the call lets them in. Their
 *      page asks the server every 3 seconds while it is on screen (it has
 *      no database session), and every 20 seconds while the tab is hidden,
 *      so a guest who looks at another tab keeps their place in the lobby.
 *   3. The call: who is in it, their own mic, camera and screen, Leave. No
 *      team chat, no member list beyond who is in the call, no notes or
 *      recording controls; a badge says when either is on (asked every 10
 *      seconds). The server decides what they have said go to (the notes,
 *      once for the whole call, and each recording): when notes or a
 *      recording come on that they haven't, it takes their publishing away in LiveKit, the page sees that
 *      at once (the permission event), holds their microphone and shows the
 *      notice; "Join with microphone" records their go and gives it back.
 *      With no member left in the call, the page says the host has left (the
 *      sweeper ends a call left to guests after a few minutes). Where the
 *      call's notes are shown in the call (TEAM_CALL_LIVE_AGENT), the guest
 *      can open what has been said since they came in: the call's own words
 *      and the agent's notes of it as plain words, only while they are in it.
 *
 * Nothing runs without a reason: no script animation loop (the lobby's dot is
 * one CSS pulse, off under reduced motion), no timer while hidden.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowUpRight, Calendar, Contact, Home, Inbox, ListChecks, Mail, MessagesSquare, Mic, MicOff, MonitorUp, NotebookPen, PhoneOff, Video, VideoOff, Volume2, WifiOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TeamCallSession, type CallEnd, type CallSnapshot, type TeamCallJoin } from '@/lib/team-calls/call-session'
import { MEETING_GUEST_NAME_MAX, MEETING_LOBBY_POLL_MS, cleanGuestName } from '@/lib/meeting-links/shape'
import { CallBadges, IconButton, TileView, callErrorLine, deviceNotice, initialsOf, screenNotice, screenDroppedNotice } from '@/components/team-calls/call-tiles'
import { Logo, Mark } from '@/components/logo'
import { DevicesMenu } from '@/components/team-calls/devices-menu'
import { GuestCallNotes } from '@/components/team-calls/call-live-notes'
import { MEETING_GLASS, MeetingShell } from './meeting-card'

type Done = 'declined' | 'removed' | 'left' | 'ended' | 'inactive' | 'full' | 'limited' | 'early' | 'elsewhere' | 'error' | 'unreachable' | 'lost'

/** The lobby is asked this often while the tab is hidden: well inside the two minutes a waiting guest is kept for. */
const HIDDEN_LOBBY_POLL_MS = 20_000

type Phase =
  | { kind: 'entry'; error?: string }
  | { kind: 'asking' }
  | { kind: 'waiting' }
  | { kind: 'joining' }
  | { kind: 'call'; session: TeamCallSession; cameraWaits: boolean }
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
  unreachable: { title: 'The meeting couldn’t be reached', body: 'It is still on. Check your connection, then ask to join again.', again: true },
  lost: { title: 'Your connection to the meeting was lost', body: 'The meeting may still be on. Ask to join again.', again: true },
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
  notesAtStart = false,
  notesOffered = false,
  liveNotes = false,
  liveAgent = false,
}: {
  token: string
  title: string
  host: string | null
  notes: boolean
  recording: boolean
  /** Every call starts with its notes on (the call recorder's): the entry page says so even before a call exists. */
  notesAtStart?: boolean
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
  // How they join: microphone on, muted by their own choice, or refused by the browser (listening only).
  const [mic, setMic] = useState<'on' | 'off' | 'blocked'>('on')
  const micRef = useRef(mic)
  micRef.current = mic
  // The browser has let this page use the microphone (so "Ask to join" need not ask again).
  const micAllowed = useRef(false)
  const preview = useRef<MediaStream | null>(null)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  // What the entry page says is on: asking to join from it is their go to that (the server checks it said so).
  const entryOnNow: OnNow = { notes: onNow.notes || notesAtStart, recording: onNow.recording }

  // Counts every stop of the preview: a camera still starting when one happens (they were let in, or it ended) is stopped as it arrives.
  const previewStops = useRef(0)
  const stopPreview = useCallback(() => {
    previewStops.current += 1
    for (const t of preview.current?.getTracks() ?? []) t.stop()
    preview.current = null
    setCamera((c) => (c === 'on' ? 'off' : c))
  }, [])
  useEffect(() => stopPreview, [stopPreview])

  // The ask that is out now (the browser's prompt may be open): the next one waits for it, so two never run at once.
  const asking = useRef<Promise<void> | null>(null)

  /**
   * Ask the browser for the camera, the microphone, or both in ONE prompt. The
   * camera's stream becomes the preview; the microphone's is only the browser's
   * yes and ends at once (nothing listens before the call). When the two are
   * refused together because one is blocked or missing, the other is asked for
   * by itself, so one refusal never costs the other. A prompt they closed is
   * not asked again here: the switches, and "Ask to join", ask when they want it.
   */
  const askDevices = useCallback((want: { video: boolean; audio: boolean }): Promise<void> => {
    const before = asking.current
    const run = async () => {
      await before
      // What the ask before this one already settled is not asked twice.
      const video = want.video && !preview.current
      const audio = want.audio && !micAllowed.current
      if (!video && !audio) return
      const stops = previewStops.current
      // The preview was stopped while the browser was asked (they were let in, it ended, the page closed): nothing more is asked or shown.
      const stopped = () => stops !== previewStops.current
      const take = (stream: MediaStream, keepVideo: boolean) => {
        const tracks = stream.getTracks()
        if (tracks.some((t) => t.kind === 'audio')) {
          micAllowed.current = true
          if (!stopped()) setMic((m) => (m === 'blocked' ? 'on' : m))
        }
        // Nothing would own this camera (stopped meanwhile, or a preview is already on): it ends here, with the microphone's.
        if (!keepVideo || stopped() || preview.current) {
          for (const t of tracks) t.stop()
          return
        }
        for (const t of tracks) if (t.kind === 'audio') t.stop()
        preview.current = stream
        setCamera('on')
      }
      const block = (kind: 'video' | 'audio') => {
        if (stopped()) return
        if (kind === 'audio') setMic('blocked')
        else setCamera('blocked')
      }
      const one = async (kind: 'video' | 'audio') => {
        if (stopped()) return
        try {
          take(await navigator.mediaDevices.getUserMedia(kind === 'video' ? { video: true } : { audio: true }), kind === 'video')
        } catch {
          block(kind)
        }
      }
      if (!(video && audio)) return one(video ? 'video' : 'audio')
      let refusal: unknown
      try {
        take(await navigator.mediaDevices.getUserMedia({ video: true, audio: true }), true)
        return
      } catch (err) {
        refusal = err
      }
      if (stopped()) return
      if ((refusal as { name?: string } | null)?.name !== 'NotAllowedError') {
        // A device is missing or busy: ask for each, so the other still works.
        await one('audio')
        await one('video')
        return
      }
      // Refused. Blocked in the browser's settings, or a prompt they closed? Only the first is final, and only it is worth asking around.
      const state = async (name: 'camera' | 'microphone') => {
        try {
          return (await navigator.permissions.query({ name: name as PermissionName })).state
        } catch {
          return 'prompt' as const
        }
      }
      const [cam, microphone] = [await state('camera'), await state('microphone')]
      if (stopped()) return
      if (cam === 'denied') block('video')
      if (microphone === 'denied') block('audio')
      if (cam === 'denied' && microphone !== 'denied') await one('audio')
      if (microphone === 'denied' && cam !== 'denied') await one('video')
    }
    const mine = run()
    asking.current = mine
    void mine.finally(() => {
      if (asking.current === mine) asking.current = null
    })
    return mine
  }, [])

  // The page opens: one prompt for both, and the camera's preview comes on if they allow it.
  useEffect(() => {
    void askDevices({ video: true, audio: true })
  }, [askDevices])

  const toggleCamera = useCallback(async () => {
    if (camera === 'on') return stopPreview()
    // Not allowed the microphone yet either: the same prompt asks for it.
    await askDevices({ video: true, audio: !micAllowed.current && micRef.current !== 'off' })
  }, [camera, stopPreview, askDevices])

  const toggleMic = useCallback(async () => {
    if (mic === 'on') return setMic('off')
    if (micAllowed.current) return setMic('on')
    setMic('on')
    await askDevices({ video: false, audio: true })
  }, [mic, askDevices])

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
    // The server decides listen-only: from what this guest has said go to (the call's notes, the recording).
    let failed: Done = 'ended'
    const fetchJoin = async (): Promise<{ join: TeamCallJoin; call: OnNow } | null> => {
      const res = await post(`${base}/token`)
      if (!res?.ok) {
        // No answer, the call server down, or too many asks: the meeting is still on. Anything else: it is over for them.
        failed = !res || res.status >= 500 ? 'unreachable' : res.status === 429 ? 'limited' : 'ended'
        return null
      }
      const json = (await res.json().catch(() => null)) as { join?: TeamCallJoin; call?: { notes?: boolean; recording?: string } } | null
      if (!json?.join) {
        failed = 'unreachable'
        return null
      }
      return { join: json.join, call: { notes: json.call?.notes === true, recording: json.call?.recording === 'on' || json.call?.recording === 'starting' } }
    }
    const first = await fetchJoin()
    if (!first) {
      finish(failed)
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
        onEnded: (why: CallEnd) => finish(why === 'removed' ? 'removed' : why === 'left' ? 'left' : why === 'elsewhere' ? 'elsewhere' : why === 'failed' ? 'lost' : 'ended'),
      },
    )
    // Held for the notice: the server gave a listen-only token (notes or a recording came on after they asked).
    const holdMic = first.join.canPublish === false
    // The camera they turned on in the preview: on at once, or, held, with "Join with microphone and camera".
    const hadCamera = !!preview.current
    const wantCamera = hadCamera && !holdMic
    stopPreview()
    session.setNotesMode(first.call.notes)
    setPhase({ kind: 'call', session, cameraWaits: hadCamera && holdMic })
    await session.connect(first.join, { holdMic, cameraOnRelease: hadCamera && holdMic, startMuted: micRef.current === 'off' })
    if (wantCamera && session.getSnapshot().phase === 'connected') await session.toggleCamera()
  }, [base, title, notesOffered, liveNotes, finish, stopPreview])

  // The lobby, and the call's notes and recording while in it: asked while the page is on screen.
  const waiting = phase.kind === 'waiting'
  const inCall = phase.kind === 'call'
  useEffect(() => {
    if (!waiting && !inCall) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    // One ask at a time: a second chain would let a guest in twice (two connections, the first ended as "elsewhere").
    let asking = false
    const every = waiting ? MEETING_LOBBY_POLL_MS : 10_000
    const ask = async () => {
      timer = null
      if (stopped || asking) return
      asking = true
      try {
        await askOnce()
      } finally {
        asking = false
      }
    }
    const askOnce = async () => {
      // Hidden: the call's badges can wait, a place in the lobby can't (a guest not heard from for two minutes loses it).
      const hidden = document.visibilityState !== 'visible'
      if (hidden && phaseRef.current.kind !== 'waiting') return
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
          // Their place went while they waited (the meeting ended, or they weren't heard from): the link still works, so they can ask again.
          if (json.state === 'left') return json.open === false ? finish('inactive') : setPhase({ kind: 'entry', error: 'Your place in the lobby was lost. Ask to join again.' })
        }
      }
      timer = setTimeout(() => void ask(), document.visibilityState === 'visible' ? every : HIDDEN_LOBBY_POLL_MS)
    }
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      // Back on screen: ask now, not at the hidden tab's slow turn (an ask already on its way is the one).
      if (asking) return
      if (timer) clearTimeout(timer)
      void ask()
    }
    document.addEventListener('visibilitychange', onVisible)
    timer = setTimeout(() => void ask(), waiting ? 0 : every)
    askNow.current = () => {
      if (asking) return
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
    const shown: OnNow = { notes: onNow.notes || notesAtStart, recording: onNow.recording }
    // Not asked yet (they dismissed the page's first prompt) and they mean to talk: the browser asks now. Refused: they join listening only (the call says so).
    if (micRef.current === 'on' && !micAllowed.current) await askDevices({ video: false, audio: true })
    const res = await post(`${base}/join`, { name: clean, notice: shown })
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
  }, [name, base, finish, onNow.notes, onNow.recording, notesAtStart, askDevices])

  const cancel = useCallback(async () => {
    await post(`${base}/leave`)
    finish('left')
  }, [base, finish])

  if (phase.kind === 'call')
    return <GuestCall session={phase.session} title={title} onNow={onNow} hostGone={membersInCall === 0} notesBase={liveAgent ? base : undefined} cameraWaits={phase.cameraWaits} />


  const hostLine = host && (
    <p className="text-sm font-medium text-muted-foreground" data-guest-host="">
      {host}’s meeting
    </p>
  )
  const heading = (
    <h1 className="mt-1 text-balance text-3xl font-semibold tracking-tight" data-guest-title="">
      {title}
    </h1>
  )

  if (phase.kind === 'done')
    return (
      <MeetingShell data-guest-meeting={phase.kind}>
        <div className={cn('w-full max-w-md rounded-3xl p-6 sm:p-8', MEETING_GLASS)}>
          {hostLine}
          {heading}
          <DoneCard why={phase.why} onAgain={() => setPhase({ kind: 'entry' })} />
        </div>
      </MeetingShell>
    )

  const lobby = phase.kind === 'waiting' || phase.kind === 'joining'
  return (
    <MeetingShell data-guest-meeting={phase.kind}>
      {/* Themselves on one side, the meeting on the other; one column on a phone. The camera stays theirs to turn on or off while they wait. */}
      <div className="grid w-full max-w-5xl items-center gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:gap-8">
        <div>
          <Preview stream={camera === 'on' ? preview.current : null} name={name}>
            <PreviewSwitch on={mic === 'on'} disabled={phase.kind === 'joining'} onClick={() => void toggleMic()} data-guest-mic-choice={mic}>
              {mic === 'on' ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
              {mic === 'on' ? 'Mic on' : mic === 'blocked' ? 'Mic blocked' : 'Muted'}
            </PreviewSwitch>
            {/* Let in: the call takes the camera from here. */}
            <PreviewSwitch on={camera === 'on'} disabled={phase.kind === 'joining'} onClick={() => void toggleCamera()} data-guest-camera={camera}>
              {camera === 'on' ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
              {camera === 'on' ? 'Camera on' : camera === 'blocked' ? 'Camera blocked' : 'Camera off'}
            </PreviewSwitch>
          </Preview>
          <p className="mt-3 text-center text-xs text-foreground/70">
            {camera === 'blocked' && mic === 'blocked'
              ? 'Your camera and microphone are blocked. You can allow them in your browser’s site settings, or join listening only.'
              : camera === 'blocked'
                ? 'Your camera is blocked. You can allow it in your browser’s site settings, or join without it.'
                : mic === 'blocked'
                  ? 'Your microphone is blocked. You can allow it in your browser’s site settings, or join listening only.'
                  : 'Choose how you join. You can change both in the call.'}
          </p>
        </div>

        <div className={cn('rounded-3xl p-6 sm:p-8', MEETING_GLASS)}>
          {hostLine}
          {heading}
          {lobby ? (
            <div className="mt-6" data-guest-waiting="">
              <p className="flex items-center gap-2.5 text-base font-semibold">
                <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
                  {phase.kind === 'waiting' && <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500/60 motion-reduce:hidden" />}
                  <span className="relative h-2.5 w-2.5 rounded-full bg-emerald-500" />
                </span>
                {phase.kind === 'joining' ? 'Joining…' : 'Waiting for someone to let you in'}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {phase.kind === 'joining' ? 'You were let in.' : 'Someone in the meeting will see that you’re here. Keep this page open.'}
              </p>
              <OnNowNotice onNow={entryOnNow} className="mt-5" />
              {phase.kind === 'waiting' && (
                <button
                  type="button"
                  onClick={() => void cancel()}
                  className="mt-6 h-11 w-full rounded-full border border-foreground/15 bg-foreground/[0.04] px-5 text-sm font-medium hover:bg-foreground/[0.08]"
                  data-guest-cancel=""
                >
                  Cancel
                </button>
              )}
            </div>
          ) : (
            <div className="mt-6" data-guest-entry="">
              <form
                className="flex flex-col gap-3"
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
                  className="h-12 rounded-2xl border border-foreground/15 bg-background/60 px-4 text-base dark:bg-black/20 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  data-guest-name=""
                />
                {phase.kind === 'entry' && phase.error && (
                  <p className="text-sm text-red-600 dark:text-red-400" data-guest-error="">
                    {phase.error}
                  </p>
                )}
                <OnNowNotice onNow={entryOnNow} agree mic={mic} className="mt-1" />
                <button
                  type="submit"
                  disabled={phase.kind === 'asking' || !name.trim()}
                  className="mt-1 h-12 rounded-full bg-foreground px-5 text-sm font-semibold text-background hover:bg-foreground/90 disabled:opacity-50"
                  data-guest-ask=""
                >
                  {phase.kind === 'asking' ? 'Asking…' : 'Ask to join'}
                </button>
              </form>
              <p className="mt-4 text-center text-xs text-muted-foreground">Only the name you type and when you joined are kept with this meeting.</p>
            </div>
          )}
        </div>
      </div>
    </MeetingShell>
  )
}

/**
 * What is on in the meeting's call, said before anything of theirs is sent. Nothing when neither is.
 * `agree`: above "Ask to join", whose press is their go to it (the server records it).
 */
function OnNowNotice({ onNow, agree = false, mic = 'on', className }: { onNow: OnNow; agree?: boolean; mic?: 'on' | 'off' | 'blocked'; className?: string }) {
  if (!onNow.notes && !onNow.recording) return null
  return (
    <div className={cn('rounded-2xl border border-foreground/10 bg-foreground/[0.04] px-4 py-3 text-sm', className)} data-guest-notice="">
      {onNow.notes && (
        <p className="flex gap-2.5">
          <NotebookPen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span>Notes are on in this meeting: what each person says is written down for its members.</span>
        </p>
      )}
      {onNow.recording && (
        <p className={cn('flex gap-2.5', onNow.notes && 'mt-2')}>
          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-red-500 mx-1" aria-hidden />
          <span>This meeting is being recorded, sound and video.</span>
        </p>
      )}
      {agree && (
        <p className="mt-2 text-xs text-muted-foreground" data-guest-notice-agree="">
          By asking to join, you agree to this. {mic === 'on' ? 'You’ll join with your microphone on.' : mic === 'off' ? 'You’ll join muted.' : 'Your microphone is blocked, so you’ll join listening only.'}
        </p>
      )}
    </div>
  )
}

/** The camera preview, or their initials while it is off: a tile like the call's, their name on it, the camera's switch (`children`) at its foot. */
function Preview({ stream, name, children }: { stream: MediaStream | null; name: string; children?: React.ReactNode }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream
  }, [stream])
  const shown = name.trim()
  return (
    <div
      className={cn('relative aspect-[2/1] overflow-hidden rounded-3xl sm:aspect-video', stream ? 'bg-black shadow-xl shadow-black/10' : 'border border-foreground/10 bg-background/35 backdrop-blur-2xl dark:bg-white/[0.04]')}
      data-guest-preview={stream ? 'camera' : 'off'}
    >
      {stream ? (
        <video ref={ref} muted playsInline autoPlay className="h-full w-full -scale-x-100 object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center pb-10">
          <span className="flex h-16 w-16 items-center sm:h-20 sm:w-20 justify-center rounded-full border border-foreground/10 bg-background/70 text-xl dark:bg-white/10 font-semibold text-muted-foreground">{initialsOf(shown || '?')}</span>
        </div>
      )}
      {shown && <span className="absolute left-3 top-3 max-w-[60%] truncate rounded-full bg-black/55 px-2.5 py-1 text-xs font-medium text-white">{shown}</span>}
      <div className="absolute inset-x-0 bottom-3 flex justify-center gap-2">{children}</div>
    </div>
  )
}

/** A switch on the preview: the microphone's, the camera's. White when on, like the call's own controls. */
function PreviewSwitch({ on, disabled, onClick, children, ...rest }: { on: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      {...rest}
      className={cn(
        'flex h-10 items-center gap-2 rounded-full px-4 text-sm font-medium backdrop-blur-md transition-colors disabled:opacity-60',
        on ? 'bg-white text-black hover:bg-white/90' : 'bg-black/55 text-white hover:bg-black/70',
      )}
    >
      {children}
    </button>
  )
}

function DoneCard({ why, onAgain }: { why: Done; onAgain: () => void }) {
  const copy = DONE_COPY[why]
  return (
    <div className="mt-6 border-t border-foreground/10 pt-5" data-guest-done={why}>
      <p className="text-base font-semibold">{copy.title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{copy.body}</p>
      {copy.again && (
        <button type="button" onClick={onAgain} className="mt-6 h-11 w-full rounded-full bg-foreground px-5 text-sm font-semibold text-background hover:bg-foreground/90">
          {why === 'left' || why === 'ended' || why === 'unreachable' || why === 'lost' ? 'Ask to join again' : 'Try again'}
        </button>
      )}
    </div>
  )
}

function useSnapshot(session: TeamCallSession): CallSnapshot {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
}

/** The app's areas, as the rail of the real app lists them: shown to a guest, opened by a member. */
const APP_AREAS = [
  { label: 'Home', icon: Home },
  { label: 'Inbox', icon: Inbox },
  { label: 'Mail', icon: Mail },
  { label: 'Chat', icon: MessagesSquare },
  { label: 'Tasks', icon: ListChecks },
  { label: 'Calendar', icon: Calendar },
  { label: 'Contacts', icon: Contact },
] as const

/**
 * The guest in the call, in the app's own frame: where a member's workspace
 * name sits, theirs says Guest; the app's rail beside the call (this meeting is
 * the one place a guest has in it); everyone in the call, the call's notes as a
 * pad on the side, their own controls, Leave. Nothing of the workspace itself.
 */
function GuestCall({ session, title, onNow, hostGone, notesBase, cameraWaits }: { session: TeamCallSession; title: string; onNow: OnNow; hostGone: boolean; notesBase?: string; cameraWaits: boolean }) {
  const snap = useSnapshot(session)
  const screens = snap.tiles.filter((t) => t.kind === 'screen')
  const people = snap.tiles.filter((t) => t.kind === 'person')
  const notices = [deviceNotice('mic', snap.mic, false), deviceNotice('camera', snap.camera, false), screenNotice(snap.screenBlocked, false), screenDroppedNotice(snap.screenDropped)].filter((n): n is string => !!n)
  // Nothing of theirs may be sent until they say go to the notice: camera and screen wait with the microphone.
  const held = snap.micHeld && !snap.canPublish
  const heldLabel = 'Join with your microphone first'
  const cols = people.length <= 1 ? 'grid-cols-1' : people.length <= 4 ? 'grid-cols-2' : 'grid-cols-3'
  // The agent's notes as plain words and the call's own words since they came in (src/lib/team-calls/live-notes.ts).
  const showNotes = !!notesBase && onNow.notes && snap.phase === 'connected'
  return (
    <main className="flex h-dvh flex-col text-foreground" data-guest-call={snap.phase}>
      <header className="flex h-16 shrink-0 items-center gap-2 px-3 sm:px-4">
        {/* Where the app shows the workspace: a guest has none. */}
        <div data-guest-workspace="" className={cn('flex h-10 shrink-0 items-center gap-2 rounded-full pl-2.5 pr-4', MEETING_GLASS)}>
          <Mark className="h-4 shrink-0" />
          <span className="text-sm font-semibold">Guest</span>
        </div>
        <div className={cn('flex h-10 min-w-0 items-center gap-2.5 rounded-full px-4', MEETING_GLASS)}>
          <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
          <h1 className="min-w-0 truncate text-sm font-semibold">{title}</h1>
          <span className="shrink-0 text-xs text-foreground/70">
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
        </div>
        <a
          href="/"
          target="_blank"
          rel="noreferrer"
          data-guest-about=""
          className={cn('ml-auto hidden h-10 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-medium hover:bg-background/70 sm:flex dark:hover:bg-white/[0.12]', MEETING_GLASS)}
        >
          Native Intelligence
          <ArrowUpRight className="h-4 w-4" aria-hidden />
        </a>
      </header>
      <div className="flex min-h-0 flex-1 gap-4 px-3 sm:px-4">
        <div aria-hidden data-guest-rail="" className={cn('hidden shrink-0 flex-col items-center gap-1 self-start rounded-3xl p-1.5 lg:flex', MEETING_GLASS)}>
          <span title="This meeting" className="flex h-9 w-9 items-center justify-center rounded-full bg-foreground/10">
            <Video className="h-[18px] w-[18px]" aria-hidden />
            <span className="sr-only">This meeting</span>
          </span>
          <span className="my-1 h-px w-5 bg-foreground/10" aria-hidden />
          {APP_AREAS.map(({ label, icon: Icon }) => (
            <span key={label} title={`${label}: for the workspace’s members`} className="flex h-9 w-9 items-center justify-center rounded-full text-foreground/35">
              <Icon className="h-[18px] w-[18px]" aria-hidden />
              <span className="sr-only">{label}: for the workspace’s members</span>
            </span>
          ))}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 lg:flex-row lg:gap-4">
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col justify-center overflow-y-auto px-1 py-1">
        {hostGone && snap.phase === 'connected' && (
          <div data-guest-host-left="" className="mb-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
            <p className="text-sm font-semibold">The host has left</p>
            <p className="mt-1 text-xs text-muted-foreground">Nobody from the meeting is in the call. It ends in a few minutes unless someone comes back.</p>
          </div>
        )}
        {snap.micHeld && snap.phase !== 'error' && (
          <div data-guest-mic-held="" className={cn('mb-3 rounded-2xl px-4 py-3', MEETING_GLASS)}>
            <p className="text-sm font-semibold">{onNow.notes ? 'Notes are on for this meeting' : 'This meeting is being recorded'}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {onNow.notes ? 'What each person says is written down for the meeting’s members.' : 'Its sound and video are recorded.'} {held ? 'Your microphone, camera and screen stay off until you choose to join.' : 'Your microphone stays off until you choose to join with it.'}
            </p>
            <button type="button" onClick={() => void session.releaseMic()} className="mt-3 rounded-full bg-foreground px-3.5 py-1.5 text-xs font-semibold text-background hover:bg-foreground/90">
              {cameraWaits && held ? 'Join with microphone and camera' : 'Join with microphone'}
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
              <TileView key={t.key} tile={t} large glass />
            ))}
          </div>
        )}
        <div className={cn('grid gap-3', screens.length > 0 ? 'grid-cols-4' : cols)}>
          {people.map((t) => (
            <TileView key={t.key} tile={t} compact={screens.length > 0} glass />
          ))}
        </div>
        {notices.map((n) => (
          <p key={n} className="mt-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            {n}
          </p>
        ))}
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
          {showNotes && notesBase && <GuestCallNotes base={notesBase} pad className={cn('lg:w-[340px] lg:shrink-0', MEETING_GLASS)} />}
        </div>
      </div>
      <footer className="flex shrink-0 justify-center px-4 pb-6 pt-3">
        {/* The controls' dock: one glass bar on the sky. */}
        <div className={cn('flex items-center gap-2 rounded-full p-2', MEETING_GLASS)}>
        <IconButton glass label={snap.mic === 'on' ? 'Mute' : 'Unmute'} onClick={() => void session.toggleMic()} active={snap.mic !== 'on'} data-guest-mic={snap.mic}>
          {snap.mic === 'on' ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
        </IconButton>
        <IconButton glass label={held ? heldLabel : snap.camera === 'on' ? 'Turn the camera off' : 'Turn the camera on'} onClick={() => void session.toggleCamera()} active={snap.camera === 'on'} disabled={held} data-guest-video={snap.camera}>
          {snap.camera === 'on' ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
        </IconButton>
        {snap.canShareScreen && (
          <IconButton glass label={held ? heldLabel : snap.screen === 'on' ? 'Stop sharing your screen' : 'Share your screen'} onClick={() => void session.toggleScreen()} active={snap.screen === 'on'} disabled={held} data-guest-screen={snap.screen}>
            <MonitorUp className="h-5 w-5" />
          </IconButton>
        )}
        <DevicesMenu session={session} snap={snap} glass />
        <IconButton glass label="Leave the meeting" onClick={() => void session.leave()} danger data-guest-leave="">
          <PhoneOff className="h-5 w-5" />
        </IconButton>
        </div>
      </footer>
    </main>
  )
}
