import {
  addDays,
  addMonths,
  addWeeks,
  subDays,
  subMonths,
  subWeeks,
  isSameWeek,
  isSameDay,
  isSameMonth,
  startOfWeek,
  startOfMonth,
  endOfMonth,
  endOfWeek,
  format,
  parseISO,
  differenceInMinutes,
  eachDayOfInterval,
  startOfDay,
  differenceInDays,
  endOfYear,
  startOfYear,
  subYears,
  addYears,
  isSameYear,
  isWithinInterval,
} from "date-fns";

import { layoutDayEvents, MIN_VISUAL_MINUTES } from "@/calendar/layout/overlap-layout";

import type { CSSProperties } from "react";
import type { ICalendarCell, IEvent } from "@/calendar/interfaces";
import type { TCalendarView, TVisibleHours, TWorkingHours } from "@/calendar/types";

// ================ Header helper functions ================ //

export function rangeText(view: TCalendarView, date: Date) {
  const formatString = "MMM d, yyyy";
  let start: Date;
  let end: Date;

  switch (view) {
    case "agenda":
      start = startOfMonth(date);
      end = endOfMonth(date);
      break;
    case "year":
      start = startOfYear(date);
      end = endOfYear(date);
      break;
    case "month":
      start = startOfMonth(date);
      end = endOfMonth(date);
      break;
    case "week":
      start = startOfWeek(date);
      end = endOfWeek(date);
      break;
    case "day":
      return format(date, formatString);
    default:
      return "Error while formatting ";
  }

  return `${format(start, formatString)} - ${format(end, formatString)}`;
}

export function navigateDate(date: Date, view: TCalendarView, direction: "previous" | "next"): Date {
  const operations = {
    agenda: direction === "next" ? addMonths : subMonths,
    year: direction === "next" ? addYears : subYears,
    month: direction === "next" ? addMonths : subMonths,
    week: direction === "next" ? addWeeks : subWeeks,
    day: direction === "next" ? addDays : subDays,
  };

  return operations[view](date, 1);
}

export function getEventsCount(events: IEvent[], date: Date, view: TCalendarView): number {
  const compareFns = {
    agenda: isSameMonth,
    year: isSameYear,
    day: isSameDay,
    week: isSameWeek,
    month: isSameMonth,
  };

  return events.filter(event => compareFns[view](new Date(event.startDate), date)).length;
}

// ================ Week and day view helper functions ================ //

export function getCurrentEvents(events: IEvent[]) {
  const now = new Date();
  return events.filter(event => isWithinInterval(now, { start: parseISO(event.startDate), end: parseISO(event.endDate) })) || null;
}

/** The grid's hour height. The drag and resize layers measure against the same number. */
export const HOUR_HEIGHT_PX = 96;
/** The share of a day column events draw in: the rest stays free on the right, to click an empty slot behind a full one. */
const EVENT_AREA = 0.96;

export interface PositionedEvent {
  event: IEvent;
  style: CSSProperties;
}

/**
 * One day column's timed events, placed: top and height from their times, left
 * and width from the overlap layout (@/calendar/layout/overlap-layout), so a
 * later event is drawn offset on top of an earlier one instead of the column
 * being cut into equal slivers. They come back in paint order (the layout's
 * `order`: later start on top); the wrapper raises itself on hover.
 */
export function positionDayEvents(dayEvents: IEvent[], day: Date, visibleHoursRange: { from: number; to: number }): PositionedEvent[] {
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);

  const timed = dayEvents.map(event => {
    const start = Math.max(0, differenceInMinutes(parseISO(event.startDate), dayStart));
    const end = Math.min(1440, Math.max(start, differenceInMinutes(parseISO(event.endDate), dayStart)));
    return { event, start, end };
  });

  const boxes = layoutDayEvents(timed.map(({ event, start, end }) => ({ id: event.id, start, end })));
  const visibleStart = visibleHoursRange.from * 60;
  const visibleRange = Math.max(1, visibleHoursRange.to * 60 - visibleStart);

  // In paint order (later start last; same start, the shorter last), so where two share a layer the
  // one the layout means to be on top also comes later in the document.
  const painted = [...timed].sort((a, b) => (boxes.get(a.event.id)?.order ?? 0) - (boxes.get(b.event.id)?.order ?? 0));

  return painted.map(({ event, start, end }) => {
    const box = boxes.get(event.id) ?? { left: 0, width: 1 };
    const style = {
      top: `${((start - visibleStart) / visibleRange) * 100}%`,
      height: `${(Math.max(end - start, MIN_VISUAL_MINUTES) / 60) * HOUR_HEIGHT_PX}px`,
      left: `${box.left * EVENT_AREA * 100}%`,
      width: `${box.width * EVENT_AREA * 100}%`,
      // One layer for all of them: the document order above IS the paint order (later start on top),
      // which a per-group layer could contradict where groups interleave.
      "--event-z": 1,
    } as CSSProperties;
    return { event, style };
  });
}

