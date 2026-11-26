'use client'

/**
 * The pieces of a call's window that both call surfaces draw: the members'
 * panel (./call-panel.tsx, inside the app) and a meeting guest's page
 * (src/components/meeting-links/guest-meeting.tsx, public, no app around it).
 * Nothing here reads the app's context (workspace, team chat, menus), so the
 * guest's page carries none of it. Everything is drawn from the session's
 * snapshot (src/lib/team-calls/call-session.ts): no timer, no animation loop.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MicOff, NotebookPen } from 'lucide-react'
import type { Track } from 'livekit-client'
import { cn } from '@/lib/utils'
import type { CallDeviceState, CallSnapshot, CallTile } from '@/lib/team-calls/call-session'
import type { TeamCallNotesView } from '@/lib/team-calls/notes'
import { callLayout, type CallStageSize } from '@/lib/team-calls/call-layout'

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

/** A screen share the system refused: where to allow it (a browser needs a restart after). */
export function screenNotice(blocked: boolean, desktop: boolean): string | null {
  if (!blocked) return null
  return desktop
    ? 'Your screen couldn’t be shared from the app. It needs macOS 14.6 or later, with Native Intelligence turned on in System Settings → Privacy & Security → Screen & System Audio Recording. You can also open this call in your browser and share from there.'
    : 'Your screen couldn’t be shared. On a Mac, allow your browser in System Settings → Privacy & Security → Screen & System Audio Recording, restart the browser, then share again.'
}

