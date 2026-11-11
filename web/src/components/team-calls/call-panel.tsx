'use client'

/**
 * The call panel: who is in the call (a tile each, lit while they speak, by
 * LiveKit's active-speaker events), a shared screen large above them, and
 * the controls: mute, camera, share the screen (only where the browser can),
 * the devices (microphone, speaker where the browser lets a page pick one,
 * camera), ring people, minimise, leave. Minimised, it is a small bar that
 * stays put while the person moves around the app (TeamCallsProvider mounts
 * it above every page). Fetched with a call's first start, never before.
 *
 * Notes and recording (phase 6), only where the server offers them: a Notes
 * switch and a Record button in the controls, and while either is on, a
 * plain badge in the header and the bar for everyone in the call ("Notes
 * are on", "Recording"), static, no pulse. A person who joins a call with
 * notes or a recording on sees a notice first; their microphone is sent
 * only once they choose to join with it.
 *
 * Everything it draws comes from the session's snapshot
 * (src/lib/team-calls/call-session.ts), which changes only when LiveKit says
 * something changed: no timer, no animation loop, no audio analyser.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  ChevronDown,
  Circle,
  NotebookPen,
  Square,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  PhoneOff,
  Settings2,
  UserPlus,
  Video,
  VideoOff,
  Volume2,
  WifiOff,
} from 'lucide-react'
import type { Track } from 'livekit-client'
import { cn } from '@/lib/utils'
import { isDesktopApp } from '@/lib/platform'
import { cachedJson } from '@/lib/cached-fetch'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { CallDeviceKind, CallDeviceState, CallSnapshot, CallTile, TeamCallSession } from '@/lib/team-calls/call-session'
import type { ActiveTeamCall } from './team-calls-provider'
import { useTeamCalls } from './team-calls-provider'

interface Member {
  id: string
  display_name: string | null
  avatar_url?: string | null
}

function useSnapshot(session: TeamCallSession): CallSnapshot {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
}

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?'
  )
}

/** What a refused device says, plainly, and where to allow it. */
export function deviceNotice(kind: 'mic' | 'camera', state: CallDeviceState, desktop: boolean): string | null {
  const thing = kind === 'mic' ? 'microphone' : 'camera'
  if (state === 'blocked') {
    const where = desktop
      ? `System Settings → Privacy & Security → ${kind === 'mic' ? 'Microphone' : 'Camera'}, and turn on Native Intelligence`
      : 'your browser’s site settings for this page'
    return kind === 'mic'
      ? `Your microphone is blocked, so you joined listening only. To talk, allow it in ${where}, then turn the mic on.`
      : `Your camera is blocked. To be seen, allow it in ${where}, then turn the camera on.`
  }
  if (state === 'missing') return kind === 'mic' ? 'No microphone was found, so you joined listening only.' : 'No camera was found.'
  if (state === 'busy') return `Your ${thing} is in use by another app. Close it there, then try again.`
  return null
}

export function CallPanel({
  call,
  minimized,
  onMinimize,
  onLeave,
}: {
  call: ActiveTeamCall
  minimized: boolean
  onMinimize: (minimized: boolean) => void
  onLeave: () => void
}) {
  const snap = useSnapshot(call.session)
  if (snap.phase === 'ended') return null
  return minimized ? (
    <CallBar call={call} snap={snap} onExpand={() => onMinimize(false)} onLeave={onLeave} />
  ) : (
    <CallWindow call={call} snap={snap} onMinimize={() => onMinimize(true)} onLeave={onLeave} />
  )
}

/** What an error says: the call couldn't load (its code) or couldn't reach the call server. */
export function callErrorLine(error: CallSnapshot['error']): string {
  return error === 'load' ? 'Calling couldn’t load. Check your connection, then retry.' : 'Couldn’t reach the call. Check your connection, then retry.'
}

