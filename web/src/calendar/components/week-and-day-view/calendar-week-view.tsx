import { useEffect, useMemo, useRef } from "react";
import { startOfWeek, addDays, format, parseISO, isSameDay, isToday } from "date-fns";

import { useCalendar } from "@/calendar/contexts/calendar-context";

import { ScrollArea } from "@/components/ui/scroll-area";

import { EventBlock } from "@/calendar/components/week-and-day-view/event-block";
import { HourSlots } from "@/calendar/components/week-and-day-view/hour-slots";
import { CalendarTimeline } from "@/calendar/components/week-and-day-view/calendar-time-line";
import { WeekViewMultiDayEventsRow } from "@/calendar/components/week-and-day-view/week-view-multi-day-events-row";
import { TimeGridDragLayer } from "@/calendar/components/week-and-day-view/time-grid-drag-layer";
import { EventInteractionLayer } from "@/calendar/components/week-and-day-view/event-interaction-layer";

import { cn } from "@/lib/utils";
import { positionDayEvents, getVisibleHours, compactTime } from "@/calendar/helpers";

import type { IEvent } from "@/calendar/interfaces";

interface IProps {
  singleDayEvents: IEvent[];
  multiDayEvents: IEvent[];
}

/**
 * The slot an event block is drawn in: a hair of space around it, in its
 * layer's paint order, and raised to the top while the pointer or the keyboard
 * is on it, so a block that is partly covered can be read in full.
 */
export const EVENT_SLOT_CLASS = "absolute z-[var(--event-z)] px-px pb-0.5 hover:z-[9] focus-within:z-[9]";

/** A day's heading: the weekday over its date, today's date in a filled circle. */
export function DayHeading({ day }: { day: Date }) {
  const today = isToday(day);
  return (
    <div className="flex flex-col items-center gap-0.5 py-1.5">
      <span className={cn("text-[11px] font-medium uppercase tracking-wide", today ? "text-foreground" : "text-muted-foreground")}>{format(day, "EEE")}</span>
      <span
        className={cn(
          "flex size-7 items-center justify-center rounded-full text-sm tabular-nums",
          today ? "bg-foreground font-semibold text-background" : "text-foreground"
        )}
      >
        {format(day, "d")}
      </span>
    </div>
  );
}

export function CalendarWeekView({ singleDayEvents, multiDayEvents }: IProps) {
  const { selectedDate, visibleHours } = useCalendar();

  const gridRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Scroll to the current-time indicator on mount
  useEffect(() => {
    const root = scrollAreaRef.current;
    if (!root) return;
    const viewport = root.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null;
    const timeline = root.querySelector('[data-calendar-timeline]') as HTMLElement | null;
    if (!viewport || !timeline) return;
    const viewportRect = viewport.getBoundingClientRect();
    const timelineRect = timeline.getBoundingClientRect();
    const offsetFromViewportTop = timelineRect.top - viewportRect.top + viewport.scrollTop;
    viewport.scrollTop = offsetFromViewportTop - viewport.clientHeight / 2;
  }, []);

  // Seven columns, each laid out (overlap-layout): once per (events, week), not
  // on every render.
  const { hours, earliestEventHour, latestEventHour, weekDays, dayColumns } = useMemo(() => {
    const visible = getVisibleHours(visibleHours, singleDayEvents);

    const weekStart = startOfWeek(selectedDate);
    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

    const columns = days.map(day => {
      const dayEvents = singleDayEvents.filter(event => isSameDay(parseISO(event.startDate), day) || isSameDay(parseISO(event.endDate), day));
      return { day, positionedEvents: positionDayEvents(dayEvents, day, { from: visible.earliestEventHour, to: visible.latestEventHour }) };
    });

    return { ...visible, weekDays: days, dayColumns: columns };
  }, [singleDayEvents, selectedDate, visibleHours]);

  return (
    <>
      <div className="flex flex-col items-center justify-center border-b py-4 text-sm text-muted-foreground sm:hidden">
        <p>Weekly view is not available on smaller devices.</p>
        <p>Please switch to daily or monthly view.</p>
      </div>

      <div className="hidden min-h-0 flex-1 flex-col sm:flex">
        <div>
          <div className="relative z-20 flex border-b border-border/60">
            <div className="w-18"></div>
            <div className="grid flex-1 grid-cols-7">
              {weekDays.map((day, index) => (
                <DayHeading key={index} day={day} />
              ))}
            </div>
          </div>

          <WeekViewMultiDayEventsRow selectedDate={selectedDate} multiDayEvents={multiDayEvents} />
        </div>

        <ScrollArea ref={scrollAreaRef} className="flex-1" type="always">
          {/* will-change-transform: own compositor layer → cached tiles while
              scrolling (see calendar-day-view note). */}
          <div className="flex overflow-hidden will-change-transform">
            <div className="relative w-18">
              {hours.map((hour, index) => (
                <div key={hour} className="relative" style={{ height: "96px" }}>
                  <div className="absolute -top-3 right-2 flex h-6 items-center">
                    {index !== 0 && <span className="text-[11px] tabular-nums text-muted-foreground/80">{compactTime(new Date(new Date().setHours(hour, 0, 0, 0)))}</span>}
                  </div>
                </div>
              ))}
            </div>

            <div className="relative flex-1 border-l border-border/60">
              <div ref={gridRef} className="grid grid-cols-7 divide-x divide-border/60">
                {dayColumns.map(({ day, positionedEvents }, dayIndex) => (
                  <div key={dayIndex} data-day-column className="relative">
                    {hours.map((hour, index) => {
                      // Every hour the same square, working hours or not (Liam, 11-23: "why are some of the squares in the calendar darker than others? can you make them all match").
                      return (
                        <div key={hour} className="relative" style={{ height: "96px" }}>
                          {index !== 0 && <div className="pointer-events-none absolute inset-x-0 top-0 border-b border-border/60"></div>}

                          <HourSlots day={day} hour={hour} />
                        </div>
                      );
                    })}

                    {positionedEvents.map(({ event, style }) => (
                      <div key={`${event.id}-${event.startDate}-${event.endDate}`} className={EVENT_SLOT_CLASS} style={style}>
                        <EventBlock event={event} />
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              <CalendarTimeline firstVisibleHour={earliestEventHour} lastVisibleHour={latestEventHour} columnCount={7} days={weekDays} />

              <TimeGridDragLayer
                days={weekDays}
                firstHour={earliestEventHour}
                hoursCount={latestEventHour - earliestEventHour}
                gridRef={gridRef}
                gridColsClass="grid-cols-7"
              />

              <EventInteractionLayer
                days={weekDays}
                firstHour={earliestEventHour}
                hoursCount={latestEventHour - earliestEventHour}
                gridRef={gridRef}
                gridColsClass="grid-cols-7"
              />
            </div>
          </div>
        </ScrollArea>
      </div>
    </>
  );
}
