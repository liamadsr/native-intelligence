import { memo } from "react";
import { cva } from "class-variance-authority";
import { endOfDay, format, isSameDay, parseISO, startOfDay } from "date-fns";

import { useCalendarSettings } from "@/calendar/contexts/calendar-context";

import { EventDetailsDialog } from "@/calendar/components/dialogs/event-details-dialog";

import { CaptureStatusIndicator } from "@/calendar/components/capture-status-indicator";
import { cn } from "@/lib/utils";
import { eventToneClass } from "@/calendar/event-colors";
import { compactTime } from "@/calendar/helpers";

import type { IEvent } from "@/calendar/interfaces";

const eventBadgeVariants = cva(
  "mx-1 flex size-auto h-5.5 select-none items-center justify-between gap-1.5 truncate whitespace-nowrap rounded-md px-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
  {
    variants: {
      multiDayPosition: {
        first: "relative z-10 mr-0 w-[calc(100%_-_3px)] rounded-r-none [&>span]:mr-2.5",
        middle: "relative z-10 mx-0 w-[calc(100%_+_1px)] rounded-none",
        last: "ml-0 rounded-l-none",
        none: "",
      },
    },
  }
);

interface IProps {
  event: IEvent;
  cellDate: Date;
  eventCurrentDay?: number;
  eventTotalDays?: number;
  className?: string;
  position?: "first" | "middle" | "last" | "none";
  /** The slim all-day row above the week and day grids: the title alone, no "All day". */
  slim?: boolean;
}

// Memoized: up to 3 per DayCell across a 42-cell month grid — skips when the
// event object is unchanged.
export const MonthEventBadge = memo(function MonthEventBadge({ event, cellDate, eventCurrentDay, eventTotalDays, className, position: propPosition, slim = false }: IProps) {
  const { badgeVariant } = useCalendarSettings();

  const itemStart = startOfDay(parseISO(event.startDate));
  const itemEnd = endOfDay(parseISO(event.endDate));

  if (cellDate < itemStart || cellDate > itemEnd) return null;

  let position: "first" | "middle" | "last" | "none" | undefined;

  if (propPosition) {
    position = propPosition;
  } else if (eventCurrentDay && eventTotalDays) {
    position = "none";
  } else if (isSameDay(itemStart, itemEnd)) {
    position = "none";
  } else if (isSameDay(cellDate, itemStart)) {
    position = "first";
  } else if (isSameDay(cellDate, itemEnd)) {
    position = "last";
  } else {
    position = "middle";
  }

  const renderBadgeText = ["first", "none"].includes(position);

  const eventBadgeClasses = cn(
    eventBadgeVariants({ multiDayPosition: position }),
    eventToneClass(event.color, badgeVariant),
    // In a span, the hairline between the days of one event would cut it up.
    position !== "none" && "shadow-none",
    event.response === "declined" && "opacity-60",
    className
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (e.currentTarget instanceof HTMLElement) e.currentTarget.click();
    }
  };

  return (
    <EventDetailsDialog event={event}>
      <div role="button" tabIndex={0} className={eventBadgeClasses} onKeyDown={handleKeyDown}>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
          {!["middle", "last"].includes(position) && ["mixed", "dot"].includes(badgeVariant) && (
            <svg width="8" height="8" viewBox="0 0 8 8" className="cal-dot shrink-0">
              <circle cx="4" cy="4" r="4" />
            </svg>
          )}

          {renderBadgeText && (
            <p className={cn("min-w-0 flex-1 truncate font-medium", event.response === "declined" && "line-through")}>
              {eventCurrentDay && (
                <span className="text-xs">
                  Day {eventCurrentDay} of {eventTotalDays} •{" "}
                </span>
              )}
              {event.title}
            </p>
          )}
        </div>

        {renderBadgeText && !(slim && event.isAllDay && !event.linkedCapture) && (
          <span className="flex shrink-0 items-center gap-1 text-[11px] opacity-80">
            {event.linkedCapture && <CaptureStatusIndicator capture={event.linkedCapture} compact />}
            {event.isAllDay ? (slim ? null : "All day") : compactTime(new Date(event.startDate))}
          </span>
        )}
      </div>
    </EventDetailsDialog>
  );
});