function StatusLine({ snap }: { snap: CallSnapshot }) {
  if (snap.phase === 'error')
    return (
      <span className="flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400" data-team-call-error={snap.error ?? ''}>
        <WifiOff className="h-3.5 w-3.5" aria-hidden />
        {snap.error === 'load' ? 'Couldn’t load' : 'Couldn’t connect'}
      </span>
    )
  if (snap.phase === 'connecting') return <span className="text-xs text-muted-foreground">Connecting…</span>
  if (snap.phase === 'reconnecting')
    return (
      <span className="flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400" data-team-call-reconnecting="">
        <WifiOff className="h-3.5 w-3.5" aria-hidden />
        Reconnecting…
      </span>
    )
  return (
    <span className="text-xs text-muted-foreground">
      {snap.people === 1 ? 'Only you' : `${snap.people} people`}
    </span>
  )
}

/** What is on for everyone in the call: notes, a recording. Static words, no animation; nothing when neither is on. */
export function CallBadges({ notes, small = false }: { notes: ActiveTeamCall['notes']; small?: boolean }) {
  const recording = notes.recording === 'on' || notes.recording === 'starting'
  if (!notes.notes && !recording) return null
  return (
    <span className="flex shrink-0 items-center gap-1" data-team-call-badges="">
      {notes.notes && (
        <span
          data-team-call-notes-on=""
          className={cn('flex items-center gap-1 rounded-full bg-sky-500/15 font-medium text-sky-800 dark:text-sky-200', small ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]')}
        >
          <NotebookPen className="h-3 w-3" aria-hidden />
          {small ? 'Notes on' : 'Notes are on'}
        </span>
      )}
      {recording && (
        <span
          data-team-call-recording={notes.recording}
          className={cn('flex items-center gap-1 rounded-full bg-red-500/15 font-medium text-red-700 dark:text-red-300', small ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]')}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden />
          {notes.recording === 'starting' ? 'Starting recording…' : 'Recording'}
        </span>
      )}
    </span>
  )
}

/** Shown to someone who joined while notes or a recording are on, before anything of theirs is sent. */
export function JoinNotice({ call, onJoin, onLeave }: { call: Pick<ActiveTeamCall, 'label' | 'notes'>; onJoin: () => void; onLeave: () => void }) {
  const recording = call.notes.recording === 'on' || call.notes.recording === 'starting'
  const title = call.notes.notes && recording ? 'This call has notes on and is being recorded' : call.notes.notes ? 'Notes are on for this call' : 'This call is being recorded'
  const what = [
    call.notes.notes ? 'what each person says is written down as notes' : null,
    recording ? 'the call’s sound and video are recorded' : null,
  ]
    .filter(Boolean)
    .join(', and ')
  return (
    <div data-team-call-join-notice="" className="mb-2 rounded-2xl border border-sky-500/30 bg-sky-500/10 px-4 py-3">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        In this call, {what}, for the people who can read {call.label}. Your microphone stays off until you choose to join with it.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={onJoin} data-team-call-join-with-mic="" className="rounded-full bg-foreground px-3.5 py-1.5 text-xs font-semibold text-background hover:bg-foreground/90">
          Join with microphone
        </button>
        <button type="button" onClick={onLeave} className="rounded-full bg-muted px-3.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent">
          Leave
        </button>
      </div>
    </div>
  )
}

function CallBar({ call, snap, onExpand, onLeave }: { call: ActiveTeamCall; snap: CallSnapshot; onExpand: () => void; onLeave: () => void }) {
  const speaking = snap.tiles.find((t) => t.speaking && !t.isLocal && t.kind === 'person')
  return (
    <div
      data-team-call-bar=""
      className="fixed bottom-4 right-4 z-[70] flex max-w-[calc(100vw-32px)] items-center gap-2 rounded-full border border-border bg-card py-1.5 pl-3 pr-1.5 text-card-foreground shadow-lg"
    >
      <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
      <button type="button" onClick={onExpand} className="flex min-w-0 flex-col items-start text-left" title="Open the call">
        <span className="max-w-[180px] truncate text-sm font-semibold">{call.label}</span>
        {speaking ? <span className="max-w-[180px] truncate text-xs text-emerald-600 dark:text-emerald-400">{speaking.name} is speaking</span> : <StatusLine snap={snap} />}
      </button>
      <CallBadges notes={call.notes} small />
      {snap.phase === 'error' ? (
        <button type="button" onClick={() => void call.session.retry()} data-team-call-retry="" className="shrink-0 rounded-full bg-muted px-3 py-1 text-xs font-medium hover:bg-accent">
          Retry
        </button>
      ) : (
        <MicButton session={call.session} state={snap.mic} small />
      )}
      <IconButton label="Open the call" onClick={onExpand} small>
        <Maximize2 className="h-4 w-4" />
      </IconButton>
      <LeaveButton onLeave={onLeave} small />
    </div>
  )
}

function CallWindow({ call, snap, onMinimize, onLeave }: { call: ActiveTeamCall; snap: CallSnapshot; onMinimize: () => void; onLeave: () => void }) {
  const desktop = isDesktopApp()
  const screens = snap.tiles.filter((t) => t.kind === 'screen')
  const people = snap.tiles.filter((t) => t.kind === 'person')
  const notices = [deviceNotice('mic', snap.mic, desktop), deviceNotice('camera', snap.camera, desktop)].filter((n): n is string => !!n)
  const cols = people.length <= 1 ? 1 : people.length <= 4 ? 2 : 3

  return (
    <section
      aria-label={`Call: ${call.label}`}
      data-team-call-panel=""
      className="fixed bottom-4 right-4 z-[70] flex max-h-[calc(100dvh-32px)] w-[min(640px,calc(100vw-32px))] flex-col overflow-hidden rounded-3xl border border-border bg-card text-card-foreground shadow-2xl"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
        <h2 className="min-w-0 truncate text-sm font-semibold">{call.label}</h2>
        <StatusLine snap={snap} />
        <CallBadges notes={call.notes} />
        <span className="ml-auto" />
        <IconButton label="Minimise" onClick={onMinimize} small>
          <Minimize2 className="h-4 w-4" />
        </IconButton>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {snap.micHeld && snap.phase !== 'error' && <JoinNotice call={call} onJoin={() => void call.session.releaseMic()} onLeave={onLeave} />}
        {snap.phase === 'error' && (
          <div className="mb-2 flex items-center gap-3 rounded-xl bg-red-500/10 px-3 py-2.5" data-team-call-error-panel="">
            <p className="min-w-0 flex-1 text-xs text-red-800 dark:text-red-200">{callErrorLine(snap.error)}</p>
            <button
              type="button"
              onClick={() => void call.session.retry()}
              data-team-call-retry=""
              className="shrink-0 rounded-full bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
            >
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
        <div
          className={cn('grid gap-2', screens.length > 0 ? 'grid-cols-4' : cols === 1 ? 'grid-cols-1' : cols === 2 ? 'grid-cols-2' : 'grid-cols-3')}
          data-team-call-tiles={people.length}
        >
          {people.map((t) => (
            <TileView key={t.key} tile={t} compact={screens.length > 0} />
          ))}
        </div>
        {notices.map((n) => (
          <p key={n} className="mt-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200" data-team-call-notice="">
            {n}
          </p>
        ))}
        {snap.needsAudioStart && (
          <button
            type="button"
            onClick={() => void call.session.startAudio()}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-primary/10 px-3 py-2 text-xs font-medium text-primary hover:bg-primary/15"
          >
            <Volume2 className="h-4 w-4" />
            Your browser paused the sound. Click to hear the call.
          </button>
        )}
      </div>

      <footer className="flex shrink-0 items-center justify-center gap-2 px-4 pb-4 pt-2">
        <MicButton session={call.session} state={snap.mic} />
        <IconButton
          label={snap.camera === 'on' ? 'Turn the camera off' : 'Turn the camera on'}
          onClick={() => void call.session.toggleCamera()}
          active={snap.camera === 'on'}
          data-team-call-camera={snap.camera}
        >
          {snap.camera === 'on' ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
        </IconButton>
        {snap.canShareScreen && (
          <IconButton
            label={snap.screen === 'on' ? 'Stop sharing your screen' : 'Share your screen'}
            onClick={() => void call.session.toggleScreen()}
            active={snap.screen === 'on'}
            data-team-call-screen={snap.screen}
          >
            <MonitorUp className="h-5 w-5" />
          </IconButton>
        )}
        <NotesButton call={call} />
        <RecordButton call={call} />
        <DevicesMenu session={call.session} snap={snap} />
        <RingMenu call={call} snap={snap} />
        <LeaveButton onLeave={onLeave} />
      </footer>
    </section>
  )
}

function TileView({ tile, large = false, compact = false }: { tile: CallTile; large?: boolean; compact?: boolean }) {
  return (
    <div
      data-team-call-tile={tile.kind}
      data-speaking={tile.speaking || undefined}
      className={cn(
        'relative overflow-hidden rounded-2xl bg-muted transition-shadow duration-150',
        large ? 'aspect-video' : compact ? 'aspect-square' : 'aspect-video',
        tile.speaking ? 'ring-2 ring-emerald-500' : 'ring-0',
      )}
    >
      {tile.video ? (
        <TrackVideo track={tile.video} mirror={tile.isLocal && tile.kind === 'person'} contain={tile.kind === 'screen'} />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <span className={cn('flex items-center justify-center rounded-full bg-background font-semibold text-muted-foreground', compact ? 'h-9 w-9 text-xs' : 'h-14 w-14 text-base')}>
            {initialsOf(tile.name)}
          </span>
        </div>
      )}
      <span className="absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-12px)] items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white">
        {!tile.micOn && tile.kind === 'person' && <MicOff className="h-3 w-3 shrink-0" aria-label="Muted" />}
        <span className="truncate">{tile.kind === 'screen' ? `${tile.isLocal ? 'Your' : `${tile.name}’s`} screen` : tile.isLocal ? 'You' : tile.name}</span>
      </span>
    </div>
  )
}

/** A video track drawn in a <video> while the tile is on screen (adaptive stream reads its size and visibility). */
function TrackVideo({ track, mirror, contain }: { track: Track; mirror: boolean; contain: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    track.attach(el)
    return () => {
      track.detach(el)
    }
  }, [track])
  return <video ref={ref} muted playsInline autoPlay className={cn('h-full w-full', contain ? 'object-contain bg-black' : 'object-cover', mirror && '-scale-x-100')} />
}

function IconButton({
  label,
  onClick,
  active = false,
  danger = false,
  small = false,
  children,
  ...rest
}: {
  label: string
  onClick: () => void
  active?: boolean
  danger?: boolean
  small?: boolean
  children: React.ReactNode
} & Record<`data-${string}`, string | undefined>) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      {...rest}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full transition-colors',
        small ? 'h-8 w-8' : 'h-11 w-11',
        danger ? 'bg-red-500 text-white hover:bg-red-600' : active ? 'bg-foreground text-background hover:bg-foreground/90' : 'bg-muted text-foreground hover:bg-accent',
      )}
    >
      {children}
    </button>
  )
}

