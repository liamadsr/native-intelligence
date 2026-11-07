import { PageTitle } from '@/components/views/page-title'
import { useRef } from "react";
import { Columns, Grid3x3, List, Grid2x2, CalendarRange, Plus, ChevronLeft, ChevronRight } from "lucide-react";
import { formatDate } from "date-fns";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AccountFilterDropdown } from "@/components/account-filter-dropdown";

import { useCalendar } from "@/calendar/contexts/calendar-context";
import { AddEventDialog } from "@/calendar/components/dialogs/add-event-dialog";
import { navigateDate, rangeText } from "@/calendar/helpers";

import type { IEvent } from "@/calendar/interfaces";
import type { TCalendarView } from "@/calendar/types";

interface IProps {
  view: TCalendarView;
  events: IEvent[];
  onViewChange: (view: TCalendarView) => void;
  filterAccountIds?: string[] | null;
  onFilterChange?: (accountIds: string[] | null) => void;
  /**
   * A chat card: the card's own header is its title, so the window's title
   * row goes; the account filter and New event move into the date row, and
   * only the card's views are offered.
   */
  card?: { compact: boolean; views: readonly TCalendarView[] };
  /** Views the calendar can't show at its current size (the week, when narrow): left out of the switcher. */
  unavailableViews?: readonly TCalendarView[];
}

const VIEW_BUTTONS: { view: TCalendarView; icon: typeof List; label: string }[] = [
  { view: "day", icon: List, label: "Day" },
  { view: "week", icon: Columns, label: "Week" },
  { view: "month", icon: Grid2x2, label: "Month" },
  { view: "year", icon: Grid3x3, label: "Year" },
  { view: "agenda", icon: CalendarRange, label: "Agenda" },
];

export function CalendarHeader({ view, events, onViewChange, filterAccountIds, onFilterChange, card, unavailableViews }: IProps) {
  const { selectedDate, setSelectedDate } = useCalendar();
  // In a floating content window, the title row carries the window's close button.
  const titleRowRef = useRef<HTMLDivElement>(null);

  const month = formatDate(selectedDate, "MMMM");
  const shortMonth = formatDate(selectedDate, "MMM");
  const year = selectedDate.getFullYear();

  const handlePrevious = () => setSelectedDate(navigateDate(selectedDate, view, "previous"));
  const handleNext = () => setSelectedDate(navigateDate(selectedDate, view, "next"));
  const handleToday = () => setSelectedDate(new Date());

  const viewButtons = VIEW_BUTTONS.filter(
    (b) => (!card || card.views.includes(b.view) || b.view === view) && !unavailableViews?.includes(b.view),
  );

  return (
    <>
      {/* Row 1: Main header — title + new event (a card's own header stands in) */}
      {!card && <>
        <div ref={titleRowRef} className={cn("relative flex h-12 shrink-0 items-center gap-2 px-5")}>
          <PageTitle label="Events" as="h2" />
          {onFilterChange && (
            <div className="ml-3">
              <AccountFilterDropdown
                capability="calendar"
                selectedAccountIds={filterAccountIds ?? null}
                onSelectionChange={onFilterChange}
              />
            </div>
          )}

          <div className="flex-1" />

          <AddEventDialog>
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs">
              <Plus className="h-3.5 w-3.5" />
              New event
            </Button>
          </AddEventDialog>
        </div>
      </>}

      {/* Row 2: Date nav (left) + view switcher pills (right) — no border.
          Sized by its OWN width (a container), not the viewport's: the same
          row sits in a chat card, full screen, and on a phone. It never wraps
          or spills; as it narrows it sheds what matters least (Liam, 10-25):
            < 40rem  the date range goes (the month stays)
            < 30rem  "October" → "Oct", the view pills drop their label, the
                     account filter / Connect goes (Settings has it)
            < 24rem  the gaps tighten
            < 20rem  Today goes (the arrows still step), so the month keeps
                     its room on the smallest phones */}
      <div className={cn("@container/calbar shrink-0 px-3", card?.compact ? "h-9" : "h-10")}>
        <div className="flex h-full min-w-0 items-center gap-2">
          {/* Left: today + prev/next + date label */}
          <div className="flex min-w-0 items-center gap-0.5 @[24rem]/calbar:gap-1">
            <Button variant="ghost" size="sm" className="hidden h-7 shrink-0 rounded-full px-2.5 text-xs @[20rem]/calbar:inline-flex" onClick={handleToday}>
              Today
            </Button>

            <Button variant="ghost" size="sm" className="h-7 w-7 shrink-0 rounded-full p-0" onClick={handlePrevious} aria-label="Previous">
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="sm" className="h-7 w-7 shrink-0 rounded-full p-0" onClick={handleNext} aria-label="Next">
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>

            <div className="ml-1 flex min-w-0 items-baseline gap-2 whitespace-nowrap">
              <span className="truncate text-sm font-medium">
                <span className="@[30rem]/calbar:hidden">{shortMonth} {year}</span>
                <span className="hidden @[30rem]/calbar:inline">{month} {year}</span>
              </span>
              <span className="hidden truncate text-xs text-muted-foreground @[40rem]/calbar:inline">
                {rangeText(view, selectedDate)}
              </span>
            </div>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {card && onFilterChange && (
              <div className="hidden @[30rem]/calbar:block">
                <AccountFilterDropdown capability="calendar" selectedAccountIds={filterAccountIds ?? null} onSelectionChange={onFilterChange} />
              </div>
            )}
            {card && (
              <AddEventDialog>
                <Button variant="ghost" size="sm" className="h-7 w-7 shrink-0 rounded-full p-0" aria-label="New event">
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </AddEventDialog>
            )}

            {/* Right: view switcher pills */}
            <div className="flex items-center gap-0.5 @[24rem]/calbar:gap-1">
              {viewButtons.map((btn) => {
                const isActive = view === btn.view;
                const Icon = btn.icon;

                return (
                  <button
                    key={btn.view}
                    onClick={() => onViewChange(btn.view)}
                    aria-label={btn.label}
                    title={btn.label}
                    aria-pressed={isActive}
                    className={cn(
                      "flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-sm transition-colors",
                      isActive
                        ? "bg-foreground/10 font-medium text-foreground @[30rem]/calbar:px-3"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
                    {isActive && <span className="hidden @[30rem]/calbar:inline">{btn.label}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