/** "9am", "9:30am": the grid's compact clock. */
export function compactTime(date: Date): string {
  return format(date, date.getMinutes() === 0 ? "haaa" : "h:mmaaa");
}

/** "10 – 11:30am", "11:30am – 1pm": am/pm said once when both ends share it. */
export function compactTimeRange(start: Date, end: Date): string {
  const sameHalf = start.getHours() < 12 === end.getHours() < 12;
  const from = sameHalf ? format(start, start.getMinutes() === 0 ? "h" : "h:mm") : compactTime(start);
  return `${from} – ${compactTime(end)}`;
}

export function isWorkingHour(day: Date, hour: number, workingHours: TWorkingHours) {
  const dayIndex = day.getDay() as keyof typeof workingHours;
  const dayHours = workingHours[dayIndex];
  return hour >= dayHours.from && hour < dayHours.to;
}

export function getVisibleHours(visibleHours: TVisibleHours, singleDayEvents: IEvent[]) {
  let earliestEventHour = visibleHours.from;
  let latestEventHour = visibleHours.to;

  singleDayEvents.forEach(event => {
    const startHour = parseISO(event.startDate).getHours();
    const endTime = parseISO(event.endDate);
    const endHour = endTime.getHours() + (endTime.getMinutes() > 0 ? 1 : 0);
    if (startHour < earliestEventHour) earliestEventHour = startHour;
    if (endHour > latestEventHour) latestEventHour = endHour;
  });

  latestEventHour = Math.min(latestEventHour, 24);

  const hours = Array.from({ length: latestEventHour - earliestEventHour }, (_, i) => i + earliestEventHour);

  return { hours, earliestEventHour, latestEventHour };
}

// ================ Month view helper functions ================ //

export function getCalendarCells(selectedDate: Date): ICalendarCell[] {
  const currentYear = selectedDate.getFullYear();
  const currentMonth = selectedDate.getMonth();

  const getDaysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate();
  const getFirstDayOfMonth = (year: number, month: number) => new Date(year, month, 1).getDay();

  const daysInMonth = getDaysInMonth(currentYear, currentMonth);
  const firstDayOfMonth = getFirstDayOfMonth(currentYear, currentMonth);
  const daysInPrevMonth = getDaysInMonth(currentYear, currentMonth - 1);
  const totalDays = firstDayOfMonth + daysInMonth;

  const prevMonthCells = Array.from({ length: firstDayOfMonth }, (_, i) => ({
    day: daysInPrevMonth - firstDayOfMonth + i + 1,
    currentMonth: false,
    date: new Date(currentYear, currentMonth - 1, daysInPrevMonth - firstDayOfMonth + i + 1),
  }));

  const currentMonthCells = Array.from({ length: daysInMonth }, (_, i) => ({
    day: i + 1,
    currentMonth: true,
    date: new Date(currentYear, currentMonth, i + 1),
  }));

  const nextMonthCells = Array.from({ length: (7 - (totalDays % 7)) % 7 }, (_, i) => ({
    day: i + 1,
    currentMonth: false,
    date: new Date(currentYear, currentMonth + 1, i + 1),
  }));

  return [...prevMonthCells, ...currentMonthCells, ...nextMonthCells];
}