function MicButton({ session, state, small = false }: { session: TeamCallSession; state: CallDeviceState; small?: boolean }) {
  const on = state === 'on'
  return (
    <IconButton label={on ? 'Mute' : 'Unmute'} onClick={() => void session.toggleMic()} active={!on} small={small} data-team-call-mic={state}>
      {on ? <Mic className={small ? 'h-4 w-4' : 'h-5 w-5'} /> : <MicOff className={small ? 'h-4 w-4' : 'h-5 w-5'} />}
    </IconButton>
  )
}

/** Notes on or off, for everyone in the call (only where the server offers notes). */
function NotesButton({ call }: { call: ActiveTeamCall }) {
  const { setNotes } = useTeamCalls()
  const [busy, setBusy] = useState(false)
  if (!call.features.notes) return null
  const on = call.notes.notes
  return (
    <IconButton
      label={on ? 'Turn notes off' : 'Turn notes on'}
      onClick={() => {
        if (busy) return
        setBusy(true)
        void setNotes(!on).finally(() => setBusy(false))
      }}
      active={on}
      data-team-call-notes={on ? 'on' : 'off'}
    >
      <NotebookPen className="h-5 w-5" />
    </IconButton>
  )
}

/** Record the whole call, or stop (only where the server allows recording; gone once one is saved). */
function RecordButton({ call }: { call: ActiveTeamCall }) {
  const { setRecording } = useTeamCalls()
  const [busy, setBusy] = useState(false)
  if (!call.features.recording || call.notes.recording === 'saved') return null
  const on = call.notes.recording === 'on' || call.notes.recording === 'starting'
  return (
    <IconButton
      label={on ? 'Stop recording' : 'Record the call'}
      onClick={() => {
        if (busy) return
        setBusy(true)
        void setRecording(on ? 'stop' : 'start').finally(() => setBusy(false))
      }}
      danger={on}
      data-team-call-record={call.notes.recording}
    >
      {on ? <Square className="h-4 w-4 fill-current" /> : <Circle className="h-5 w-5 fill-red-500 text-red-500" />}
    </IconButton>
  )
}

