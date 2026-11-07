import { memo } from "react";
import { cva } from "class-variance-authority";
import { format, differenceInMinutes, parseISO } from "date-fns";
import { Disc, Loader2 } from "lucide-react";

import { useCalendarSettings } from "@/calendar/contexts/calendar-context";

import { EventDetailsDialog } from "@/calendar/components/dialogs/event-details-dialog";

import { CaptureStatusIndicator } from "@/calendar/components/capture-status-indicator";
import { useStartMeetingFromEvent } from "@/calendar/hooks/use-start-meeting";
import { cn } from "@/lib/utils";

import type { HTMLAttributes } from "react";
import type { IEvent } from "@/calendar/interfaces";
import type { VariantProps } from "class-variance-authority";

const calendarWeekEventCardVariants = cva(
  "flex select-none flex-col gap-0.5 truncate whitespace-nowrap rounded-md border px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
  {
    variants: {
      color: {
        // Colored and mixed variants
        blue: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300 [&_.event-dot]:fill-blue-600",
        green: "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300 [&_.event-dot]:fill-green-600",
        red: "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300 [&_.event-dot]:fill-red-600",
        yellow: "border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-300 [&_.event-dot]:fill-yellow-600",
        purple: "border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-950 dark:text-purple-300 [&_.event-dot]:fill-purple-600",
        orange: "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-300 [&_.event-dot]:fill-orange-600",
        gray: "border-neutral-200 bg-neutral-50 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 [&_.event-dot]:fill-neutral-600",

        // Dot variants
        "blue-dot": "bg-neutral-50 dark:bg-neutral-900 [&_.event-dot]:fill-blue-600",
        "green-dot": "bg-neutral-50 dark:bg-neutral-900 [&_.event-dot]:fill-green-600",
        "red-dot": "bg-neutral-50 dark:bg-neutral-900 [&_.event-dot]:fill-red-600",
        "orange-dot": "bg-neutral-50 dark:bg-neutral-900 [&_.event-dot]:fill-orange-600",
        "purple-dot": "bg-neutral-50 dark:bg-neutral-900 [&_.event-dot]:fill-purple-600",
        "yellow-dot": "bg-neutral-50 dark:bg-neutral-900 [&_.event-dot]:fill-yellow-600",
        "gray-dot": "bg-neutral-50 dark:bg-neutral-900 [&_.event-dot]:fill-neutral-600",
      },
    },
    defaultVariants: {
      color: "blue-dot",
    },
  }
);

interface IProps extends HTMLAttributes<HTMLDivElement>, Omit<VariantProps<typeof calendarWeekEventCardVariants>, "color"> {
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

  const color = (badgeVariant === "dot" ? `${event.color}-dot` : event.color) as VariantProps<typeof calendarWeekEventCardVariants>["color"];

  const calendarWeekEventCardClasses = cn(calendarWeekEventCardVariants({ color, className }), durationInMinutes < 35 && "py-0 justify-center");

  const heightInPixels = (durationInMinutes / 60) * 96 - 8;

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
      <div className="flex items-center gap-1.5 truncate">
        {["mixed", "dot"].includes(badgeVariant) && (
          <svg width="8" height="8" viewBox="0 0 8 8" className="event-dot shrink-0">
            <circle cx="4" cy="4" r="4" />
          </svg>
        )}

        <p className="truncate font-semibold">{event.title}</p>
        {clickStarts && starting ? (
          <Loader2 className="size-3 shrink-0 animate-spin" />
        ) : (
          event.linkedCapture && <CaptureStatusIndicator capture={event.linkedCapture} compact />
        )}
      </div>

      {durationInMinutes > 25 && (
        <p>
          {format(start, "h:mm a")} - {format(end, "h:mm a")}
        </p>
      )}

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
            "absolute right-1 top-1 z-20 inline-flex h-5 items-center gap-1 rounded-full border border-border bg-white px-1.5 text-[10px] font-medium shadow-sm transition-all dark:bg-black dark:shadow-none",
            "text-sidebar-foreground/70 hover:bg-muted hover:text-sidebar-foreground",
            "disabled:cursor-not-allowed disabled:opacity-50",
            live ? "opacity-100" : "opacity-0 group-hover/event:opacity-100 focus-visible:opacity-100",
          )}
        >
          {starting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Disc className="h-3 w-3" />}
          Start
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
        "group/event relative",
        readOnly ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
      )}
      style={{ height: `${heightInPixels}px` }}
    >
      {clickStarts ? card : <EventDetailsDialog event={event}>{card}</EventDetailsDialog>}
    </div>
  );
});
