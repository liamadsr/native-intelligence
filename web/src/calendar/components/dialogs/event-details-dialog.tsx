"use client";

import { useCalendarMutators, useOptionalCalendarEventDetails } from "@/calendar/contexts/calendar-context";

import type { IEvent } from "@/calendar/interfaces";

interface IProps {
  event: IEvent;
  children: React.ReactNode;
}

/**
 * The click around every event on the calendar (week and day blocks, the
 * all-day and multi-day rows, month badges, agenda cards). A calendar event
 * opens its card beside the block (event-details-popover.tsx), and the block
 * reads as selected while it is open; a task opens its action. A click that
 * ends a drag never gets here (event-interaction-layer swallows it).
 */
export function EventDetailsDialog({ event, children }: IProps) {
  const { selectEvent } = useCalendarMutators();
  const open = useOptionalCalendarEventDetails();
  const selected = !event.isAction && open?.eventId === event.id;

  return (
    <div
      className="h-full"
      data-calendar-event-trigger={event.id}
      data-event-selected={selected ? "" : undefined}
      onClick={(e) => selectEvent(event, e.currentTarget)}
    >
      {children}
    </div>
  );
}
