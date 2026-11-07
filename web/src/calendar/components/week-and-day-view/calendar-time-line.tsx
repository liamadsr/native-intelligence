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
    return format(currentTime, "h:mm a");
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

  const dotLeftPercent = (todayColumnIndex / columnCount) * 100;

  return (
    <div data-calendar-timeline className="pointer-events-none absolute inset-x-0 z-10 border-t border-primary" style={{ top: `${getCurrentTimePosition()}%` }}>
      <div className="absolute top-0 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary" style={{ left: `${dotLeftPercent}%` }}></div>
      <div className="absolute -left-18 flex w-16 -translate-y-1/2 justify-end bg-background pr-1 text-xs font-medium text-primary">{formatCurrentTime()}</div>
    </div>
  );
}
