'use client'

/**
 * The pieces of a call's window that both call surfaces draw: the members'
 * panel (./call-panel.tsx, inside the app) and a meeting guest's page
 * (src/components/meeting-links/guest-meeting.tsx, public, no app around it).
 * Nothing here reads the app's context (workspace, team chat, menus), so the
 * guest's page carries none of it. Everything is drawn from the session's
 * snapshot (src/lib/team-calls/call-session.ts): no timer, no animation loop.
 */

import { useEffect, useRef } from 'react'
import { MicOff, NotebookPen } from 'lucide-react'
import type { Track } from 'livekit-client'
import { cn } from '@/lib/utils'
import type { CallDeviceState, CallSnapshot, CallTile } from '@/lib/team-calls/call-session'
import type { TeamCallNotesView } from '@/lib/team-calls/notes'

export function initialsOf(name: string): string {
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

/** What an error says: the call couldn't load (its code) or couldn't reach the call server. */
export function callErrorLine(error: CallSnapshot['error']): string {
  return error === 'load' ? 'Calling couldn’t load. Check your connection, then retry.' : 'Couldn’t reach the call. Check your connection, then retry.'
}

/**
 * What is on for everyone in the call: notes, a recording. Static words, no
 * animation; nothing when neither is on. `onOpenNotes`: the notes are a
 * capture filling in now (the call recorder's), and the badge opens it.
 */
export function CallBadges({ notes, small = false, onOpenNotes }: { notes: Pick<TeamCallNotesView, 'notes' | 'recording'>; small?: boolean; onOpenNotes?: () => void }) {
  const recording = notes.recording === 'on' || notes.recording === 'starting'
  if (!notes.notes && !recording) return null
  const notesClass = cn('flex items-center gap-1 rounded-full bg-sky-500/15 font-medium text-sky-800 dark:text-sky-200', small ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]')
  return (
    <span className="flex shrink-0 items-center gap-1" data-team-call-badges="">
      {notes.notes &&
        (onOpenNotes ? (
          <button type="button" data-team-call-notes-on="" data-team-call-notes-open="" title="Open the notes" onClick={onOpenNotes} className={cn(notesClass, 'hover:bg-sky-500/25')}>
            <NotebookPen className="h-3 w-3" aria-hidden />
            {small ? 'Notes on' : 'Notes are on'}
          </button>
        ) : (
          <span data-team-call-notes-on="" className={notesClass}>
            <NotebookPen className="h-3 w-3" aria-hidden />
            {small ? 'Notes on' : 'Notes are on'}
          </span>
        ))}
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

/** One person (or a shared screen) in the call. A meeting guest is labelled "Guest". */
export function TileView({ tile, large = false, compact = false, action }: { tile: CallTile; large?: boolean; compact?: boolean; action?: React.ReactNode }) {
  return (
    <div
      data-team-call-tile={tile.kind}
      data-team-call-guest={tile.guest || undefined}
      data-speaking={tile.speaking || undefined}
      className={cn(
        'group relative overflow-hidden rounded-2xl bg-muted transition-shadow duration-150',
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
        {tile.guest && tile.kind === 'person' && (
          <span data-team-call-guest-label="" className="shrink-0 rounded-full bg-white/20 px-1.5 text-[10px] font-semibold uppercase tracking-wide">
            Guest
          </span>
        )}
      </span>
      {action && <span className="absolute right-1.5 top-1.5">{action}</span>}
    </div>
  )
}

/** A video track drawn in a <video> while the tile is on screen (adaptive stream reads its size and visibility). */
export function TrackVideo({ track, mirror, contain }: { track: Track; mirror: boolean; contain: boolean }) {
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

export function IconButton({
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
