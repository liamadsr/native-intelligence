'use client'

/**
 * The find_times card: the times the agent found, and for a group, each
 * person with a tick or why their time is unknown. The plan card's frame and
 * marks (tool-renderers.tsx planCard, components/work/plan-checklist.tsx):
 * a small bordered box under the reply, one line per item. Read-only: the
 * agent offers the times in its reply; nothing here books anything.
 * Never animated, so a stored reply costs nothing to draw again.
 */
import { memo } from 'react'
import { Check, CircleHelp } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FindTimesCardData } from '@/lib/availability/find-times-card'

function heading(data: FindTimesCardData): string {
  const length = data.durationMinutes ? ` · ${data.durationMinutes} min` : ''
  if (data.unknown) return `No common times${length}`
  if (!data.suggested.length) return `Nothing free in this range${length}`
  return `${data.people ? 'Times that work for everyone' : 'Times that work'}${length}`
}

function FindTimesCardImpl({ data }: { data: FindTimesCardData }) {
  return (
    <div data-find-times-card="" className="w-fit max-w-full self-start rounded-xl border border-border/60 bg-background px-3 py-2">
      <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
        {heading(data)}
        {data.zone && data.suggested.length > 0 && <span className="font-normal text-muted-foreground/70"> · {data.zone}</span>}
      </p>
      {data.suggested.length > 0 && (
        <ul data-find-times-suggested="" className="space-y-1">
          {data.suggested.map((label) => (
            <li key={label} className="text-xs text-foreground">
              {label}
            </li>
          ))}
        </ul>
      )}
      {data.people && (
        <ul data-find-times-people="" className={cn('space-y-1', data.suggested.length > 0 && 'mt-2 border-t border-border/50 pt-2')}>
          {data.people.map((p, i) => (
            <li key={`${i}-${p.name}`} data-coverage={p.known ? 'complete' : 'unknown'} className="flex items-start gap-2 text-xs">
              <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-label={p.known ? 'Known' : 'Unknown'} title={p.known ? 'Known' : 'Unknown'}>
                {p.known ? <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" /> : <CircleHelp className="h-3 w-3 text-muted-foreground/70" />}
              </span>
              <span className="min-w-0">
                <span className={p.known ? 'text-foreground/80' : 'text-foreground'}>{p.you ? 'You' : p.name}</span>
                {p.zone && <span className="text-muted-foreground/70"> · {p.zone}</span>}
                {!p.known && <span className="text-muted-foreground"> · unknown: {p.reason ?? 'their time could not be read'}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export const FindTimesCard = memo(FindTimesCardImpl)
