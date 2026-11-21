"use client";

/**
 * The sidebar's month picker: a small month whose days move the calendar.
 * Today is outlined, the day the grid is at is filled, and in the week view
 * the whole week on screen is shaded. The arrows page the picker alone; the
 * grid moves when a day is chosen. The picker follows the grid when the grid
 * is moved from elsewhere (the header's arrows, Today).
 */
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { inShownWeek, isSameDate, monthWeeks, shiftMonth } from "@/calendar/sidebar/month-grid";

import type { TCalendarView } from "@/calendar/types";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function MiniMonth({
  selectedDate,
  view,
  onSelect,
  today,
}: {
  selectedDate: Date;
  view: TCalendarView;
  onSelect: (date: Date) => void;
  /** Today (tests pass their own). */
  today?: Date;
}) {
  const [month, setMonth] = useState(() => shiftMonth(selectedDate, 0));
  const selectedMonth = selectedDate.getFullYear() * 12 + selectedDate.getMonth();
  useEffect(() => {
    setMonth(new Date(Math.floor(selectedMonth / 12), selectedMonth % 12, 1));
  }, [selectedMonth]);

  const weeks = useMemo(() => monthWeeks(month), [month]);
  const now = today ?? new Date();
  const title = month.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  return (
    <div data-mini-month="" className="select-none px-1">
      <div className="flex items-center justify-between pb-1.5 pl-2">
        <span className="text-xs font-medium" aria-live="polite">
          {title}
        </span>
        <div className="flex items-center">
          <button
            type="button"
            aria-label="Go to previous month"
            onClick={() => setMonth((m) => shiftMonth(m, -1))}
            className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Go to next month"
            onClick={() => setMonth((m) => shiftMonth(m, 1))}
            className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <table className="w-full table-fixed border-collapse text-center" aria-label={title}>
        <thead>
          <tr>
            {WEEKDAYS.map((letter, i) => (
              <th key={i} scope="col" abbr={WEEKDAY_NAMES[i]} className="h-6 text-[10px] font-normal text-muted-foreground">
                {letter}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0].date.toISOString()}>
              {week.map(({ date, inMonth }, i) => {
                const selected = isSameDate(date, selectedDate);
                const isToday = isSameDate(date, now);
                const inWeek = inShownWeek(date, selectedDate, view);
                return (
                  <td key={i} className={cn("p-0", inWeek && "bg-foreground/[0.07]", inWeek && i === 0 && "rounded-l-full", inWeek && i === 6 && "rounded-r-full")} data-in-week={inWeek ? "" : undefined}>
                    <button
                      type="button"
                      onClick={() => onSelect(date)}
                      aria-label={date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                      aria-pressed={selected}
                      aria-current={isToday ? "date" : undefined}
                      data-day={`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`}
                      className={cn(
                        "mx-auto flex h-7 w-7 items-center justify-center rounded-full text-xs tabular-nums transition-colors",
                        selected
                          ? "bg-foreground font-medium text-background"
                          : cn("hover:bg-muted", !inMonth && "text-muted-foreground/60", isToday && "font-semibold ring-1 ring-inset ring-foreground/50"),
                      )}
                    >
                      {date.getDate()}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