export function calculateMonthEventPositions(multiDayEvents: IEvent[], singleDayEvents: IEvent[], selectedDate: Date) {
  const monthStart = startOfMonth(selectedDate);
  const monthEnd = endOfMonth(selectedDate);

  const eventPositions: { [key: string]: number } = {};
  const occupiedPositions: { [key: string]: boolean[] } = {};

  eachDayOfInterval({ start: monthStart, end: monthEnd }).forEach(day => {
    occupiedPositions[day.toISOString()] = [false, false, false];
  });

  const sortedEvents = [
    ...multiDayEvents.sort((a, b) => {
      const aDuration = differenceInDays(parseISO(a.endDate), parseISO(a.startDate));
      const bDuration = differenceInDays(parseISO(b.endDate), parseISO(b.startDate));
      return bDuration - aDuration || parseISO(a.startDate).getTime() - parseISO(b.startDate).getTime();
    }),
    ...singleDayEvents.sort((a, b) => parseISO(a.startDate).getTime() - parseISO(b.startDate).getTime()),
  ];

  sortedEvents.forEach(event => {
    const eventStart = parseISO(event.startDate);
    const eventEnd = parseISO(event.endDate);
    const eventDays = eachDayOfInterval({
      start: eventStart < monthStart ? monthStart : eventStart,
      end: eventEnd > monthEnd ? monthEnd : eventEnd,
    });

    let position = -1;

    for (let i = 0; i < 3; i++) {
      if (
        eventDays.every(day => {
          const dayPositions = occupiedPositions[startOfDay(day).toISOString()];
          return dayPositions && !dayPositions[i];
        })
      ) {
        position = i;
        break;
      }
    }

    if (position !== -1) {
      eventDays.forEach(day => {
        const dayKey = startOfDay(day).toISOString();
        occupiedPositions[dayKey][position] = true;
      });
      eventPositions[event.id] = position;
    }
  });

  return eventPositions;
}

// ================ Day-bucketed event index ================ //

/**
 * An events-by-day index: `dayKey` → the events touching that day.
 *
 * The grid views used to answer "what's on this day?" by filtering the WHOLE
 * event array per cell, re-`parseISO`-ing both dates of every event every time.
 * That's O(cells x events) string parses per render — ~150k of them for a year
 * view over a 200-event window, which is what made navigation feel sluggish.
 *
 * Building this index parses each event exactly once and walks only the days it
 * actually spans, so a cell lookup becomes O(1) and the whole render becomes
 * O(events + cells). Build it in a `useMemo` keyed on the event array and hand
 * it to the cells.
 */
export type EventsByDay = Map<string, IEvent[]>;

/** Stable per-day key (local time). `toISOString()` would shift across UTC. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function buildEventsByDay(events: IEvent[]): EventsByDay {
  const byDay: EventsByDay = new Map();

  for (const event of events) {
    const start = parseISO(event.startDate);
    const end = parseISO(event.endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;

    // Walk day-by-day from start to end so multi-day events land in every day
    // they cover — matching the old predicate's `start <= date <= end`.
    const cursor = startOfDay(start);
    const last = startOfDay(end);

    // Inverted range (end before start) — corrupt provider data, but the old
    // per-cell predicates still surfaced such an event on BOTH its start and
    // end day via their isSameDay checks. Index those two days so a bad row
    // renders exactly as it did before instead of quietly disappearing.
    if (last < cursor) {
      for (const key of new Set([dayKey(cursor), dayKey(last)])) {
        const bucket = byDay.get(key);
        if (bucket) bucket.push(event);
        else byDay.set(key, [event]);
      }
      continue;
    }

    while (cursor <= last) {
      const key = dayKey(cursor);
      const bucket = byDay.get(key);
      if (bucket) bucket.push(event);
      else byDay.set(key, [event]);
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  return byDay;
}

/** O(1) lookup into the index. Returns a shared empty array for empty days. */
const NO_EVENTS: IEvent[] = [];
export function getEventsForDay(byDay: EventsByDay, date: Date): IEvent[] {
  return byDay.get(dayKey(date)) ?? NO_EVENTS;
}

/**
 * Month-cell events, resolved through the day index (O(1)) instead of a
 * per-cell scan of the full event list. Same shape and ordering as the old
 * `getMonthCellEvents`, which this replaces at every call site.
 */
export function getMonthCellEventsIndexed(date: Date, byDay: EventsByDay, eventPositions: Record<string, number>) {
  const eventsForDate = getEventsForDay(byDay, date);
  if (eventsForDate.length === 0) return [];

  return eventsForDate
    .map(event => ({
      ...event,
      position: eventPositions[event.id] ?? -1,
      isMultiDay: event.startDate !== event.endDate,
    }))
    .sort((a, b) => {
      if (a.isMultiDay && !b.isMultiDay) return -1;
      if (!a.isMultiDay && b.isMultiDay) return 1;
      return a.position - b.position;
    });
}
