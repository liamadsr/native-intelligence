"use client";

import { memo } from "react";
import { format, parseISO } from "date-fns";
import { Clock, Text } from "lucide-react";

import { useCalendarSettings } from "@/calendar/contexts/calendar-context";

import { EventDetailsDialog } from "@/calendar/components/dialogs/event-details-dialog";

import { cn } from "@/lib/utils";
import { eventToneClass } from "@/calendar/event-colors";

import type { IEvent } from "@/calendar/interfaces";

const agendaEventCardClass =
  "flex select-none items-center justify-between gap-3 rounded-md p-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface IProps {
  event: IEvent;
  eventCurrentDay?: number;
  eventTotalDays?: number;
}

// Memoized: one per event in the month's agenda — skips when its event object
// is unchanged; the settings context it subscribes to is effectively static.
export const AgendaEventCard = memo(function AgendaEventCard({ event, eventCurrentDay, eventTotalDays }: IProps) {
  const { badgeVariant } = useCalendarSettings();

  const startDate = parseISO(event.startDate);
  const endDate = parseISO(event.endDate);

  const agendaEventCardClasses = cn(agendaEventCardClass, eventToneClass(event.color, badgeVariant));

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (e.currentTarget instanceof HTMLElement) e.currentTarget.click();
    }
  };

  return (
    <EventDetailsDialog event={event}>
      <div role="button" tabIndex={0} className={agendaEventCardClasses} onKeyDown={handleKeyDown}>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            {["mixed", "dot"].includes(badgeVariant) && (
              <svg width="8" height="8" viewBox="0 0 8 8" className="cal-dot shrink-0">
                <circle cx="4" cy="4" r="4" />
              </svg>
            )}

            <p className="font-medium">
              {eventCurrentDay && eventTotalDays && (
                <span className="mr-1 text-xs">
                  Day {eventCurrentDay} of {eventTotalDays} •{" "}
                </span>
              )}
              {event.title}
            </p>
          </div>

          <div className="flex items-center gap-1">
            <Clock className="size-3 shrink-0" />
            <p className="text-xs opacity-85">
              {format(startDate, "h:mm a")} - {format(endDate, "h:mm a")}
            </p>
          </div>

          {event.description && (
            <div className="flex items-center gap-1">
              <Text className="size-3 shrink-0" />
              <p className="text-xs opacity-85 line-clamp-1">{event.description}</p>
            </div>
          )}
        </div>
      </div>
    </EventDetailsDialog>
  );
});
