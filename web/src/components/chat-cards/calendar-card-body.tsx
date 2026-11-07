'use client'

/**
 * A calendar card's page (docs/plans/one-agent-and-chat-pages.md, P2): the
 * Calendar page's grid at the card's own day, week or month
 * (CalendarCardView), never the page's shared events or account filter.
 *
 *   - Where the person moves it (date, view, accounts) stays with the card,
 *     kept per device, and is what the agent hears and read_card reads.
 *   - Its count is the calendar events in the range on screen (timed actions
 *     draw on the grid too, but are not events), the same count `show` gave.
 *   - An event opens inside the card, as its detail panel; a timed action as
 *     the action's. The card header's Back returns to the grid.
 */
import * as React from 'react'
import { format, parseISO } from 'date-fns'
import { CalendarCardView, type CalendarCardState } from '@/app/account/(dashboard)/views/calendar-view'
import { CalendarEventDetailPanel } from '@/app/account/(dashboard)/views/calendar-event-detail-panel'
import type { IEvent } from '@/calendar/interfaces'
import { calendarRange } from '@/lib/chat-cards/calendar'
import type { CalendarCardSpec, CalendarQuery } from '@/lib/chat-cards/kinds'
import { CardRecordPanel, isRecordType, useOpenRecords, type CardBodyProps } from './card-body'
import { CardOverlay, CardCovered } from './card-covered'

/** The rows the agent's note carries: "Thu 9 10:00 Standup". */
export function eventRow(event: IEvent): string {
  const start = parseISO(event.startDate)
  if (Number.isNaN(start.getTime())) return event.title
  return `${format(start, 'EEE d')} ${event.isAllDay ? 'all day' : format(start, 'HH:mm')} ${event.title || '(no title)'}`
}

/** A card state as the range it shows (what the agent's note and read_card use). */
export function queryOfCardState(state: CalendarCardState): CalendarQuery {
  return { ...calendarRange(state.view, state.date), view: state.view, ...(state.accounts?.length ? { accounts: state.accounts } : {}) }
}

export default function CalendarCardBody({ toolCallId, spec, store, fullScreen, onCount }: CardBodyProps & { spec: CalendarCardSpec }) {
  const records = useOpenRecords(toolCallId, store)
  // Where the card was left, or the agent's range. Read once: the view owns it after.
  const [initial] = React.useState<CalendarCardState>(() => {
    const kept = store.state(toolCallId).cal ?? spec.calendar
    return { view: kept.view, date: kept.from, accounts: kept.accounts?.length ? kept.accounts : null }
  })
  const eventsRef = React.useRef<IEvent[]>([])
  // An event kept open across a reload draws once the range has loaded; one
  // the range doesn't hold (Back to it after a move to another week, or it was
  // deleted) says so then, rather than loading forever.
  const [loaded, setLoaded] = React.useState(0)
  const onCountRef = React.useRef(onCount)
  onCountRef.current = onCount

  const onEvents = React.useCallback(
    (events: IEvent[] | null) => {
      if (!events) {
        setLoaded(0)
        onCountRef.current?.(null)
        return
      }
      eventsRef.current = events
      setLoaded((n) => n + 1)
      const shown = events.filter((e) => !e.isAction).sort((a, b) => a.startDate.localeCompare(b.startDate))
      store.update(toolCallId, { count: shown.length, rows: shown.slice(0, 5).map((e) => ({ title: eventRow(e) })) })
      onCountRef.current?.(shown.length)
    },
    [store, toolCallId],
  )

  const open = records.current
  const openEvent = open?.type === 'event' ? eventsRef.current.find((e) => e.id === open.id) ?? null : null

  return (
    <div className="relative h-full min-h-0">
      <CardCovered covered={!!open}>
        <CalendarCardView
          initial={initial}
          compact={!fullScreen}
          onStateChange={(state) => store.update(toolCallId, { cal: queryOfCardState(state) }, { touch: true })}
          onEvents={onEvents}
          onSelectEvent={(event) => records.open({ type: 'event', id: event.id, label: event.title })}
          onSelectAction={(id) => records.open({ type: 'action', id })}
        />
      </CardCovered>
      {open && (
        <CardOverlay>
          <div className="min-h-0 flex-1 overflow-hidden">
            {open.type === 'event' ? (
              !openEvent && loaded > 0 ? (
                // No single-event read exists: the range is what the card can draw.
                <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
                  <p>This event isn&rsquo;t in this range.</p>
                  <button type="button" onClick={records.close} className="rounded-md px-2 py-1 text-xs font-medium text-foreground hover:bg-muted">
                    Show the calendar
                  </button>
                </div>
              ) : openEvent ? (
                <CalendarEventDetailPanel
                  key={openEvent.id}
                  event={openEvent}
                  onClose={records.close}
                  onEventUpdate={(updated) => {
                    eventsRef.current = eventsRef.current.map((e) => (e.id === updated.id ? updated : e))
                  }}
                  onEventDelete={records.close}
                  onOpenCapture={(id, title) => records.open({ type: 'capture', id, label: title })}
                />
              ) : (
                <div className="p-4 text-xs text-muted-foreground">Loading…</div>
              )
            ) : isRecordType(open.type) ? (
              <CardRecordPanel record={open} onOpen={records.open} onClose={records.close} />
            ) : null}
          </div>
        </CardOverlay>
      )}
    </div>
  )
}