function LeaveButton({ onLeave, small = false }: { onLeave: () => void; small?: boolean }) {
  return (
    <IconButton label="Leave the call" onClick={onLeave} danger small={small} data-team-call-leave="">
      <PhoneOff className={small ? 'h-4 w-4' : 'h-5 w-5'} />
    </IconButton>
  )
}

const DEVICE_SECTIONS: ReadonlyArray<{ kind: CallDeviceKind; label: string }> = [
  { kind: 'audioinput', label: 'Microphone' },
  { kind: 'audiooutput', label: 'Speaker' },
  { kind: 'videoinput', label: 'Camera' },
]

function DevicesMenu({ session, snap }: { session: TeamCallSession; snap: CallSnapshot }) {
  const sections = DEVICE_SECTIONS.filter((s) => (s.kind === 'audiooutput' ? snap.canPickSpeaker : true)).filter((s) => snap.devices[s.kind].length > 0)
  if (sections.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Devices"
          title="Devices"
          data-team-call-devices=""
          className="flex h-11 shrink-0 items-center gap-0.5 rounded-full bg-muted px-3 text-foreground hover:bg-accent"
        >
          <Settings2 className="h-5 w-5" />
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="center" className="z-[90] w-72">
        {sections.map((s, i) => (
          <div key={s.kind}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs text-muted-foreground">{s.label}</DropdownMenuLabel>
            {snap.devices[s.kind].map((d, n) => (
              <DropdownMenuItem key={d.deviceId} onSelect={() => void session.setDevice(s.kind, d.deviceId)} className="gap-2">
                <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', snap.active[s.kind] === d.deviceId ? 'bg-emerald-500' : 'bg-transparent')} aria-hidden />
                <span className="truncate">{d.label || `${s.label} ${n + 1}`}</span>
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function RingMenu({ call, snap }: { call: ActiveTeamCall; snap: CallSnapshot }) {
  const { ring } = useTeamCalls()
  const workspaceId = useWorkspaceId()
  const [members, setMembers] = useState<Member[] | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open || !workspaceId || members) return
    let alive = true
    void cachedJson<{ members?: Member[]; memberId?: string }>('/api/account/workspace/members', { scope: workspaceId }).then((json) => {
      if (alive) setMembers(Array.isArray(json?.members) ? json.members : [])
    })
    return () => {
      alive = false
    }
  }, [open, workspaceId, members])
  const inCall = useMemo(() => new Set(snap.tiles.map((t) => t.identity)), [snap.tiles])
  const choices = (members ?? []).filter((m) => !inCall.has(m.id))
  // A call of another workspace (answered from its ring): the people listed here are this one's.
  if (!workspaceId || workspaceId !== call.workspaceId) return null
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={call.channelKind === 'dm' ? 'Ring them again' : 'Ring people'}
          title={call.channelKind === 'dm' ? 'Ring them again' : 'Ring people'}
          data-team-call-ring-menu=""
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted text-foreground hover:bg-accent"
        >
          <UserPlus className="h-5 w-5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="center" className="z-[90] max-h-72 w-64 overflow-y-auto">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Ring into the call</DropdownMenuLabel>
        {members === null ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</p>
        ) : choices.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">Everyone is here.</p>
        ) : (
          choices.map((m) => (
            <DropdownMenuItem key={m.id} onSelect={() => void ring([m.id], [m.display_name?.trim() || 'Teammate'])}>
              <span className="truncate">{m.display_name?.trim() || 'Teammate'}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
