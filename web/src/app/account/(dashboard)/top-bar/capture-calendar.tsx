'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import { areIntervalsOverlapping, format, isSameDay, parseISO } from 'date-fns'
import { CalendarX2 } from 'lucide-react'

import { useCalendarEvents } from '@/calendar/hooks/use-calendar-events'
import { CalendarProvider } from '@/calendar/contexts/calendar-context'
import { EventBlock } from '@/calendar/components/week-and-day-view/event-block'
import { CalendarTimeline } from '@/calendar/components/week-and-day-view/calendar-time-line'
import { getEventBlockStyle, getVisibleHours, groupEvents } from '@/calendar/helpers'
import type { IEvent } from '@/calendar/interfaces'

/** Pixels per hour — matches the calendar day view (96px/hour) so a 3h meeting
 *  renders 3× taller than a 1h one. */
const HOUR_HEIGHT = 96

/** How often the calendar checks whether the day has turned over. A sleeping
 *  machine pauses timers, so this also bounds how stale it can be on wake. */
const DAY_CHECK_MS = 60_000

/**
 * Today's date, moving on to the next day by itself. The calendar shows only
 * today and has no control to catch up with, so one left open overnight has to
 * notice midnight on its own — within a minute, like the now-line.
 */
function useToday(): Date {
  const [today, setToday] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => {
      setToday((day) => (isSameDay(day, new Date()) ? day : new Date()))
    }, DAY_CHECK_MS)
    return () => clearInterval(timer)
  }, [])
  return today
}

function startOfDayLocal(d: Date) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}
function endOfDayLocal(d: Date) {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return x
}

/**
 * Today's meetings on a time-grid, for the card that pours out of the Capture
 * button on hover (see CaptureBarButton). An at-a-glance view with no controls
 * of its own: it always shows today (moving on at midnight), and its accounts
 * are whatever the workspace's calendar shows — every connected account,
 * unless the Events page has narrowed them (the filter useCalendarEvents
 * shares).
 *
 * Reuses the calendar day-view's positioning math and components (getVisibleHours,
 * groupEvents, getEventBlockStyle, EventBlock, CalendarTimeline) so events are
 * sized by duration and the "now" line shows how far you are into a meeting.
 * The grid auto-scrolls so the current time is centred on open.
 *
 * Clicking a meeting starts its capture: the whole block is the Start button
 * (EventBlock's `startOnClick`), because a short meeting's block is too small
 * to hold one. Nothing opens here — event details live on the Events page.
 * All-day events sit collapsed above the grid as plain labels: they aren't
 * meetings, so there's nothing to capture.
 *
 * Fills its parent. The parent paints the surface: this renders no background
 * of its own, so it sits on whatever card holds it.
 */
export function CaptureCalendar({
  hint,
}: {
  /** Shown at the right of the header row — the Capture button's own hint. */
  hint?: ReactNode
}) {
  const { events, loading, error } = useCalendarEvents()
  const today = useToday()

  // Today's calendar events (no actions). Split all-day vs timed.
  const { allDay, timed } = useMemo(() => {
    const dayStart = startOfDayLocal(today)
    const dayEnd = endOfDayLocal(today)
    const all: IEvent[] = []
    const t: IEvent[] = []
    for (const e of events) {
      if (e.isAction) continue
      const start = parseISO(e.startDate)
      const end = parseISO(e.endDate)
      if (e.isAllDay) {
        // All-day (incl. multi-day) events that cover today.
        if (start <= dayEnd && end >= dayStart) all.push(e)
        continue
      }
      // Timed events that intersect today.
      if (start <= dayEnd && end >= dayStart) t.push(e)
    }
    return { allDay: all, timed: t }
  }, [events, today])

  let body: ReactNode
  if (loading) {
    body = (
      <div className="flex flex-1 items-center justify-center">
        <ThinkingOrb state="breathing" size={20} theme="auto" />
      </div>
    )
  } else if (error === 'no-provider') {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-muted-foreground">
        <CalendarX2 className="h-7 w-7" />
        <p className="text-xs">Connect a calendar in Settings to see your meetings.</p>
      </div>
    )
  } else if (allDay.length === 0 && timed.length === 0) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-muted-foreground">
        <CalendarX2 className="h-7 w-7" />
        <p className="text-xs">Nothing scheduled today.</p>
      </div>
    )
  } else {
    body = (
      // CalendarProvider supplies the calendar settings EventBlock reads (badge
      // style). Nothing here selects an event, so no onSelectEvent.
      <CalendarProvider events={events}>
        <div className="flex min-h-0 flex-1 flex-col">
          {allDay.length > 0 && <AllDayStrip events={allDay} />}
          {/* Keyed by day: a new day remounts the grid, which centres on the
              now-line again. */}
          <CompactDayGrid key={format(today, 'yyyy-MM-dd')} date={today} events={timed} />
        </div>
      </CalendarProvider>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/50 px-3 text-[11px]">
        <span className="font-semibold text-foreground/80">Today</span>
        <span className="text-muted-foreground">{format(today, 'EEE, MMM d')}</span>
        {hint && <span className="ml-auto flex items-center text-muted-foreground">{hint}</span>}
      </div>
      {body}
    </div>
  )
}

