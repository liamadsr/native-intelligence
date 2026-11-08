import type { TEventColor } from "@/calendar/types";
import type { CalendarEventAttendee } from "@/lib/integrations/calendar";

export interface IEventCapture {
  capture_id: string;
  auto_capture_status: string | null;
  ai_processed: boolean;
  source_action_count: number;
}

export interface IEvent {
  id: string;
  startDate: string;
  endDate: string;
  title: string;
  color: TEventColor;
  description: string;
  // NI-specific fields
  htmlLink?: string;
  location?: string;
  conferenceUrl?: string;
  calendarName?: string;
  isAllDay?: boolean;
  attendees?: string[];
  // Same attendees with the provider's display names preserved. Sent to
  // capture creation so the CRM gets a real name instead of the address.
  attendeeDetails?: CalendarEventAttendee[];
  // Source: "local_exchange" for EventKit events, undefined for OAuth
  source?: string;
  // Calendar ID (for local Exchange write-back)
  calendarId?: string;
  // Recurring-series identity — passed through to capture creation so
  // occurrences of the same meeting thread into one history
  hasRecurrence?: boolean;
  seriesMasterId?: string;
  icalUid?: string;
  provider?: string;
  // The connected account the event is on (a chat card's account filter)
  accountId?: string;
  // Linked capture data
  linkedCapture?: IEventCapture;
  // Action-specific fields (isAction = true means this event came from the actions table)
  isAction?: boolean;
  actionId?: string;
  actionIdentifier?: string;
  actionPriority?: string;
}

export interface ICalendarCell {
  day: number;
  currentMonth: boolean;
  date: Date;
}
