"use client";

import { memo } from "react";

import { useCalendarMutators } from "@/calendar/contexts/calendar-context";

/**
 * The four clickable 15-minute quarters of one hour cell, plus the half-hour
 * divider between them (rendered between the second and third quarter so a
 * hovered lower quarter paints over the divider, and an upper one under it).
 *
 * Deliberately plain divs, not drag/drop targets: every pointer interaction on
 * the grid — moving, resizing, drag-to-create — is owned by the overlay layers
 * (EventInteractionLayer, TimeGridDragLayer), which do their own hit-testing.
 * A quarter only needs its hover affordance and click-to-draft. Memoized:
 * mutators are identity-stable, so a mounted grid of these never re-renders.
 */
export const HourSlots = memo(function HourSlots({ day, hour }: { day: Date; hour: number }) {
  const { openEventPopover } = useCalendarMutators();

  const handleSlotClick = (minute: number) => (e: React.MouseEvent<HTMLDivElement>) => {
    const start = new Date(day);
    start.setHours(hour, minute, 0, 0);
    const end = new Date(day);
    if (minute === 45) end.setHours(hour + 1, 0, 0, 0);
    else end.setHours(hour, minute + 15, 0, 0);
    openEventPopover(e.currentTarget, start, end);
  };

  return (
    <>
      <div onClick={handleSlotClick(0)} className="absolute inset-x-0 top-0 h-[24px] cursor-pointer transition-colors hover:bg-accent" />
      <div onClick={handleSlotClick(15)} className="absolute inset-x-0 top-[24px] h-[24px] cursor-pointer transition-colors hover:bg-accent" />

      <div className="pointer-events-none absolute inset-x-0 top-1/2 border-b border-dashed"></div>

      <div onClick={handleSlotClick(30)} className="absolute inset-x-0 top-[48px] h-[24px] cursor-pointer transition-colors hover:bg-accent" />
      <div onClick={handleSlotClick(45)} className="absolute inset-x-0 top-[72px] h-[24px] cursor-pointer transition-colors hover:bg-accent" />
    </>
  );
});
