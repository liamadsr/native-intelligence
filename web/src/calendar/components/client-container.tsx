"use client";

import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { isSameDay, parseISO } from "date-fns";

import { useCalendar } from "@/calendar/contexts/calendar-context";

import { CalendarHeader } from "@/calendar/components/header/calendar-header";
import { CalendarYearView } from "@/calendar/components/year-view/calendar-year-view";
import { CalendarMonthView } from "@/calendar/components/month-view/calendar-month-view";
import { CalendarAgendaView } from "@/calendar/components/agenda-view/calendar-agenda-view";
import { CalendarDayView } from "@/calendar/components/week-and-day-view/calendar-day-view";
import { CalendarWeekView } from "@/calendar/components/week-and-day-view/calendar-week-view";
import { AddEventPopover } from "@/calendar/components/dialogs/add-event-dialog";

import type { TCalendarView } from "@/calendar/types";

interface IProps {
  view: TCalendarView;
  onViewChange: (view: TCalendarView) => void;
  filterAccountIds?: string[] | null;
  onFilterChange?: (accountIds: string[] | null) => void;
  /** A chat card: no window title row, only the views it offers, slimmer inline. */
  card?: { compact: boolean; views: readonly TCalendarView[] };
}

/**
 * Below this width the week's seven columns don't fit (the week view itself
 * says "not available on smaller devices" under 640px). The same width the
 * header's own breakpoints are measured against: the calendar's, not the
 * window's, since it also lives in a chat card.
 */
const WEEK_MIN_WIDTH = 640;
const NARROW_UNAVAILABLE: readonly TCalendarView[] = ["week"];

/** The calendar's own width, measured before paint so a narrow one never flashes the week. */
function useWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function ClientContainer({ view: chosenView, onViewChange, filterAccountIds, onFilterChange, card }: IProps) {
  const { selectedDate, events } = useCalendar();

  // Too narrow for a week (a phone, a thin window): show the day instead
  // and drop Week from the switcher (Liam, 10-25). The person's choice is
  // left as it was, so widening the calendar brings the week back.
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useWidth(rootRef);
  // 0 = not laid out (hidden, or a test's jsdom): no reason to give up the week.
  const weekFits = !width || width >= WEEK_MIN_WIDTH;
  const view: TCalendarView = chosenView === "week" && !weekFits ? "day" : chosenView;

  const filteredEvents = useMemo(() => {
    return events.filter(event => {
      const eventStartDate = parseISO(event.startDate);
      const eventEndDate = parseISO(event.endDate);

      if (view === "year") {
        const yearStart = new Date(selectedDate.getFullYear(), 0, 1);
        const yearEnd = new Date(selectedDate.getFullYear(), 11, 31, 23, 59, 59, 999);
        return eventStartDate <= yearEnd && eventEndDate >= yearStart;
      }

      if (view === "month" || view === "agenda") {
        const monthStart = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
        const monthEnd = new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 0, 23, 59, 59, 999);
        return eventStartDate <= monthEnd && eventEndDate >= monthStart;
      }

      if (view === "week") {
        const dayOfWeek = selectedDate.getDay();
        const weekStart = new Date(selectedDate);
        weekStart.setDate(selectedDate.getDate() - dayOfWeek);
        weekStart.setHours(0, 0, 0, 0);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        weekEnd.setHours(23, 59, 59, 999);
        return eventStartDate <= weekEnd && eventEndDate >= weekStart;
      }

      if (view === "day") {
        const dayStart = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate(), 0, 0, 0);
        const dayEnd = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate(), 23, 59, 59);
        return eventStartDate <= dayEnd && eventEndDate >= dayStart;
      }
    });
  }, [selectedDate, events, view]);

  // Memoized (they used to be rebuilt inline every render): the views memoize
  // their expensive layout math on these arrays' identities, and the memoized
  // event components rely on them staying put when nothing changed.
  const { singleDayEvents, multiDayEvents } = useMemo(() => {
    const single: typeof filteredEvents = [];
    const multi: typeof filteredEvents = [];
    for (const event of filteredEvents) {
      const sameDay = !event.isAllDay && isSameDay(parseISO(event.startDate), parseISO(event.endDate));
      if (sameDay) single.push(event);
      else multi.push(event);
    }
    return { singleDayEvents: single, multiDayEvents: multi };
  }, [filteredEvents]);

  const eventStartDates = useMemo(() => {
    return filteredEvents.map(event => ({ ...event, endDate: event.startDate }));
  }, [filteredEvents]);

  return (
    <div ref={rootRef} className="flex h-full flex-col overflow-hidden">
      <CalendarHeader
        view={view}
        events={filteredEvents}
        onViewChange={onViewChange}
        filterAccountIds={filterAccountIds}
        onFilterChange={onFilterChange}
        card={card}
        unavailableViews={weekFits ? undefined : NARROW_UNAVAILABLE}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        {view === "day" && <CalendarDayView singleDayEvents={singleDayEvents} multiDayEvents={multiDayEvents} />}
        {view === "month" && <CalendarMonthView singleDayEvents={singleDayEvents} multiDayEvents={multiDayEvents} />}
        {view === "week" && <CalendarWeekView singleDayEvents={singleDayEvents} multiDayEvents={multiDayEvents} />}
        {view === "year" && <CalendarYearView allEvents={eventStartDates} />}
        {view === "agenda" && <CalendarAgendaView singleDayEvents={singleDayEvents} multiDayEvents={multiDayEvents} />}
      </div>

      <AddEventPopover />
    </div>
  );
}
