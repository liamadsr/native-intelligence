import { useEffect, useMemo, useRef } from "react";
import { startOfWeek, addDays, format, parseISO, isSameDay, areIntervalsOverlapping } from "date-fns";

import { useCalendar } from "@/calendar/contexts/calendar-context";

import { ScrollArea } from "@/components/ui/scroll-area";

import { EventBlock } from "@/calendar/components/week-and-day-view/event-block";
import { HourSlots } from "@/calendar/components/week-and-day-view/hour-slots";
import { CalendarTimeline } from "@/calendar/components/week-and-day-view/calendar-time-line";
import { WeekViewMultiDayEventsRow } from "@/calendar/components/week-and-day-view/week-view-multi-day-events-row";
import { TimeGridDragLayer } from "@/calendar/components/week-and-day-view/time-grid-drag-layer";
import { EventInteractionLayer } from "@/calendar/components/week-and-day-view/event-interaction-layer";

import { cn } from "@/lib/utils";
import { groupEvents, getEventBlockStyle, isWorkingHour, getVisibleHours } from "@/calendar/helpers";

import type { IEvent } from "@/calendar/interfaces";

interface IProps {
  singleDayEvents: IEvent[];
  multiDayEvents: IEvent[];
}

export function CalendarWeekView({ singleDayEvents, multiDayEvents }: IProps) {
  const { selectedDate, workingHours, visibleHours } = useCalendar();

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

  // 7 columns × per-day grouping + O(n²) overlap checks with date parsing —
  // compute once per (events, week) instead of on every render.
  const { hours, earliestEventHour, latestEventHour, weekDays, dayColumns } = useMemo(() => {
    const visible = getVisibleHours(visibleHours, singleDayEvents);

    const weekStart = startOfWeek(selectedDate);
    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

    const columns = days.map(day => {
      const dayEvents = singleDayEvents.filter(event => isSameDay(parseISO(event.startDate), day) || isSameDay(parseISO(event.endDate), day));
      const groupedEvents = groupEvents(dayEvents);

      // Parse each event's bounds once per column (see calendar-day-view note):
      // the overlap scan is O(n²) and was re-parsing both ISO strings per pair.
      const bounds = new Map(dayEvents.map(e => [e.id, { start: parseISO(e.startDate), end: parseISO(e.endDate) }]));

      const positionedEvents = groupedEvents.flatMap((group, groupIndex) =>
        group.map(event => {
          let style = getEventBlockStyle(event, day, groupIndex, groupedEvents.length, { from: visible.earliestEventHour, to: visible.latestEventHour });
          const eventBounds = bounds.get(event.id)!;
          const hasOverlap = groupedEvents.some(
            (otherGroup, otherIndex) =>
              otherIndex !== groupIndex &&
              otherGroup.some(otherEvent => areIntervalsOverlapping(eventBounds, bounds.get(otherEvent.id)!))
          );

          if (!hasOverlap) style = { ...style, width: "100%", left: "0%" };

          return { event, style };
        })
      );

      return { day, positionedEvents };
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
          <WeekViewMultiDayEventsRow selectedDate={selectedDate} multiDayEvents={multiDayEvents} />

          <div className="relative z-20 flex border-b">
            <div className="w-18"></div>
            <div className="grid flex-1 grid-cols-7 divide-x border-l">
              {weekDays.map((day, index) => (
                <span key={index} className="py-2 text-center text-xs font-medium text-muted-foreground">
                  {format(day, "EE")} <span className="ml-1 font-semibold text-foreground">{format(day, "d")}</span>
                </span>
              ))}
            </div>
          </div>
        </div>

        <ScrollArea ref={scrollAreaRef} className="flex-1" type="always">
          {/* will-change-transform: own compositor layer → cached tiles while
              scrolling (see calendar-day-view note). */}
          <div className="flex overflow-hidden will-change-transform">
            <div className="relative w-18">
              {hours.map((hour, index) => (
                <div key={hour} className="relative" style={{ height: "96px" }}>
                  <div className="absolute -top-3 right-2 flex h-6 items-center">
                    {index !== 0 && <span className="text-xs text-muted-foreground">{format(new Date().setHours(hour, 0, 0, 0), "hh a")}</span>}
                  </div>
                </div>
              ))}
            </div>

            <div className="relative flex-1 border-l">
              <div ref={gridRef} className="grid grid-cols-7 divide-x">
                {dayColumns.map(({ day, positionedEvents }, dayIndex) => (
                  <div key={dayIndex} data-day-column className="relative">
                    {hours.map((hour, index) => {
                      const isDisabled = !isWorkingHour(day, hour, workingHours);

                      return (
                        <div key={hour} className={cn("relative", isDisabled && "bg-muted/30")} style={{ height: "96px" }}>
                          {index !== 0 && <div className="pointer-events-none absolute inset-x-0 top-0 border-b"></div>}

                          <HourSlots day={day} hour={hour} />
                        </div>
                      );
                    })}

                    {positionedEvents.map(({ event, style }) => (
                      <div key={`${event.id}-${event.startDate}-${event.endDate}`} className="absolute p-1" style={style}>
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
