"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { format } from "date-fns";

import { useCalendarDraft, useCalendarMutators } from "@/calendar/contexts/calendar-context";

interface TimeGridDragLayerProps {
  /** The dates for each column (1 for day view, 7 for week view) */
  days: Date[];
  /** First visible hour in the grid */
  firstHour: number;
  /** Total number of visible hours */
  hoursCount: number;
  /** Ref to the grid container (the element containing all day columns) */
  gridRef: React.RefObject<HTMLElement | null>;
  /** Explicit grid-cols class (e.g. "grid-cols-7" or "grid-cols-1") to avoid Tailwind JIT issues */
  gridColsClass: string;
}

interface DragState {
  day: Date;
  dayIndex: number;
  startMinute: number;
  endMinute: number;
}

function minuteToTime(minute: number) {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return { hour: h, minute: m };
}

function formatMinute(minute: number) {
  const d = new Date();
  d.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
  return format(d, "h:mm a");
}

export function TimeGridDragLayer({ days, firstHour, hoursCount, gridRef, gridColsClass }: TimeGridDragLayerProps) {
  const { openEventPopover } = useCalendarMutators();
  const draftPopover = useCalendarDraft();
  const [drag, setDrag] = useState<DragState | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ dayIndex: number; startMinute: number } | null>(null);
  const snapMinutes = 15;

  const getPositionFromEvent = useCallback(
    (clientX: number, clientY: number) => {
      const grid = gridRef.current;
      if (!grid) return null;

      // Find which day column was hit
      const columns = grid.querySelectorAll<HTMLElement>("[data-day-column]");
      let dayIndex = -1;
      let columnRect: DOMRect | null = null;

      for (let i = 0; i < columns.length; i++) {
        const rect = columns[i].getBoundingClientRect();
        if (clientX >= rect.left && clientX <= rect.right) {
          dayIndex = i;
          columnRect = rect;
          break;
        }
      }

      if (dayIndex === -1 || !columnRect) return null;

      const relativeY = clientY - columnRect.top;
      const pixelsPerMinute = 96 / 60; // 96px per hour
      const rawMinute = firstHour * 60 + relativeY / pixelsPerMinute;
      const snappedMinute = Math.floor(rawMinute / snapMinutes) * snapMinutes;
      const clampedMinute = Math.max(firstHour * 60, Math.min((firstHour + hoursCount) * 60, snappedMinute));

      // Also compute the ceiling (top of the next 15-min slot) for end calculations
      const ceilMinute = Math.ceil(rawMinute / snapMinutes) * snapMinutes;
      const clampedCeil = Math.max(firstHour * 60, Math.min((firstHour + hoursCount) * 60, ceilMinute));

      return { dayIndex, minute: clampedMinute, ceilMinute: clampedCeil };
    },
    [gridRef, firstHour, hoursCount],
  );

  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      // Only left click
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      // Don't interfere with event blocks, resize handles, buttons, or dialog triggers
      if (
        target.closest("[role=\"button\"]") ||
        target.closest("[data-event-block]") ||
        target.closest("[data-event-id]") ||
        target.closest("[data-resize-handle]") ||
        target.closest("button") ||
        target.closest("[data-radix-collection-item]")
      ) {
        return;
      }

      const pos = getPositionFromEvent(e.clientX, e.clientY);
      if (!pos) return;

      e.preventDefault();
      dragStartRef.current = { dayIndex: pos.dayIndex, startMinute: pos.minute };
      setIsDragging(true);
      // Initial selection: floor to ceil gives one 15-min block.
      // If click lands exactly on a boundary, ceil == floor, so ensure at least one snap.
      const initialEnd = pos.ceilMinute <= pos.minute ? pos.minute + snapMinutes : pos.ceilMinute;
      setDrag({
        day: days[pos.dayIndex],
        dayIndex: pos.dayIndex,
        startMinute: pos.minute,
        endMinute: initialEnd,
      });
    },
    [getPositionFromEvent, days],
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const pos = getPositionFromEvent(e.clientX, e.clientY);
      if (!pos || pos.dayIndex !== dragStartRef.current.dayIndex) return;

      const start = dragStartRef.current.startMinute;
      // Use floor for the start side, ceil for the end side
      const dragStart = Math.min(start, pos.minute);
      const dragEnd = Math.max(start, pos.ceilMinute);
      // Ensure at least one snap interval
      const endMinute = dragEnd <= dragStart ? dragStart + snapMinutes : dragEnd;
      setDrag({
        day: days[dragStartRef.current.dayIndex],
        dayIndex: dragStartRef.current.dayIndex,
        startMinute: dragStart,
        endMinute,
      });
    },
    [getPositionFromEvent, days],
  );

  const handleMouseUp = useCallback((e: MouseEvent) => {
    if (!dragStartRef.current || !drag) {
      dragStartRef.current = null;
      setIsDragging(false);
      return;
    }

    // Only open popover if dragged more than a single snap (i.e. actually dragged, not just clicked)
    const duration = drag.endMinute - drag.startMinute;
    if (duration >= snapMinutes) {
      const startTime = minuteToTime(drag.startMinute);
      const endTime = minuteToTime(drag.endMinute);
      const start = new Date(drag.day);
      start.setHours(startTime.hour, startTime.minute, 0, 0);
      const end = new Date(drag.day);
      end.setHours(endTime.hour, endTime.minute, 0, 0);

      // Use the element under the cursor as anchor
      const anchorEl = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      openEventPopover(anchorEl, start, end);
    }

    dragStartRef.current = null;
    setIsDragging(false);
    // Don't clear drag overlay — keep it visible while popover is open
    // It will be cleared when the popover closes (via the useEffect below)
  }, [drag, openEventPopover]);

  // Sync overlay with the popover: show when open, clear when closed, update on reposition
  useEffect(() => {
    if (!draftPopover) {
      setDrag(null);
      return;
    }
    const startMin = draftPopover.draft.start.getHours() * 60 + draftPopover.draft.start.getMinutes();
    const endMin = draftPopover.draft.end.getHours() * 60 + draftPopover.draft.end.getMinutes();
    const dayIndex = days.findIndex((d) => {
      const ds = draftPopover.draft.start;
      return d.getFullYear() === ds.getFullYear() && d.getMonth() === ds.getMonth() && d.getDate() === ds.getDate();
    });
    if (dayIndex !== -1) {
      setDrag({ day: days[dayIndex], dayIndex, startMinute: startMin, endMinute: endMin });
    }
  }, [draftPopover, days]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    grid.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      grid.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [gridRef, handleMouseDown, handleMouseMove, handleMouseUp]);

  // Calculate overlay position
  const getOverlayStyle = (state: DragState) => {
    const topMinutes = state.startMinute - firstHour * 60;
    const heightMinutes = state.endMinute - state.startMinute;
    const pixelsPerMinute = 96 / 60;

    return {
      top: `${topMinutes * pixelsPerMinute}px`,
      height: `${heightMinutes * pixelsPerMinute}px`,
    };
  };

  return (
    <>
      {/* Selection overlay rendered inside each day column via portal-like approach */}
      {drag && (
        <div
          data-drag-overlay
          className="pointer-events-none absolute inset-0"
          style={{ zIndex: 40 }}
        >
          {/* We position relative to the grid, need to find the right column */}
          <div className={`grid ${gridColsClass} divide-x h-full`}>
            {days.map((_, i) => (
              <div key={i} className="relative">
                {i === drag.dayIndex && (
                  <div
                    className="absolute inset-x-1 rounded-md border-2 border-primary bg-primary/20"
                    style={getOverlayStyle(drag)}
                  >
                    <div className="px-2 py-1 text-xs font-medium text-primary">
                      {formatMinute(drag.startMinute)} – {formatMinute(drag.endMinute)}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Prevent text selection while dragging */}
      {isDragging && (
        <style>{`body { user-select: none !important; cursor: ns-resize !important; }`}</style>
      )}
    </>
  );
}
