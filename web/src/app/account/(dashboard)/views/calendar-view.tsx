'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import { useRouter } from 'next/navigation'
import { CalendarX2 } from 'lucide-react'
import { CalendarProvider } from '@/calendar/contexts/calendar-context'
import { ClientContainer } from '@/calendar/components/client-container'
import { useCalendarEvents, useCalendarRangeEvents } from '@/calendar/hooks/use-calendar-events'
import type { IEvent } from '@/calendar/interfaces'
import { withCalendarColors } from '@/calendar/event-colors'
import { listCalendars, readHiddenCalendars, withoutHiddenCalendars, writeHiddenCalendars } from '@/calendar/sidebar/calendar-visibility'
import type { TCalendarView } from '@/calendar/types'
import { Button } from '@/components/ui/button'
import { useOptionalSettingsOverlay } from '../settings-overlay'
import { addDays, calendarRange, localIsoDate, localMidnight } from '@/lib/chat-cards/calendar'
import type { CalendarCardView as CardView } from '@/lib/chat-cards/kinds'

interface CalendarSelectProps {
  onSelectAction?: (actionId: string) => void
  onSelectEvent?: (event: IEvent) => void
}

/** The Calendar page: the shared events (one cache with the Capture button's calendar) and the shared account filter. */
export function CalendarView({ onSelectAction, onSelectEvent }: CalendarSelectProps) {
  const { events, loading, error, filterAccountIds, setFilterAccountIds } = useCalendarEvents()
  const [view, setView] = useState<TCalendarView>('day')
  return (
    <CalendarSurface
      events={events}
      loading={loading}
      error={error}
      view={view}
      onViewChange={setView}
      filterAccountIds={filterAccountIds}
      onFilterChange={setFilterAccountIds}
      onSelectAction={onSelectAction}
      onSelectEvent={onSelectEvent}
      sidebar={{}}
    />
  )
}

/** How far ahead the sidebar's "Upcoming events" looks when the grid holds only the range on screen. */
const UPCOMING_DAYS = 30

const SIDEBAR_CLOSED_KEY = 'ni:calendar-sidebar-closed:v1'

/** The page's sidebar: open unless the person closed it (kept in this browser), and the calendars they hid. */
function useSidebarState() {
  const [open, setOpen] = useState(true)
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  // After mount, so the server's markup and the first client render agree.
  useEffect(() => {
    try {
      if (localStorage.getItem(SIDEBAR_CLOSED_KEY) === '1') setOpen(false)
    } catch {
      // Open, then.
    }
    setHidden(readHiddenCalendars())
  }, [])
  return {
    open,
    hidden,
    onOpenChange: (next: boolean) => {
      setOpen(next)
      try {
        if (next) localStorage.removeItem(SIDEBAR_CLOSED_KEY)
        else localStorage.setItem(SIDEBAR_CLOSED_KEY, '1')
      } catch {
        // For this visit only.
      }
    },
    onHiddenChange: (next: Set<string>) => {
      setHidden(next)
      writeHiddenCalendars(next)
    },
  }
}

/** Where a calendar card is: what the person moved it to. */
export interface CalendarCardState {
  view: CardView
  /** The date the grid is at (YYYY-MM-DD, local). */
  date: string
  accounts: string[] | null
}

export interface CalendarCardViewProps extends CalendarSelectProps {
  /** Where the card opens: the agent's range, or where the person left it. Read at mount. */
  initial: CalendarCardState
  /** The slimmer header, for the card inline in the chat. */
  compact?: boolean
  /** The person moved the date, switched the view or the accounts. */
  onStateChange?: (state: CalendarCardState) => void
  /** The events in the range on screen, whenever they change (null while the first load runs). */
  onEvents?: (events: IEvent[] | null) => void
}

const CARD_VIEWS: readonly TCalendarView[] = ['day', 'week', 'month']

/**
 * A calendar card in the chat (docs/plans/one-agent-and-chat-pages.md, P2):
 * the same grid as the page, at the card's own view, date and accounts, on
 * its own events (useCalendarRangeEvents). Nothing here reads or writes the
 * page's shared events or account filter, so a card never moves the Calendar
 * page or the Capture button's calendar, and the page never moves a card.
 */
