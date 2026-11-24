import { useEffect, useMemo, useRef } from "react";
import { Calendar, Clock } from "lucide-react";
import { parseISO, format } from "date-fns";

import { useCalendar } from "@/calendar/contexts/calendar-context";

import { ScrollArea } from "@/components/ui/scroll-area";

import { EventBlock } from "@/calendar/components/week-and-day-view/event-block";
import { HourSlots } from "@/calendar/components/week-and-day-view/hour-slots";
import { CalendarTimeline } from "@/calendar/components/week-and-day-view/calendar-time-line";
import { DayViewMultiDayEventsRow } from "@/calendar/components/week-and-day-view/day-view-multi-day-events-row";
import { TimeGridDragLayer } from "@/calendar/components/week-and-day-view/time-grid-drag-layer";
import { EventInteractionLayer } from "@/calendar/components/week-and-day-view/event-interaction-layer";

import { positionDayEvents, getCurrentEvents, getVisibleHours, compactTime } from "@/calendar/helpers";
import { DayHeading, EVENT_SLOT_CLASS } from "@/calendar/components/week-and-day-view/calendar-week-view";

import type { IEvent } from "@/calendar/interfaces";

interface IProps {
  singleDayEvents: IEvent[];
  multiDayEvents: IEvent[];
}

export function CalendarDayView({ singleDayEvents, multiDayEvents }: IProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const { selectedDate, visibleHours } = useCalendar();

  // The day's layout (overlap-layout): once per (events, day), not on every render.
  const { hours, earliestEventHour, latestEventHour, positionedEvents } = useMemo(() => {
    const visible = getVisibleHours(visibleHours, singleDayEvents);

    const dayEvents = singleDayEvents.filter(event => {
      const eventDate = parseISO(event.startDate);
      return (
        eventDate.getDate() === selectedDate.getDate() &&
        eventDate.getMonth() === selectedDate.getMonth() &&
        eventDate.getFullYear() === selectedDate.getFullYear()
      );
    });

    const positioned = positionDayEvents(dayEvents, selectedDate, { from: visible.earliestEventHour, to: visible.latestEventHour });

    return { ...visible, positionedEvents: positioned };
  }, [singleDayEvents, selectedDate, visibleHours]);

  const currentEvents = getCurrentEvents(singleDayEvents);

  // Stable single-day array: passed to the drag/interaction layers, whose
  // handlers would otherwise be rebuilt (and their document listeners
  // re-attached) on every render because of a fresh `[selectedDate]` literal.
  const days = useMemo(() => [selectedDate], [selectedDate]);

  // Scroll to the current-time indicator on mount
  useEffect(() => {
    const root = scrollAreaRef.current;
    if (!root) return;
    const viewport = root.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null;
    const timeline = root.querySelector('[data-calendar-timeline]') as HTMLElement | null;
    if (!viewport || !timeline) return;
    // getBoundingClientRect accounts for absolute positioning within the grid
    const viewportRect = viewport.getBoundingClientRect();
    const timelineRect = timeline.getBoundingClientRect();
    const offsetFromViewportTop = timelineRect.top - viewportRect.top + viewport.scrollTop;
    viewport.scrollTop = offsetFromViewportTop - viewport.clientHeight / 2;
  }, []);

  return (
    // min-w-0 all the way down: each of these is a flex child, and the default
    // min-width:auto lets a long event title expand the column past the
    // calendar's own width instead of truncating inside it.
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="min-w-0">
          <div className="relative z-20 flex border-b border-border/60">
            <div className="w-18"></div>
            <div className="flex-1">
              <DayHeading day={selectedDate} />
            </div>
          </div>

          <DayViewMultiDayEventsRow selectedDate={selectedDate} multiDayEvents={multiDayEvents} />
        </div>

        <ScrollArea ref={scrollAreaRef} className="flex-1" type="always">
          {/* will-change-transform: keep the tall bordered grid on its own
              compositor layer so scrolling moves cached tiles instead of
              re-rasterizing hairline/dashed borders every frame. Safe under the
              content panel's glass — its backdrop-blur is a sibling layer, not
              an ancestor. */}
          <div className="flex will-change-transform">
            <div className="relative w-18">
              {hours.map((hour, index) => (
                <div key={hour} className="relative" style={{ height: "96px" }}>
                  <div className="absolute -top-3 right-2 flex h-6 items-center">
                    {index !== 0 && <span className="text-[11px] tabular-nums text-muted-foreground/80">{compactTime(new Date(new Date().setHours(hour, 0, 0, 0)))}</span>}
                  </div>
                </div>
              ))}
            </div>

            <div ref={gridRef} className="relative flex-1 border-l border-border/60">
              <div data-day-column className="relative">
                {hours.map((hour, index) => {
                  // Every hour the same square, working hours or not (Liam, 11-23: "why are some of the squares in the calendar darker than others? can you make them all match").
                  return (
                    <div key={hour} className="relative" style={{ height: "96px" }}>
                      {index !== 0 && <div className="pointer-events-none absolute inset-x-0 top-0 border-b border-border/60"></div>}

                      <HourSlots day={selectedDate} hour={hour} />
                    </div>
                  );
                })}

                {positionedEvents.map(({ event, style }) => (
                  <div key={`${event.id}-${event.startDate}-${event.endDate}`} className={EVENT_SLOT_CLASS} style={style}>
                    <EventBlock event={event} />
                  </div>
                ))}
              </div>

              <CalendarTimeline firstVisibleHour={earliestEventHour} lastVisibleHour={latestEventHour} days={days} />

              <TimeGridDragLayer
                days={days}
                firstHour={earliestEventHour}
                hoursCount={latestEventHour - earliestEventHour}
                gridRef={gridRef}
                gridColsClass="grid-cols-1"
              />

              <EventInteractionLayer
                days={days}
                firstHour={earliestEventHour}
                hoursCount={latestEventHour - earliestEventHour}
                gridRef={gridRef}
                gridColsClass="grid-cols-1"
              />
            </div>
          </div>
        </ScrollArea>
      </div>

      <div className="hidden w-64 divide-y border-l md:block">
        <div className="flex-1 space-y-3">
          {currentEvents.length > 0 ? (
            <div className="flex items-start gap-2 px-4 pt-4">
              <span className="relative mt-[5px] flex size-2.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex size-2.5 rounded-full bg-green-600"></span>
              </span>
              <p className="text-sm font-semibold text-foreground">Happening now</p>
            </div>
          ) : (
            <p className="p-4 text-center text-sm italic text-muted-foreground">No events at the moment</p>
          )}

          {currentEvents.length > 0 && (
            <ScrollArea className="h-[422px] px-4" type="always">
              <div className="space-y-6 pb-4">
                {currentEvents.map(event => (
                  <div key={event.id} className="space-y-1.5">
                    <p className="line-clamp-2 text-sm font-semibold">{event.title}</p>
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Calendar className="size-3.5" />
                      <span className="text-sm">{format(new Date(), "MMM d, yyyy")}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Clock className="size-3.5" />
                      <span className="text-sm">
                        {format(parseISO(event.startDate), "h:mm a")} - {format(parseISO(event.endDate), "h:mm a")}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      </div>
    </div>
  );
}