/** All-day events, collapsed to title labels, stacked above the time-grid. */
function AllDayStrip({ events }: { events: IEvent[] }) {
  return (
    <div className="shrink-0 space-y-1 border-b border-border/40 p-2">
      {events.map((event) => (
        <div
          key={event.id}
          className="flex w-full min-w-0 items-center gap-1.5 rounded-md border border-border/50 bg-muted/40 px-2 py-1"
        >
          <span className="h-3 w-1 shrink-0 rounded-full bg-muted-foreground/40" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/80">
            {event.title}
          </span>
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">
            All day
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Compact time-grid for today. Copy-and-trim of the calendar day view: reuses
 * the positioning helpers + EventBlock + CalendarTimeline, drops all drag/drop,
 * quick-add, and the side panel. Auto-scrolls so "now" is centred on mount.
 */
function CompactDayGrid({ date, events }: { date: Date; events: IEvent[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Grouping + O(n²) overlap checks parse dates throughout — compute once per
  // (events, day) instead of on every render.
  const { hours, earliestEventHour, latestEventHour, positionedEvents } = useMemo(() => {
    const visible = getVisibleHours({ from: 0, to: 24 }, events)
    const groupedEvents = groupEvents(events)
    const positioned = groupedEvents.flatMap((group, groupIndex) =>
      group.map((event) => {
        let style = getEventBlockStyle(event, date, groupIndex, groupedEvents.length, {
          from: visible.earliestEventHour,
          to: visible.latestEventHour,
        })
        const hasOverlap = groupedEvents.some(
          (otherGroup, otherIndex) =>
            otherIndex !== groupIndex &&
            otherGroup.some((otherEvent) =>
              areIntervalsOverlapping(
                { start: parseISO(event.startDate), end: parseISO(event.endDate) },
                { start: parseISO(otherEvent.startDate), end: parseISO(otherEvent.endDate) },
              ),
            ),
        )
        if (!hasOverlap) style = { ...style, width: '100%', left: '0%' }
        return { event, style }
      }),
    )
    return { ...visible, positionedEvents: positioned }
  }, [events, date])

  // On mount: centre "now". Worked out from the clock, not measured off the
  // now-line: the card this sits in is still collapsed to nothing when it
  // mounts (it grows out of the Capture button), so on-screen rects are all
  // zero then. Layout sizes aren't touched by that, so the grid's padding and
  // the viewport's height still read true.
  useEffect(() => {
    const viewport = scrollRef.current
    const grid = viewport?.firstElementChild
    if (!viewport || !(grid instanceof HTMLElement)) return
    const now = new Date()
    const hoursIn = now.getHours() + now.getMinutes() / 60 - earliestEventHour
    const nowTop = (parseFloat(getComputedStyle(grid).paddingTop) || 0) + hoursIn * HOUR_HEIGHT
    viewport.scrollTop = nowTop - viewport.clientHeight / 2
  }, [earliestEventHour])

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      {/* will-change-transform: own compositor layer → cached tiles while
          scrolling, so the scrolled grid doesn't make the liquid under it
          re-rasterize every frame. */}
      <div className="flex p-2 pl-0 will-change-transform">
        {/* Hour axis — w-18 (72px) matches the day view so CalendarTimeline's
            time label (positioned at -left-18) lands inside this column. */}
        <div className="relative w-18 shrink-0">
          {hours.map((hour, index) => (
            <div key={hour} className="relative" style={{ height: HOUR_HEIGHT }}>
              <div className="absolute -top-2 right-2 flex h-4 items-center">
                {index !== 0 && (
                  <span className="text-[10px] text-muted-foreground">
                    {format(new Date().setHours(hour, 0, 0, 0), 'h a')}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Time grid */}
        <div className="relative flex-1 border-l">
          {/* Hour rows + gridlines */}
          {hours.map((hour, index) => (
            <div key={hour} className="relative" style={{ height: HOUR_HEIGHT }}>
              {index !== 0 && <div className="pointer-events-none absolute inset-x-0 top-0 border-b border-border/50" />}
              <div className="pointer-events-none absolute inset-x-0 top-1/2 border-b border-dashed border-border/40" />
            </div>
          ))}

          {/* Event blocks — positioned + sized by time. A click starts the
              meeting's capture. */}
          {positionedEvents.map(({ event, style }) => (
            <div key={`${event.id}-${event.startDate}`} className="absolute p-0.5" style={style}>
              <EventBlock event={event} readOnly startOnClick />
            </div>
          ))}

          {/* Current-time marker (reused verbatim). */}
          <CalendarTimeline firstVisibleHour={earliestEventHour} lastVisibleHour={latestEventHour} />
        </div>
      </div>
    </div>
  )
}
