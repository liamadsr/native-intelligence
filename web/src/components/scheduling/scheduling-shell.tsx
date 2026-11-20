/**
 * The public scheduling pages' frame and pieces: a business's booking page
 * (/book/<slug>), a booking link's page (/book/<handle>/<slug>), a time
 * offer's page (/t/<token>) and a guest's manage page (/b/<token>). One glass
 * card on the public sky (components/sky/public-sky.tsx, behind every public
 * page), as the app's own floating cards are (attention/card-skin.ts), the
 * footer under it on a chip of the same glass. Its controls are the app's shapes: a day
 * is a rounded tile, a time a pill, the picked one the primary button's fill.
 */
import type { ReactNode } from 'react'
import { Clock, MapPin, Video } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { COLUMN_CARD_SKIN } from '@/components/attention/card-skin'
import { lengthLabel } from '@/lib/time-offers/display'
import { cn } from '@/lib/utils'

export function SchedulingShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-4 text-foreground sm:p-6 lg:p-8" data-scheduling-shell="">
      <Card className={cn('w-full max-w-lg rounded-2xl border-border/60', COLUMN_CARD_SKIN)}>{children}</Card>
      {/* On its own glass: the sky behind it can be day or night in either theme. */}
      <p className="rounded-full bg-background/60 px-3 py-1 text-xs text-muted-foreground backdrop-blur-md">Scheduling by Native Intelligence</p>
    </div>
  )
}

/** The picked day or time: the primary button's fill, so the pick and "Confirm" read as one. */
export const PICKED = 'border-transparent bg-primary text-primary-foreground shadow-sm'
/** A control's hairline on the glass card, and a section's rule. */
export const QUIET_EDGE = 'border-foreground/15 dark:border-white/10'

/** One time to pick: a pill, pressed when it's the one picked. */
export function TimeButton({ on, onClick, children, disabled }: { on: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      disabled={disabled}
      className={cn(
        'h-9 rounded-full border px-3 text-sm tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 motion-reduce:transition-none',
        on ? PICKED : `${QUIET_EDGE} hover:bg-foreground/[0.06]`,
      )}
    >
      {children}
    </button>
  )
}

/** A line the page needs the guest to see: a problem, or news. */
export function SchedulingNotice({ tone = 'error', children, ...rest }: { tone?: 'error' | 'info'; children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <div
      {...rest}
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'rounded-xl px-3 py-2 text-sm',
        tone === 'error' ? 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300' : 'bg-foreground/[0.06] text-foreground',
      )}
    >
      {children}
    </div>
  )
}

/** Length and place: "30 min · Video call". */
export function SchedulingMeta({ minutes, video, location, children }: { minutes: number; video: boolean; location: string | null; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <Clock aria-hidden className="size-4" />
        {lengthLabel(minutes)}
      </span>
      {video ? (
        <span className="flex items-center gap-1.5">
          <Video aria-hidden className="size-4" />
          Video call
        </span>
      ) : location ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <MapPin aria-hidden className="size-4 shrink-0" />
          <span className="truncate">{location}</span>
        </span>
      ) : null}
      {children}
    </div>
  )
}