export function CalendarCardView({ initial, compact, onStateChange, onEvents, onSelectAction, onSelectEvent }: CalendarCardViewProps) {
  const [state, setState] = useState<CalendarCardState>(initial)
  const [initialDate] = useState(() => localMidnight(initial.date))
  const range = calendarRange(state.view, state.date)
  const timeMin = useMemo(() => localMidnight(range.from).toISOString(), [range.from])
  const timeMax = useMemo(() => localMidnight(addDays(range.to, 1)).toISOString(), [range.to])
  const { events, loading, error } = useCalendarRangeEvents(timeMin, timeMax, state.accounts)
  // The Calendar window (not the slim card inline in a chat) has the sidebar. Its upcoming list is from
  // today on, whatever range the grid is at, so it reads its own window: the same accounts, the same route.
  const [upcomingMin, upcomingMax] = useMemo(() => {
    const today = localIsoDate(new Date())
    return [localMidnight(today).toISOString(), localMidnight(addDays(today, UPCOMING_DAYS)).toISOString()]
  }, [])
  const upcoming = useCalendarRangeEvents(upcomingMin, upcomingMax, state.accounts, !compact)

  // The person's moves: kept here, and reported (never to the page).
  const onStateChangeRef = useRef(onStateChange)
  onStateChangeRef.current = onStateChange
  const firstRef = useRef(true)
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false
      return
    }
    onStateChangeRef.current?.(state)
  }, [state])

  const onEventsRef = useRef(onEvents)
  onEventsRef.current = onEvents
  useEffect(() => {
    onEventsRef.current?.(loading && events.length === 0 ? null : events)
  }, [events, loading])

  return (
    <CalendarSurface
      events={events}
      loading={loading && events.length === 0}
      error={error}
      view={state.view}
      onViewChange={(view) => {
        if ((CARD_VIEWS as readonly string[]).includes(view)) setState((prev) => (prev.view === view ? prev : { ...prev, view: view as CardView }))
      }}
      filterAccountIds={state.accounts}
      onFilterChange={(accounts) => setState((prev) => ({ ...prev, accounts }))}
      onSelectAction={onSelectAction}
      onSelectEvent={onSelectEvent}
      sidebar={compact ? undefined : { upcoming: upcoming.events }}
      card={{
        compact: !!compact,
        views: CARD_VIEWS,
        initialDate,
        onDateChange: (date) => {
          const iso = localIsoDate(date)
          setState((prev) => (prev.date === iso ? prev : { ...prev, date: iso }))
        },
      }}
    />
  )
}

interface CalendarSurfaceCard {
  compact: boolean
  views: readonly TCalendarView[]
  initialDate: Date
  onDateChange: (date: Date) => void
}

/** The calendar itself, from whichever events and filter it is given. */
function CalendarSurface({
  events,
  loading,
  error,
  view,
  onViewChange,
  filterAccountIds,
  onFilterChange,
  onSelectAction,
  onSelectEvent,
  card,
  sidebar: withSidebar,
}: CalendarSelectProps & {
  /**
   * The Calendar page and window: the sidebar, and the calendars hidden from it. The slim card inline in a
   * chat has neither. `upcoming`: the events its upcoming list reads when the grid's own are only the range
   * on screen (absent: the grid's).
   */
  sidebar?: { upcoming?: IEvent[] }
  events: IEvent[]
  loading: boolean
  error: string | null
  view: TCalendarView
  onViewChange: (view: TCalendarView) => void
  filterAccountIds: string[] | null
  onFilterChange: (ids: string[] | null) => void
  card?: CalendarSurfaceCard
}) {
  const settingsOverlay = useOptionalSettingsOverlay()
  const router = useRouter()
  // One colour per calendar on screen (adapters' withCalendarColors). With a sidebar, the grid's events and
  // the upcoming list's are coloured together, so a calendar has one colour in both and in the calendar list.
  const upcomingSource = withSidebar?.upcoming
  const { coloredEvents, coloredUpcoming } = useMemo(() => {
    if (!upcomingSource) return { coloredEvents: withCalendarColors(events), coloredUpcoming: undefined }
    const onGrid = new Set(events.map((e) => e.id))
    const all = withCalendarColors([...events, ...upcomingSource.filter((e) => !onGrid.has(e.id))])
    return { coloredEvents: all.slice(0, events.length), coloredUpcoming: all }
  }, [events, upcomingSource])
  // The sidebar lists every calendar (coloured before any is hidden, so hiding one never recolours the rest).
  const sidebarState = useSidebarState()
  const sidebarAccounts = useMemo(() => (withSidebar ? listCalendars(coloredUpcoming ?? coloredEvents) : []), [withSidebar, coloredEvents, coloredUpcoming])
  const shownEvents = useMemo(
    () => (withSidebar ? withoutHiddenCalendars(coloredEvents, sidebarState.hidden) : coloredEvents),
    [withSidebar, coloredEvents, sidebarState.hidden],
  )
  const shownUpcoming = useMemo(
    () => (coloredUpcoming ? withoutHiddenCalendars(coloredUpcoming, sidebarState.hidden) : undefined),
    [coloredUpcoming, sidebarState.hidden],
  )

  // Open the integrations settings where Google/Microsoft calendars connect.
  // Prefer the in-app overlay (no navigation, keeps the dashboard mounted);
  // fall back to a hard route when rendered outside the overlay provider —
  // the same overlay-first pattern the workspace switcher uses.
  const openIntegrations = () => {
    if (settingsOverlay) settingsOverlay.openSettings('connectors')
    else router.push('/account/settings/connectors')
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <ThinkingOrb state="breathing" size={20} theme="auto" />
      </div>
    )
  }

  if (error === 'no-provider') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
        <CalendarX2 className="h-10 w-10 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium">No calendar connected</p>
          <p className="text-sm text-muted-foreground">
            Connect your Google or Microsoft calendar to see your events here.
          </p>
        </div>
        <Button size="sm" onClick={openIntegrations}>
          Connect a calendar
        </Button>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <CalendarProvider
        events={shownEvents}
        onSelectAction={onSelectAction}
        onSelectEvent={onSelectEvent}
        initialDate={card?.initialDate}
        onSelectedDateChange={card?.onDateChange}
      >
        <ClientContainer
          view={view}
          onViewChange={onViewChange}
          filterAccountIds={filterAccountIds}
          onFilterChange={onFilterChange}
          card={card ? { compact: card.compact, views: card.views } : undefined}
          sidebar={withSidebar ? { accounts: sidebarAccounts, upcoming: shownUpcoming, ...sidebarState } : undefined}
        />
      </CalendarProvider>
    </div>
  )
}
