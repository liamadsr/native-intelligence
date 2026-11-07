"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { format, parseISO } from "date-fns";

import { useCalendar } from "@/calendar/contexts/calendar-context";
import { useUpdateEvent } from "@/calendar/hooks/use-update-event";

import type { IEvent } from "@/calendar/interfaces";

interface EventInteractionLayerProps {
  days: Date[];
  firstHour: number;
  hoursCount: number;
  gridRef: React.RefObject<HTMLElement | null>;
  gridColsClass: string;
}

type InteractionMode = "move" | "resize";

interface DragState {
  event: IEvent;
  mode: InteractionMode;
  dayIndex: number;
  originalStartMinute: number;
  originalEndMinute: number;
  durationMinutes: number;
  previewStartMinute: number;
  previewEndMinute: number;
  offsetMinute: number;
}

const DRAG_THRESHOLD = 4;
const SNAP = 15;
const PX_PER_HOUR = 96;
const PX_PER_MINUTE = PX_PER_HOUR / 60;
const AUTO_SCROLL_ZONE = 60; // px from edge to trigger scroll
const AUTO_SCROLL_SPEED = 12; // px per frame

function snapMinute(m: number) {
  return Math.round(m / SNAP) * SNAP;
}

/** Walk up from the grid to find the nearest scrollable ancestor (Radix ScrollArea or native) */
function findScrollContainer(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    // Radix ScrollArea viewport
    if (node.hasAttribute("data-radix-scroll-area-viewport")) return node;
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

export function EventInteractionLayer({ days, firstHour, hoursCount, gridRef, gridColsClass }: EventInteractionLayerProps) {
  const { events } = useCalendar();
  const { updateEvent } = useUpdateEvent();

  // `events` is only ever read to resolve an id on mousedown. Holding it in a
  // ref keeps handleMouseDown identity-stable, so the document-level
  // mousemove/mouseup listeners below aren't torn down and re-attached on every
  // date navigation (which produces a fresh filtered array each time).
  const eventsRef = useRef(events);
  eventsRef.current = events;

  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const lastMouseYRef = useRef<number>(0);
  const lastMouseXRef = useRef<number>(0);

  const pendingRef = useRef<{
    event: IEvent;
    mode: InteractionMode;
    dayIndex: number;
    columnEl: HTMLElement;
    eventEl: HTMLElement;
    startX: number;
    startY: number;
    startMin: number;
    endMin: number;
    offsetMin: number;
  } | null>(null);

  useEffect(() => {
    dragRef.current = drag;
  }, [drag]);

  // ── auto-scroll during drag ──────────────────────────────────────
  const startAutoScroll = useCallback(() => {
    const scroll = findScrollContainer(gridRef.current as HTMLElement | null);
    if (!scroll) return;

    const tick = () => {
      const d = dragRef.current;
      if (!d) { scrollRafRef.current = null; return; }

      const rect = scroll.getBoundingClientRect();
      const mouseY = lastMouseYRef.current;
      let didScroll = false;

      const distFromBottom = rect.bottom - mouseY;
      const distFromTop = mouseY - rect.top;

      if (distFromBottom < AUTO_SCROLL_ZONE && distFromBottom >= 0) {
        const before = scroll.scrollTop;
        scroll.scrollTop += AUTO_SCROLL_SPEED;
        didScroll = scroll.scrollTop !== before;
      } else if (distFromTop < AUTO_SCROLL_ZONE && distFromTop >= 0) {
        const before = scroll.scrollTop;
        scroll.scrollTop -= AUTO_SCROLL_SPEED;
        didScroll = scroll.scrollTop !== before;
      }


      // After scrolling, recalculate drag position (mouse is stationary but content shifted)
      if (didScroll) {
        const grid = gridRef.current;
        if (grid) {
          const columns = grid.querySelectorAll<HTMLElement>("[data-day-column]");
          let col: HTMLElement | null = null;
          const mx = lastMouseXRef.current;
          for (let i = 0; i < columns.length; i++) {
            const r = columns[i].getBoundingClientRect();
            if (mx >= r.left && mx <= r.right) { col = columns[i]; break; }
          }
          if (col) {
            const colRect = col.getBoundingClientRect();
            const relY = mouseY - colRect.top;
            const mouseMin = firstHour * 60 + relY / PX_PER_MINUTE;

            if (d.mode === "resize") {
              let newEnd = snapMinute(mouseMin);
              newEnd = Math.max(d.originalStartMinute + SNAP, Math.min(23 * 60 + 45, newEnd));
              const next: DragState = { ...d, previewEndMinute: newEnd, durationMinutes: newEnd - d.originalStartMinute };
              setDrag(next);
              dragRef.current = next;
            } else {
              const minBound = firstHour * 60;
              const maxBound = (firstHour + hoursCount) * 60;
              let newStart = snapMinute(mouseMin - d.offsetMinute);
              newStart = Math.max(minBound, Math.min(maxBound - d.durationMinutes, newStart));
              const next: DragState = { ...d, previewStartMinute: newStart, previewEndMinute: newStart + d.durationMinutes };
              setDrag(next);
              dragRef.current = next;
            }
          }
        }
      }

      scrollRafRef.current = requestAnimationFrame(tick);
    };
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(tick);
  }, [gridRef, firstHour, hoursCount]);

  const stopAutoScroll = useCallback(() => {
    if (scrollRafRef.current) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
  }, []);

  const getMinuteFromY = useCallback(
    (clientY: number, columnEl: HTMLElement) => {
      const rect = columnEl.getBoundingClientRect();
      const relY = clientY - rect.top;
      return firstHour * 60 + relY / PX_PER_MINUTE;
    },
    [firstHour],
  );

  const findDayColumn = useCallback(
    (clientX: number): { dayIndex: number; columnEl: HTMLElement } | null => {
      const grid = gridRef.current;
      if (!grid) return null;
      const columns = grid.querySelectorAll<HTMLElement>("[data-day-column]");
      for (let i = 0; i < columns.length; i++) {
        const rect = columns[i].getBoundingClientRect();
        if (clientX >= rect.left && clientX <= rect.right) {
          return { dayIndex: i, columnEl: columns[i] };
        }
      }
      return null;
    },
    [gridRef],
  );

  // ── mousedown ─────────────────────────────────────────────────────
  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;

      const isResize = !!target.closest("[data-resize-handle]");
      const eventEl = target.closest("[data-event-id]") as HTMLElement | null;
      if (!eventEl) return;

      const eventId = eventEl.getAttribute("data-event-id");
      const event = eventsRef.current.find((ev) => ev.id === eventId);
      if (!event) return;

      const col = findDayColumn(e.clientX);
      if (!col) return;

      const start = parseISO(event.startDate);
      const end = parseISO(event.endDate);
      const startMin = start.getHours() * 60 + start.getMinutes();
      const endMin = end.getHours() * 60 + end.getMinutes();
      const mouseMin = getMinuteFromY(e.clientY, col.columnEl);

      // Prevent text selection immediately on any event mousedown
      e.preventDefault();

      pendingRef.current = {
        event,
        mode: isResize ? "resize" : "move",
        dayIndex: col.dayIndex,
        columnEl: col.columnEl,
        eventEl,
        startX: e.clientX,
        startY: e.clientY,
        startMin,
        endMin,
        offsetMin: mouseMin - startMin,
      };

      if (isResize) {
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    },
    [findDayColumn, getMinuteFromY],
  );

  // ── mousemove ─────────────────────────────────────────────────────
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      lastMouseYRef.current = e.clientY;
      lastMouseXRef.current = e.clientX;

      const p = pendingRef.current;
      if (p && !dragRef.current) {
        const dx = e.clientX - p.startX;
        const dy = e.clientY - p.startY;
        if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;

        // Promote to real drag
        e.preventDefault();
        e.stopPropagation();

        const duration = p.endMin - p.startMin;
        const state: DragState = {
          event: p.event,
          mode: p.mode,
          dayIndex: p.dayIndex,
          originalStartMinute: p.startMin,
          originalEndMinute: p.endMin,
          durationMinutes: duration,
          previewStartMinute: p.startMin,
          previewEndMinute: p.endMin,
          offsetMinute: p.offsetMin,
        };
        setDrag(state);
        dragRef.current = state;

        // Hide the original event block while dragging
        p.eventEl.style.opacity = "0.3";

        // Start auto-scrolling
        startAutoScroll();
      }

      const d = dragRef.current;
      if (!d) return;

      // Active drag — prevent all other interactions
      e.preventDefault();
      e.stopPropagation();

      const col = findDayColumn(e.clientX);
      if (!col) return;

      const mouseMin = getMinuteFromY(e.clientY, col.columnEl);

      if (d.mode === "move") {
        const minBound = firstHour * 60;
        const maxBound = (firstHour + hoursCount) * 60;
        let newStart = snapMinute(mouseMin - d.offsetMinute);
        newStart = Math.max(minBound, Math.min(maxBound - d.durationMinutes, newStart));
        const next: DragState = {
          ...d,
          dayIndex: col.dayIndex,
          previewStartMinute: newStart,
          previewEndMinute: newStart + d.durationMinutes,
        };
        setDrag(next);
        dragRef.current = next;
      } else {
        // Resize — allow extending and shrinking, min 15 min duration
        let newEnd = snapMinute(mouseMin);
        newEnd = Math.max(d.originalStartMinute + SNAP, Math.min(23 * 60 + 45, newEnd));
        const next: DragState = {
          ...d,
          previewEndMinute: newEnd,
          durationMinutes: newEnd - d.originalStartMinute,
        };
        setDrag(next);
        dragRef.current = next;
      }
    },
    [findDayColumn, getMinuteFromY, firstHour, hoursCount, startAutoScroll],
  );

  // ── mouseup ───────────────────────────────────────────────────────
  const handleMouseUp = useCallback(() => {
    stopAutoScroll();

    // Restore opacity of original event
    const p = pendingRef.current;
    if (p) {
      p.eventEl.style.opacity = "";
    }
    pendingRef.current = null;

    const d = dragRef.current;
    if (!d) return;

    // Suppress the next click so the EventDetailsDialog doesn't open after a drag
    const suppressClick = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
    };
    document.addEventListener("click", suppressClick, { capture: true, once: true });
    setTimeout(() => document.removeEventListener("click", suppressClick, true), 0);

    const originalDayIndex = days.findIndex((day) => {
      const evStart = parseISO(d.event.startDate);
      return (
        day.getFullYear() === evStart.getFullYear() &&
        day.getMonth() === evStart.getMonth() &&
        day.getDate() === evStart.getDate()
      );
    });

    const changed =
      d.previewStartMinute !== d.originalStartMinute ||
      d.previewEndMinute !== d.originalEndMinute ||
      d.dayIndex !== originalDayIndex;

    if (changed) {
      const targetDay = days[d.dayIndex];
      const newStart = new Date(targetDay);
      newStart.setHours(Math.floor(d.previewStartMinute / 60), d.previewStartMinute % 60, 0, 0);
      const newEnd = new Date(targetDay);
      newEnd.setHours(Math.floor(d.previewEndMinute / 60), d.previewEndMinute % 60, 0, 0);

      updateEvent({
        ...d.event,
        startDate: newStart.toISOString(),
        endDate: newEnd.toISOString(),
      });
    }

    setDrag(null);
    dragRef.current = null;
  }, [days, updateEvent, stopAutoScroll]);

  // ── attach/detach ─────────────────────────────────────────────────
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    grid.addEventListener("mousedown", handleMouseDown, true);
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      grid.removeEventListener("mousedown", handleMouseDown, true);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      stopAutoScroll();
    };
  }, [gridRef, handleMouseDown, handleMouseMove, handleMouseUp, stopAutoScroll]);

  if (!drag) return null;

  // ── ghost overlay ─────────────────────────────────────────────────
  const topMin = drag.previewStartMinute - firstHour * 60;
  const topPx = topMin * PX_PER_MINUTE;
  const heightPx = (drag.durationMinutes / 60) * PX_PER_HOUR;

  const overlayStyle: React.CSSProperties = {
    top: `${topPx}px`,
    height: `${heightPx}px`,
  };

  const fmtTime = (totalMin: number) => {
    const d = new Date();
    d.setHours(Math.floor(totalMin / 60), totalMin % 60);
    return format(d, "h:mm a");
  };

  return (
    <>
      <div className="pointer-events-none absolute inset-0" style={{ zIndex: 45 }}>
        <div className={`grid ${gridColsClass} divide-x h-full`}>
          {days.map((_, i) => (
            <div key={i} className="relative overflow-visible">
              {i === drag.dayIndex && (
                <div
                  className="absolute inset-x-1 rounded-md border-2 border-primary bg-primary/20 overflow-hidden"
                  style={overlayStyle}
                >
                  <div className="px-2 py-1 text-xs font-medium text-primary truncate">
                    {drag.event.title}
                  </div>
                  <div className="px-2 text-[10px] text-primary/70">
                    {fmtTime(drag.previewStartMinute)} – {fmtTime(drag.previewEndMinute)}
                  </div>
                  {drag.mode === "resize" && (
                    <div className="absolute inset-x-0 bottom-0 flex h-3 items-end justify-center">
                      <div className="h-1 w-8 rounded-full bg-primary/40" />
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <style>{`body { user-select: none !important; cursor: ${drag.mode === "resize" ? "ns-resize" : "grabbing"} !important; }`}</style>
    </>
  );
}
