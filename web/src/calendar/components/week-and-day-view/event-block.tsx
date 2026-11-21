import { memo } from "react";
import { differenceInMinutes, parseISO } from "date-fns";
import { Disc, Loader2 } from "lucide-react";

import { useCalendarSettings } from "@/calendar/contexts/calendar-context";

import { EventDetailsDialog } from "@/calendar/components/dialogs/event-details-dialog";

import { CaptureStatusIndicator } from "@/calendar/components/capture-status-indicator";
import { useStartMeetingFromEvent } from "@/calendar/hooks/use-start-meeting";
import { cn } from "@/lib/utils";
import { eventToneClass } from "@/calendar/event-colors";
import { compactTime, compactTimeRange } from "@/calendar/helpers";

import type { HTMLAttributes } from "react";
import type { IEvent } from "@/calendar/interfaces";

/** The block: a soft fill in its calendar's colour (event-colors), small type, no border of its own. */
const eventBlockClass =
  "flex select-none flex-col overflow-hidden rounded-md px-1.5 py-[3px] text-xs leading-tight focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface IProps extends HTMLAttributes<HTMLDivElement> {
  event: IEvent;
  /** Read-only presentation: no grab cursor, no resize handle. Used by the
   *  Capture button's calendar, which has no drag/resize machinery. The main
   *  calendar page leaves this off to keep drag-to-move / resize. */
  readOnly?: boolean;
  /** The whole block is the Start button: a click (or Enter / Space) starts
   *  the event's capture, nothing opens the event, and there's no separate
   *  Start button or Recording pill (the title row's indicator still shows a
   *  capture). Used by the Capture button's calendar, where a short meeting's
   *  block is too small to hold a button. Action pseudo-events aren't meetings,
   *  so they keep the default click. */
  startOnClick?: boolean;
}

// Memoized: one instance per visible event, so a grid re-render (date nav,
// popover state) only touches blocks whose event object actually changed —
// the settings context it subscribes to is effectively static.
export const EventBlock = memo(function EventBlock({ event, className, readOnly = false, startOnClick = false }: IProps) {
  const { badgeVariant } = useCalendarSettings();
  const { startMeeting, startingId, isRecording, isLive } = useStartMeetingFromEvent();

  const start = parseISO(event.startDate);
  const end = parseISO(event.endDate);
  const durationInMinutes = differenceInMinutes(end, start);

  const starting = startingId === event.id;
  const live = isLive(event);
  const capturing = event.linkedCapture?.auto_capture_status === "recording";
  const clickStarts = startOnClick && !event.isAction;
  const startCapture = () => {
    if (!starting) startMeeting(event);
  };

  // Under half an hour there is one line: the title, then when it starts.
  const short = durationInMinutes < 30;

  const calendarWeekEventCardClasses = cn(
    eventBlockClass,
    eventToneClass(event.color, badgeVariant),
    short && "justify-center py-0",
    // Not answered yet: a paler fill with a dashed edge. Declined: muted and struck through. Both stay
    // opaque (tailwind.css): a see-through block showed the events under it as if they were faded on top.
    (event.response === "pending" || event.response === "tentative") && "cal-pending outline-dashed outline-1 -outline-offset-1 outline-current/40",
    event.response === "declined" && "cal-declined",
    className
  );

  const card = (
    <div
      role="button"
      tabIndex={0}
      className={cn(calendarWeekEventCardClasses, "relative h-full overflow-hidden")}
      {...(clickStarts && {
        title: isRecording ? "A capture is already in progress" : "Start a capture for this meeting",
        "aria-busy": starting,
        onClick: startCapture,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          startCapture();
        },
      })}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {["mixed", "dot"].includes(badgeVariant) && (
          <svg width="8" height="8" viewBox="0 0 8 8" className="cal-dot shrink-0">
            <circle cx="4" cy="4" r="4" />
          </svg>
        )}

        <p className={cn("min-w-0 truncate font-medium", event.response === "declined" && "line-through")}>{event.title}</p>
        {short && !event.isAction && <span className="shrink-0 text-[11px] tabular-nums opacity-75">{compactTime(start)}</span>}
        {clickStarts && starting ? (
          <Loader2 className="size-3 shrink-0 animate-spin" />
        ) : (
          event.linkedCapture && <CaptureStatusIndicator capture={event.linkedCapture} compact />
        )}
      </div>

      {!short && <p className="truncate text-[11px] tabular-nums opacity-80">{compactTimeRange(start, end)}</p>}

      {/* Start-capture button — reveals on hover, always visible while the
          meeting is happening now. Shows "Recording" when a linked capture
          is already rolling. Stops propagation so it doesn't open the event.
          Shared flow (useStartMeetingFromEvent) so it behaves identically in
          the day/week views and the Capture button's calendar (where the
          whole block starts it instead). Action pseudo-events (due-date
          pills) are not meetings — no button. */}
      {event.isAction || clickStarts ? null : capturing ? (
        <span className="absolute right-1 top-1 z-20 inline-flex h-5 items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-1.5 text-[10px] font-medium text-red-600 dark:text-red-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
          Recording
        </span>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            startMeeting(event);
          }}
          disabled={starting || isRecording}
          title={isRecording ? "A capture is already in progress" : "Start a linked capture"}
          className={cn(
            "absolute right-0.5 top-0.5 z-20 inline-flex h-[18px] items-center gap-1 rounded-full border border-border bg-white px-1.5 text-[10px] font-medium shadow-sm transition-all dark:bg-black dark:shadow-none",
            "text-sidebar-foreground/70 hover:bg-muted hover:text-sidebar-foreground",
            "disabled:cursor-not-allowed disabled:opacity-50",
            live ? "opacity-100" : "opacity-0 group-hover/event:opacity-100 focus-visible:opacity-100",
          )}
        >
          {starting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Disc className="h-3 w-3" />}
          {/* While the meeting is on, the button stays in view as its icon and
              opens to the word on hover: in a stack of overlapping meetings a
              row of full buttons covered the titles. */}
          <span className={cn(live && "hidden group-hover/event:inline group-focus-within/event:inline")}>Start</span>
        </button>
      )}

      {/* Resize handle — sits at the bottom edge of the card. Hidden in
          read-only mode (the Capture button's calendar), which has no resize machinery. */}
      {!readOnly && (
        <div
          data-resize-handle
          className="absolute inset-x-0 bottom-0 z-20 flex h-3 cursor-ns-resize items-center justify-center rounded-b-md opacity-0 transition-opacity group-hover/event:opacity-100"
        >
          <div className="h-[3px] w-8 rounded-full bg-current opacity-50" />
        </div>
      )}
    </div>
  );

  return (
    <div
      data-event-id={event.id}
      data-event-block
      className={cn(
        // Fills the slot its view positions it in (helpers' positionDayEvents).
        "group/event relative h-full",
        readOnly ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
      )}
    >
      {clickStarts ? card : <EventDetailsDialog event={event}>{card}</EventDetailsDialog>}
    </div>
  );
});
