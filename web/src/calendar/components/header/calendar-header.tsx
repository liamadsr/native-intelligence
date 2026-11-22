import { PageTitle } from '@/components/views/page-title'
import { useRef } from "react";
import { Columns, Grid3x3, List, Grid2x2, CalendarRange, Plus, ChevronLeft, ChevronRight, PanelLeftOpen } from "lucide-react";
import { formatDate } from "date-fns";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AccountFilterDropdown } from "@/components/account-filter-dropdown";
import { CardHeaderSlot, useCardHeaderSlots } from "@/components/chat-cards/card-header-slot";
import { CARD_HEADER_ICON_BUTTON, CARD_HEADER_PILL_BUTTON } from "@/components/chat-cards/card-header-button";

import { useCalendar } from "@/calendar/contexts/calendar-context";
import { AddEventDialog } from "@/calendar/components/dialogs/add-event-dialog";
import { CopyAvailabilityButton } from "@/calendar/components/header/copy-availability-button";
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
   * row goes, and only the card's views are offered. The date row's controls
   * are the card header's (CardCalendarHeader), or, where there is no header
   * to hold them, its own row with the account filter and New event. (A
   * record open over the calendar has the header: CardCovered.)
   */
  card?: { compact: boolean; views: readonly TCalendarView[] };
  /** Views the calendar can't show at its current size (the week, when narrow): left out of the switcher. */
  unavailableViews?: readonly TCalendarView[];
  /** The page's sidebar is closed and there is room for it: a button to bring it back. */
  onOpenSidebar?: () => void;
}

const VIEW_BUTTONS: { view: TCalendarView; icon: typeof List; label: string }[] = [
  { view: "day", icon: List, label: "Day" },
  { view: "week", icon: Columns, label: "Week" },
  { view: "month", icon: Grid2x2, label: "Month" },
  { view: "year", icon: Grid3x3, label: "Year" },
  { view: "agenda", icon: CalendarRange, label: "Agenda" },
];

