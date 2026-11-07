import { memo, useMemo } from "react";
import { isToday, startOfDay } from "date-fns";

import { useCalendarMutators } from "@/calendar/contexts/calendar-context";

import { EventBullet } from "@/calendar/components/month-view/event-bullet";
import { MonthEventBadge } from "@/calendar/components/month-view/month-event-badge";

import { cn } from "@/lib/utils";
import { getMonthCellEventsIndexed, type EventsByDay } from "@/calendar/helpers";

import type { ICalendarCell } from "@/calendar/interfaces";

interface IProps {
  cell: ICalendarCell;
  /** Day-bucketed index built once per month by the parent — O(1) per cell. */
  eventsByDay: EventsByDay;
  eventPositions: Record<string, number>;
  onDayClick?: (date: Date) => void;
}

const MAX_VISIBLE_EVENTS = 3;

// Memoized: 42 instances per month grid. Each one resolves its events through
// the shared day index rather than re-scanning (and re-parsing) the full event
// list, so a parent re-render with unchanged props costs nothing here.
export const DayCell = memo(function DayCell({ cell, eventsByDay, eventPositions, onDayClick }: IProps) {
  const { setSelectedDate } = useCalendarMutators();

  const { day, currentMonth, date } = cell;

  const cellEvents = useMemo(
    () => getMonthCellEventsIndexed(date, eventsByDay, eventPositions),
    [date, eventsByDay, eventPositions],
  );
  const isSunday = date.getDay() === 0;

  const handleClick = () => {
    setSelectedDate(date);
    onDayClick?.(date);
  };

  return (
    <div>
      <div className={cn("flex h-full flex-col gap-1 border-l border-t py-1.5 lg:pb-2 lg:pt-1", isSunday && "border-l-0")}>
        <button
          onClick={handleClick}
          className={cn(
            "flex size-6 translate-x-1 items-center justify-center rounded-full text-xs font-semibold hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring lg:px-2",
            !currentMonth && "opacity-20",
            isToday(date) && "bg-primary font-bold text-primary-foreground hover:bg-primary"
          )}
        >
          {day}
        </button>

        <div className={cn("flex h-6 gap-1 px-2 lg:h-[94px] lg:flex-col lg:gap-2 lg:px-0", !currentMonth && "opacity-50")}>
          {[0, 1, 2].map(position => {
            const event = cellEvents.find(e => e.position === position);
            const eventKey = event ? `event-${event.id}-${position}` : `empty-${position}`;

            return (
              <div key={eventKey} className="min-w-0 lg:flex-1">
                {event && (
                  <>
                    <EventBullet className="lg:hidden" color={event.color} />
                    <MonthEventBadge className="hidden lg:flex" event={event} cellDate={startOfDay(date)} />
                  </>
                )}
              </div>
            );
          })}
        </div>

        {cellEvents.length > MAX_VISIBLE_EVENTS && (
          <p className={cn("h-4.5 px-1.5 text-xs font-semibold text-muted-foreground", !currentMonth && "opacity-50")}>
            <span className="sm:hidden">+{cellEvents.length - MAX_VISIBLE_EVENTS}</span>
            <span className="hidden sm:inline"> {cellEvents.length - MAX_VISIBLE_EVENTS} more...</span>
          </p>
        )}
      </div>
    </div>
  );
});
