"use client";

import { useCalendarMutators } from "@/calendar/contexts/calendar-context";

import type { IEvent } from "@/calendar/interfaces";

interface IProps {
  event: IEvent;
  children: React.ReactNode;
}

export function EventDetailsDialog({ event, children }: IProps) {
  const { selectEvent } = useCalendarMutators();

  // All events (actions and calendar events) open in the side panel
  return (
    <div className="h-full" onClick={() => selectEvent(event)}>
      {children}
    </div>
  );
}