export function CalendarHeader({ view, events, onViewChange, filterAccountIds, onFilterChange, card, unavailableViews, onOpenSidebar }: IProps) {
  const { selectedDate, setSelectedDate } = useCalendar();
  const slots = useCardHeaderSlots();
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

  // In a card's header (Liam, 11-22: a page's controls are its card header's,
  // the page starts with its content): the date row is not drawn.
  if (card && slots) {
    return (
      <CardCalendarHeader
        view={view}
        viewButtons={viewButtons}
        onViewChange={onViewChange}
        label={{ short: `${shortMonth} ${year}`, long: `${month} ${year}`, range: rangeText(view, selectedDate) }}
        onToday={handleToday}
        onPrevious={handlePrevious}
        onNext={handleNext}
        filterAccountIds={filterAccountIds}
        onFilterChange={onFilterChange}
        onOpenSidebar={onOpenSidebar}
      />
    );
  }

  return (
    <>
      {/* Row 1: Main header — title + new event (a card's own header stands in) */}
      {!card && <>
        <div ref={titleRowRef} className={cn("relative flex h-12 shrink-0 items-center gap-2 px-5")}>
          {onOpenSidebar && (
            <Button variant="ghost" size="sm" className="-ml-2 h-7 w-7 shrink-0 rounded-full p-0 text-muted-foreground" onClick={onOpenSidebar} aria-label="Show the sidebar" title="Show the sidebar">
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          )}
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

          <CopyAvailabilityButton />

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
            {card && onOpenSidebar && (
              <Button variant="ghost" size="sm" className="h-7 w-7 shrink-0 rounded-full p-0 text-muted-foreground" onClick={onOpenSidebar} aria-label="Show the sidebar" title="Show the sidebar">
                <PanelLeftOpen className="h-3.5 w-3.5" />
              </Button>
            )}
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
            {card && <CopyAvailabilityButton compact className="hidden @[30rem]/calbar:inline-flex" />}
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

/**
 * The header's controls shed as the card's header narrows: the inline one
 * and the full-screen island beside the rail are both containers
 * (show-tool-card.tsx), so a narrow page keeps its title in view.
 */
const FROM_26 = "hidden @[26rem]:inline-flex";
const FROM_40 = "hidden @[40rem]:inline-flex";
const FROM_44 = "hidden @[44rem]:inline-flex";

/**
 * A calendar card's controls in its header: the date (Today, the arrows, the
 * month), then the account filter, Copy availability, New event and the view
 * switcher at its right end; the sidebar's toggle at its left.
 */
function CardCalendarHeader({
  view,
  viewButtons,
  onViewChange,
  label,
  onToday,
  onPrevious,
  onNext,
  filterAccountIds,
  onFilterChange,
  onOpenSidebar,
}: {
  view: TCalendarView;
  viewButtons: typeof VIEW_BUTTONS;
  onViewChange: (view: TCalendarView) => void;
  label: { short: string; long: string; range: string };
  onToday: () => void;
  onPrevious: () => void;
  onNext: () => void;
  filterAccountIds?: string[] | null;
  onFilterChange?: (accountIds: string[] | null) => void;
  onOpenSidebar?: () => void;
}) {
  const iconButton = cn("grid size-7 shrink-0 place-items-center", CARD_HEADER_ICON_BUTTON);
  return (
    <>
      {onOpenSidebar && (
        <CardHeaderSlot side="left">
          <button type="button" className={iconButton} onClick={onOpenSidebar} aria-label="Show the sidebar" title="Show the sidebar">
            <PanelLeftOpen className="size-3.5" strokeWidth={1.75} />
          </button>
        </CardHeaderSlot>
      )}
      <CardHeaderSlot side="right">
        <div data-calendar-header-controls="" className="flex min-w-0 items-center gap-1">
          <button type="button" className={cn(CARD_HEADER_PILL_BUTTON, FROM_26)} onClick={onToday}>
            Today
          </button>
          <button type="button" className={iconButton} onClick={onPrevious} aria-label="Previous" title="Previous">
            <ChevronLeft className="size-3.5" strokeWidth={1.75} />
          </button>
          <button type="button" className={iconButton} onClick={onNext} aria-label="Next" title="Next">
            <ChevronRight className="size-3.5" strokeWidth={1.75} />
          </button>
          <span data-calendar-header-date="" className="flex min-w-0 items-baseline gap-2 whitespace-nowrap px-1 text-[13px]">
            <span className="font-medium @[36rem]:hidden">{label.short}</span>
            <span className="hidden font-medium @[36rem]:inline">{label.long}</span>
            <span className="hidden text-xs text-muted-foreground @[52rem]:inline">{label.range}</span>
          </span>
          {onFilterChange && (
            <span className={FROM_44}>
              <AccountFilterDropdown
                capability="calendar"
                selectedAccountIds={filterAccountIds ?? null}
                onSelectionChange={onFilterChange}
                triggerClassName="border-transparent bg-foreground/[0.05] shadow-none hover:bg-foreground/[0.1]"
              />
            </span>
          )}
          <CopyAvailabilityButton compact className={cn(CARD_HEADER_ICON_BUTTON, FROM_40)} />
          <AddEventDialog>
            <button type="button" className={iconButton} aria-label="New event" title="New event">
              <Plus className="size-3.5" strokeWidth={1.75} />
            </button>
          </AddEventDialog>
          {/* The views: a capsule of segments, the one in use lifted, as the layout switcher's in every list's header. */}
          <div role="group" aria-label="View" className="flex h-7 shrink-0 items-center overflow-hidden rounded-full bg-foreground/[0.05]">
            {viewButtons.map((btn) => {
              const Icon = btn.icon;
              return (
                <button
                  key={btn.view}
                  type="button"
                  onClick={() => onViewChange(btn.view)}
                  aria-label={btn.label}
                  title={btn.label}
                  aria-pressed={view === btn.view}
                  className="flex h-full w-8 items-center justify-center text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:bg-foreground/[0.1] aria-pressed:text-foreground motion-reduce:transition-none"
                >
                  <Icon className="size-3.5" strokeWidth={1.75} aria-hidden />
                </button>
              );
            })}
          </div>
        </div>
      </CardHeaderSlot>
    </>
  );
}
