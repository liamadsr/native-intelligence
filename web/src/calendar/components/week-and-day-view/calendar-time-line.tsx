import { format, isSameDay, startOfWeek, addDays } from "date-fns";
import { useEffect, useState } from "react";

interface IProps {
  firstVisibleHour: number;
  lastVisibleHour: number;
  /** Total columns in the grid (1 for day view, 7 for week view) */
  columnCount?: number;
  /** The days rendered in the grid (used to find today's column) */
  days?: Date[];
}

export function CalendarTimeline({ firstVisibleHour, lastVisibleHour, columnCount = 1, days }: IProps) {
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  const getCurrentTimePosition = () => {
    const minutes = currentTime.getHours() * 60 + currentTime.getMinutes();

    const visibleStartMinutes = firstVisibleHour * 60;
    const visibleEndMinutes = lastVisibleHour * 60;
    const visibleRangeMinutes = visibleEndMinutes - visibleStartMinutes;

    return ((minutes - visibleStartMinutes) / visibleRangeMinutes) * 100;
  };

  const formatCurrentTime = () => {
    return format(currentTime, "h:mm");
  };

  const currentHour = currentTime.getHours();
  if (currentHour < firstVisibleHour || currentHour >= lastVisibleHour) return null;

  // Find which column today falls in
  let todayColumnIndex = 0;
  if (days) {
    const idx = days.findIndex(d => isSameDay(d, currentTime));
    if (idx === -1) return null; // Today is not in the visible range
    todayColumnIndex = idx;
  }

  const columnWidthPercent = 100 / columnCount;
  const todayLeftPercent = todayColumnIndex * columnWidthPercent;

  // A hairline across the whole grid at now, strong over today's column, where
  // a dot marks its start; the time sits in the hour gutter.
  return (
    <div data-calendar-timeline className="pointer-events-none absolute inset-x-0 z-10 h-0" style={{ top: `${getCurrentTimePosition()}%` }}>
      <div className="absolute inset-x-0 top-0 -translate-y-1/2 border-t border-red-500/25"></div>
      <div className="absolute top-0 h-0.5 -translate-y-1/2 rounded-full bg-red-500" style={{ left: `${todayLeftPercent}%`, width: `${columnWidthPercent}%` }}></div>
      <div className="absolute top-0 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-500" style={{ left: `${todayLeftPercent}%` }}></div>
      <div className="absolute -left-18 top-0 flex w-18 -translate-y-1/2 justify-end pr-1.5">
        <span className="rounded bg-red-500 px-1 py-px text-[10px] font-semibold tabular-nums leading-tight text-white">{formatCurrentTime()}</span>
      </div>
    </div>
  );
}
