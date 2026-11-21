"use client";

/**
 * The Calendar page's sidebar: a month picker, the next few events, and the
 * calendars on the page with a checkbox each to show or hide them.
 *
 *  - The month picker moves the grid to the day clicked (mini-month.tsx).
 *  - "Upcoming events" is from now, whatever date the grid is at
 *    (sidebar/upcoming.ts): a row opens the event, as clicking it in the grid
 *    does, and moves the grid to its day.
 *  - "Calendars" (only with more than one) lists them by account
 *    (sidebar/calendar-visibility.ts). An account's own checkbox shows or
 *    hides all of its calendars. A hidden calendar leaves the grid and the
 *    upcoming list both; the choice is kept in this browser.
 *
 * The Calendar page and its window, never the slim calendar card inline in a
 * chat, and only where the calendar is wide enough (client-container.tsx).
 * In the window the grid holds only the range on screen, so the upcoming list
 * is given its own events (today and the month ahead). Behaviour after Macro's
 * calendar sidebar (AGPL-3.0); the code is our own.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, PanelLeftClose } from "lucide-react";

import { cn } from "@/lib/utils";
import { useCalendar } from "@/calendar/contexts/calendar-context";
import { MiniMonth } from "@/calendar/components/sidebar/mini-month";
import { accountVisibility, toggleAccount, toggleCalendar, type SidebarAccount } from "@/calendar/sidebar/calendar-visibility";
import { eventStart, upcomingEvents, upcomingLabel } from "@/calendar/sidebar/upcoming";

import type { IEvent } from "@/calendar/interfaces";
import type { TCalendarView } from "@/calendar/types";

export interface CalendarSidebarProps {
  view: TCalendarView;
  /** Every calendar on the page, hidden ones included. */
  accounts: SidebarAccount[];
  hidden: ReadonlySet<string>;
  onHiddenChange: (hidden: Set<string>) => void;
  /** The events the upcoming list reads; absent: the grid's own. Already without hidden calendars. */
  upcomingFrom?: IEvent[];
  onClose: () => void;
  /** Now (tests pass their own). */
  now?: Date;
}

/** The clock, to the minute: "Now" and "Tomorrow" stay true while the page sits open. */
function useMinute(fixed?: Date): Date {
  const [now, setNow] = useState(() => fixed ?? new Date());
  useEffect(() => {
    if (fixed) return;
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, [fixed]);
  return fixed ?? now;
}

function Section({ title, children, name }: { title: string; name: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section data-sidebar-section={name} className="border-t border-border/60 px-2 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-md px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
      >
        {title}
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !open && "-rotate-90")} />
      </button>
      {open && <div className="pt-1">{children}</div>}
    </section>
  );
}

function Swatch({ color, hidden }: { color: IEvent["color"]; hidden?: boolean }) {
  return <span aria-hidden className={cn("size-2.5 shrink-0 rounded-[3px] cal-dot", `cal-${color}`, hidden && "opacity-30")} />;
}

function Check({ checked, indeterminate, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: (checked: boolean) => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={label}
      className="size-3.5 shrink-0 cursor-pointer rounded accent-foreground"
    />
  );
}

export function CalendarSidebar({ view, accounts, hidden, onHiddenChange, upcomingFrom, onClose, now: fixedNow }: CalendarSidebarProps) {
  const { selectedDate, setSelectedDate, events, selectEvent } = useCalendar();
  const now = useMinute(fixedNow);
  const upcoming = useMemo(() => upcomingEvents(upcomingFrom ?? events, now), [upcomingFrom, events, now]);
  const calendarCount = accounts.reduce((n, a) => n + a.calendars.length, 0);

  const openEvent = (event: IEvent) => {
    const start = eventStart(event);
    // An event already under way stays on today; a later one brings its day up.
    setSelectedDate(start > now ? start : now);
    selectEvent(event);
  };

  return (
    <aside data-calendar-sidebar="" aria-label="Calendar sidebar" className="flex h-full w-60 shrink-0 flex-col overflow-hidden border-r border-border/60">
      <div className="flex h-12 shrink-0 items-center justify-between pl-4 pr-2">
        <span className="text-sm font-medium">Calendar</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Hide the sidebar"
          title="Hide the sidebar"
          className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        <div className="px-2 pb-3">
          <MiniMonth selectedDate={selectedDate} view={view} onSelect={setSelectedDate} today={now} />
        </div>

        <Section title="Upcoming events" name="upcoming">
          {upcoming.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">No upcoming events</p>
          ) : (
            <ul>
              {upcoming.map((event) => (
                <li key={event.id}>
                  <button
                    type="button"
                    data-upcoming-event={event.id}
                    onClick={() => openEvent(event)}
                    title={event.title}
                    className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
                  >
                    <span className="flex h-4 items-center">
                      <Swatch color={event.color} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{event.title || "(no title)"}</span>
                      <span className="block truncate tabular-nums text-muted-foreground">{upcomingLabel(event, now)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {calendarCount > 1 && (
          <Section title="Calendars" name="calendars">
            <ul className="space-y-1.5">
              {accounts.map((account) => {
                const state = accountVisibility(account, hidden);
                return (
                  <li key={account.id || "local"} data-sidebar-account={account.id || "local"}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs font-medium hover:bg-muted" title={account.label}>
                      <Check
                        checked={state !== "none"}
                        indeterminate={state === "some"}
                        onChange={(show) => onHiddenChange(toggleAccount(hidden, account, show))}
                        label={`${state === "none" ? "Show" : "Hide"} every calendar of ${account.label}`}
                      />
                      <span className="min-w-0 flex-1 truncate">{account.label}</span>
                    </label>
                    <ul>
                      {account.calendars.map((calendar) => {
                        const isHidden = hidden.has(calendar.key);
                        return (
                          <li key={calendar.key}>
                            <label
                              data-sidebar-calendar={calendar.key}
                              className={cn("flex cursor-pointer items-center gap-2 rounded-md py-1 pl-5 pr-2 text-xs hover:bg-muted", isHidden && "text-muted-foreground")}
                              title={calendar.name}
                            >
                              <Check
                                checked={!isHidden}
                                onChange={(show) => onHiddenChange(toggleCalendar(hidden, calendar.key, show))}
                                label={`${isHidden ? "Show" : "Hide"} ${calendar.name}`}
                              />
                              <Swatch color={calendar.color} hidden={isHidden} />
                              <span className="min-w-0 flex-1 truncate">{calendar.name}</span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                );
              })}
            </ul>
          </Section>
        )}
      </div>
    </aside>
  );
}
