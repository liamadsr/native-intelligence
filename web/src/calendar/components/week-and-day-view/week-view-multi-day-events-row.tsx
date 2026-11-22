import { useMemo } from "react";
import { startOfWeek } from "date-fns";

import { useCalendarSettings } from "@/calendar/contexts/calendar-context";
import { EventDetailsDialog } from "@/calendar/components/dialogs/event-details-dialog";
import { CaptureStatusIndicator } from "@/calendar/components/capture-status-indicator";
import { eventToneClass } from "@/calendar/event-colors";
import { layoutAllDayRow } from "@/calendar/layout/all-day-row";
import { cn } from "@/lib/utils";

import type { IEvent } from "@/calendar/interfaces";
import type { AllDayBar } from "@/calendar/layout/all-day-row";

interface IProps {
  selectedDate: Date;
  multiDayEvents: IEvent[];
}

/**
 * One event of the all-day row: a single bar across the day columns it
 * covers. Its ends are rounded where the event really starts and ends, and
 * squared (flush with the week's edge) where it runs on into another week.
 * The title is written once.
 */
function AllDayBarBlock({ bar }: { bar: AllDayBar }) {
  const { badgeVariant } = useCalendarSettings();
  const { event } = bar;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (e.currentTarget instanceof HTMLElement) e.currentTarget.click();
    }
  };

  return (
    <div
      className="min-w-0"
      style={{ gridColumn: `${bar.startIndex + 1} / ${bar.endIndex + 2}`, gridRow: bar.lane + 1 }}
      data-all-day-bar={event.id}
      data-lane={bar.lane}
      data-days={`${bar.startIndex}-${bar.endIndex}`}
    >
      <EventDetailsDialog event={event}>
        <div
          role="button"
          tabIndex={0}
          title={event.title}
          onKeyDown={handleKeyDown}
          className={cn(
            "flex h-5.5 select-none items-center gap-1.5 overflow-hidden whitespace-nowrap px-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            eventToneClass(event.color, badgeVariant),
            bar.startsBefore ? "ml-0 rounded-l-none" : "ml-1 rounded-l-md",
            bar.endsAfter ? "mr-0 rounded-r-none" : "mr-1 rounded-r-md",
            event.response === "declined" && "cal-declined",
            (event.response === "pending" || event.response === "tentative") && "cal-pending",
          )}
        >
          {["mixed", "dot"].includes(badgeVariant) && (
            <svg width="8" height="8" viewBox="0 0 8 8" className="cal-dot shrink-0">
              <circle cx="4" cy="4" r="4" />
            </svg>
          )}
          <p className={cn("min-w-0 flex-1 truncate font-medium", event.response === "declined" && "line-through")}>{event.title}</p>
          {event.linkedCapture && <CaptureStatusIndicator capture={event.linkedCapture} compact />}
        </div>
      </EventDetailsDialog>
    </div>
  );
}

export function WeekViewMultiDayEventsRow({ selectedDate, multiDayEvents }: IProps) {
  // The week's first day as a number, so the layout is redone when the week changes, not on every render.
  const weekStartTime = startOfWeek(selectedDate).getTime();
  const bars = useMemo(() => layoutAllDayRow(multiDayEvents, new Date(weekStartTime)), [multiDayEvents, weekStartTime]);

  if (bars.length === 0) return null;

  return (
    <div className="hidden overflow-hidden border-b border-border/60 sm:flex">
      <div className="flex w-18 shrink-0 items-start justify-end pr-2 pt-1.5 text-[10px] text-muted-foreground/70">all-day</div>
      <div className="grid min-w-0 flex-1 grid-cols-7 gap-y-0.5 border-l border-border/60 py-1" data-all-day-row="">
        {bars.map((bar) => (
          <AllDayBarBlock key={bar.event.id} bar={bar} />
        ))}
      </div>
    </div>
  );
}