/** A screen share a lost connection ended: said once, until they share again (or try to). */
export function screenDroppedNotice(dropped: boolean): string | null {
  return dropped ? 'Your connection dropped for a moment, so your screen stopped sharing. Share it again when you’re ready.' : null
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

/**
 * One person (or a shared screen) in the call. A meeting guest is labelled "Guest".
 * `glass`: the tile sits on the public sky (a meeting guest's page), so with no
 * video it is clear glass, not the app's muted fill.
 */
export function TileView({
  tile,
  large = false,
  compact = false,
  glass = false,
  fill = false,
  action,
}: {
  tile: CallTile
  large?: boolean
  compact?: boolean
  glass?: boolean
  /** Fill the box it is put in (the stage sized it, ./call-layout), not a shape of its own. */
  fill?: boolean
  action?: React.ReactNode
}) {
  return (
    <div
      data-team-call-tile={tile.kind}
      data-team-call-guest={tile.guest || undefined}
      data-speaking={tile.speaking || undefined}
      className={cn(
        'group relative overflow-hidden transition-shadow duration-150',
        glass ? cn('rounded-3xl', tile.video ? 'bg-black' : 'border border-foreground/10 bg-background/35 backdrop-blur-2xl dark:bg-white/[0.04]') : 'rounded-2xl bg-muted',
        fill ? 'h-full w-full' : large ? 'aspect-video' : compact ? 'aspect-square' : 'aspect-video',
        tile.speaking ? 'ring-2 ring-emerald-500' : 'ring-0',
      )}
    >
      {tile.video ? (
        <TrackVideo track={tile.video} mirror={tile.isLocal && tile.kind === 'person'} contain={tile.kind === 'screen'} />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <span
            className={cn(
              'flex items-center justify-center rounded-full font-semibold text-muted-foreground',
              glass ? 'border border-foreground/10 bg-background/70 dark:bg-white/10' : 'bg-background',
              compact ? 'h-9 w-9 text-xs' : glass ? 'h-16 w-16 text-lg sm:h-20 sm:w-20 sm:text-xl' : 'h-14 w-14 text-base',
            )}
          >
            {initialsOf(tile.name)}
          </span>
        </div>
      )}
      <span className={cn('absolute flex max-w-[calc(100%-12px)] items-center gap-1 rounded-full bg-black/55 font-medium text-white', glass && !compact ? 'bottom-3 left-3 px-2.5 py-1 text-xs' : 'bottom-1.5 left-1.5 px-2 py-0.5 text-[11px]')}>
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

/**
 * The box the stage measures, content box, as it changes (rotation, a resize, a side panel
 * opening). `{0, 0}` until measured, and where there is no layout (a test).
 * `unbounded`: the box grows with what it holds, so only its width counts.
 */
function useStageSize(unbounded: boolean): [React.RefObject<HTMLDivElement | null>, CallStageSize] {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<CallStageSize>({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      const width = el.clientWidth
      const height = unbounded ? Infinity : el.clientHeight
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }))
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [unbounded])
  return [ref, size]
}

/** Room left around the tiles inside the stage, so a speaking ring (2px, outside the tile) isn't clipped. */
const STAGE_INSET_PX = 4

/**
 * Everyone in the call, laid out to use the box they are given (./call-layout,
 * the rule, by count and the box's shape): on a phone held upright two people
 * stack, each half the stage; a shared screen takes the stage and the people
 * become a strip under it. `unbounded`: the box grows with its tiles (the
 * members' panel at the side); else it must have a height of its own (a flex
 * child), which is what the tiles fill.
 */
export function CallStage({
  people,
  screens,
  glass = false,
  gap = 8,
  unbounded = false,
  actionFor,
  className,
  ...rest
}: {
  people: CallTile[]
  screens: CallTile[]
  glass?: boolean
  gap?: number
  unbounded?: boolean
  actionFor?: (tile: CallTile) => React.ReactNode
  className?: string
} & Record<`data-${string}`, string | number | undefined>) {
  const [ref, measured] = useStageSize(unbounded)
  const inner = { width: measured.width - STAGE_INSET_PX * 2, height: measured.height - STAGE_INSET_PX * 2 }
  const layout = callLayout(people.length, screens.length, inner, { gap })
  const share = screens.length > 0
  const side = layout.mode === 'share' && layout.strip === 'side'
  const tile = (t: CallTile, extra: { compact?: boolean; fill?: boolean; large?: boolean } = {}) => (
    <TileView key={t.key} tile={t} glass={glass} action={actionFor?.(t)} {...extra} />
  )
  return (
    <div
      ref={ref}
      {...rest}
      data-team-call-layout={layout.mode === 'grid' ? `${layout.cols}x${layout.rows}` : layout.mode}
      className={cn('relative min-w-0', !unbounded && 'min-h-0', layout.mode === 'grid' && layout.scroll ? 'overflow-y-auto' : 'overflow-hidden', className)}
      style={{ padding: STAGE_INSET_PX }}
    >
      {share ? (
        <div className={cn('flex', side ? 'flex-row' : 'flex-col', unbounded ? '' : 'h-full')} style={{ gap }}>
          <div className={cn('flex min-w-0 flex-col', unbounded ? '' : 'min-h-0 flex-1')} style={{ gap }}>
            {screens.map((t) => (
              <div key={t.key} className={unbounded ? 'aspect-video' : 'min-h-0 flex-1'}>
                {tile(t, { fill: true })}
              </div>
            ))}
          </div>
          {people.length > 0 &&
            (side ? (
              <div data-team-call-strip="side" className="flex w-24 shrink-0 flex-col overflow-y-auto" style={{ gap }}>
                {people.map((t) => (
                  <div key={t.key} className="shrink-0">
                    {tile(t, { compact: true })}
                  </div>
                ))}
              </div>
            ) : (
              <div
                data-team-call-strip="bottom"
                className="grid max-h-[40%] shrink-0 overflow-y-auto"
                style={{ gap, gridTemplateColumns: `repeat(${layout.mode === 'share' ? layout.stripCols : 4}, minmax(0, 1fr))`, gridAutoRows: 'max-content' }}
              >
                {people.map((t) => tile(t, { compact: true }))}
              </div>
            ))}
        </div>
      ) : layout.mode === 'grid' ? (
        <div className={cn('flex flex-wrap justify-center', unbounded ? '' : 'min-h-full', layout.scroll ? 'content-start' : 'content-center')} style={{ gap }}>
          {people.map((t) => (
            <div key={t.key} className="shrink-0" style={{ width: layout.tileWidth, height: layout.tileHeight }}>
              {tile(t, { fill: true })}
            </div>
          ))}
        </div>
      ) : (
        // Not measured yet: the tiles keep their own shape, two across.
        <div className={cn('grid', people.length <= 1 ? 'grid-cols-1' : 'grid-cols-2')} style={{ gap }}>
          {people.map((t) => tile(t))}
        </div>
      )}
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
  disabled = false,
  glass = false,
  children,
  ...rest
}: {
  label: string
  onClick: () => void
  active?: boolean
  danger?: boolean
  small?: boolean
  disabled?: boolean
  /** On the public sky (a meeting guest's page): a clear resting fill, not the app's muted one. */
  glass?: boolean
  children: React.ReactNode
} & Record<`data-${string}`, string | undefined>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      {...rest}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        small ? 'h-8 w-8' : 'h-11 w-11',
        danger ? 'bg-red-500 text-white hover:bg-red-600' : active ? 'bg-foreground text-background hover:bg-foreground/90' : glass ? 'bg-foreground/[0.08] text-foreground hover:bg-foreground/[0.14]' : 'bg-muted text-foreground hover:bg-accent',
      )}
    >
      {children}
    </button>
  )
}
