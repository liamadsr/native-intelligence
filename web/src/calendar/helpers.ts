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

export function groupEvents(dayEvents: IEvent[]) {
  const sortedEvents = dayEvents.sort((a, b) => parseISO(a.startDate).getTime() - parseISO(b.startDate).getTime());
  const groups: IEvent[][] = [];

  for (const event of sortedEvents) {
    const eventStart = parseISO(event.startDate);

    let placed = false;
    for (const group of groups) {
      const lastEventInGroup = group[group.length - 1];
      const lastEventEnd = parseISO(lastEventInGroup.endDate);

      if (eventStart >= lastEventEnd) {
        group.push(event);
        placed = true;
        break;
      }
    }

    if (!placed) groups.push([event]);
  }

  return groups;
}

export function getEventBlockStyle(event: IEvent, day: Date, groupIndex: number, groupSize: number, visibleHoursRange?: { from: number; to: number }) {
  const startDate = parseISO(event.startDate);
  const endDate = parseISO(event.endDate);
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const eventStart = startDate < dayStart ? dayStart : startDate;
  const startMinutes = differenceInMinutes(eventStart, dayStart);
  const durationMinutes = differenceInMinutes(endDate, eventStart);

  let top;

  if (visibleHoursRange) {
    const visibleStartMinutes = visibleHoursRange.from * 60;
    const visibleEndMinutes = visibleHoursRange.to * 60;
    const visibleRangeMinutes = visibleEndMinutes - visibleStartMinutes;
    top = ((startMinutes - visibleStartMinutes) / visibleRangeMinutes) * 100;
  } else {
    top = (startMinutes / 1440) * 100;
  }

  const width = 100 / groupSize;
  const left = groupIndex * width;
  const height = (durationMinutes / 60) * 96;

  return { top: `${top}%`, width: `${width}%`, left: `${left}%`, height: `${height}px` };
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
