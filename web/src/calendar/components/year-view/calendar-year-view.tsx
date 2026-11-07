import { useMemo } from "react";
import { addMonths, startOfYear } from "date-fns";

import { useCalendar } from "@/calendar/contexts/calendar-context";

import { ScrollArea } from "@/components/ui/scroll-area";
import { YearViewMonth } from "@/calendar/components/year-view/year-view-month";
import { buildEventsByDay } from "@/calendar/helpers";

import type { IEvent } from "@/calendar/interfaces";

interface IProps {
  allEvents: IEvent[];
}

export function CalendarYearView({ allEvents }: IProps) {
  const { selectedDate } = useCalendar();

  const months = useMemo(() => {
    const yearStart = startOfYear(selectedDate);
    return Array.from({ length: 12 }, (_, i) => addMonths(yearStart, i));
  }, [selectedDate]);

  // Built once for the whole year and shared by all 12 months. Previously each
  // of the ~365 day cells filtered the entire event list with two parseISO
  // calls per event — ~150k date parses per render on a 200-event window, which
  // is what made year-view navigation take ~200ms+ of blocking main-thread work.
  const eventsByDay = useMemo(() => buildEventsByDay(allEvents), [allEvents]);

  return (
    <ScrollArea className="flex-1" type="always">
      <div className="p-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {months.map(month => (
            <YearViewMonth key={month.toString()} month={month} eventsByDay={eventsByDay} />
          ))}
        </div>
      </div>
    </ScrollArea>
  );
}
