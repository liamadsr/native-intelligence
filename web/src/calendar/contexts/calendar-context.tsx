"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { isEventPending } from "@/calendar/hooks/use-update-event";

import type { Dispatch, SetStateAction } from "react";
import type { IEvent } from "@/calendar/interfaces";
import type { TBadgeVariant, TVisibleHours, TWorkingHours } from "@/calendar/types";

export interface EventDraft {
  title: string;
  start: Date;
  end: Date;
  description: string;
  location: string;
}

export interface DraftPopover {
  /** The draft event form state */
  draft: EventDraft;
  /** The anchor element the popover should position near */
  anchorEl: HTMLElement | null;
}

// The context is split by change frequency so hot state doesn't fan out to the
// whole grid (hundreds of cells and event blocks subscribe):
//   mutators — function refs, identity-stable for the provider's lifetime
//   settings — badge variant + hour config, effectively static
//   data     — events / selected date / selected action: real data changes
//   draft    — quick-add popover state, changes per keystroke (2 consumers)
// useCalendar() composes mutators+settings+data; the draft context is
// deliberately excluded so only useCalendarDraft() subscribers pay for typing.

interface ICalendarMutators {
  setSelectedDate: (date: Date | undefined) => void;
  setBadgeVariant: (variant: TBadgeVariant) => void;
  setWorkingHours: Dispatch<SetStateAction<TWorkingHours>>;
  setVisibleHours: Dispatch<SetStateAction<TVisibleHours>>;
  setLocalEvents: Dispatch<SetStateAction<IEvent[]>>;
  setSelectedActionId: (id: string | null) => void;
  selectEvent: (event: IEvent) => void;
  /** Open the quick-add popover near an anchor element. If a draft already exists with content, the time is updated but title/description/location are preserved. */
  openEventPopover: (anchorEl: HTMLElement | null, start: Date, end: Date) => void;
  /** Close the popover and discard the draft */
  closeEventPopover: (suppress?: boolean) => void;
  /** Update the draft form state */
  setDraftPopover: Dispatch<SetStateAction<DraftPopover | null>>;
}

interface ICalendarSettings {
  badgeVariant: TBadgeVariant;
  workingHours: TWorkingHours;
  visibleHours: TVisibleHours;
}

interface ICalendarData {
  selectedDate: Date;
  events: IEvent[];
  selectedActionId: string | null;
}

export type ICalendarContext = ICalendarData & ICalendarSettings & ICalendarMutators;

const MutatorsContext = createContext<ICalendarMutators | null>(null);
const SettingsContext = createContext<ICalendarSettings | null>(null);
const DataContext = createContext<ICalendarData | null>(null);
// `null` is a valid value (popover closed), so "no provider" is `undefined`.
const DraftContext = createContext<DraftPopover | null | undefined>(undefined);

const WORKING_HOURS = {
  0: { from: 0, to: 0 },
  1: { from: 8, to: 17 },
  2: { from: 8, to: 17 },
  3: { from: 8, to: 17 },
  4: { from: 8, to: 17 },
  5: { from: 8, to: 17 },
  6: { from: 8, to: 12 },
};

const VISIBLE_HOURS = { from: 0, to: 24 };

export function CalendarProvider({
  children,
  events,
  onSelectAction,
  onSelectEvent,
  initialDate,
  onSelectedDateChange,
}: {
  children: React.ReactNode;
  events: IEvent[];
  onSelectAction?: (actionId: string) => void;
  onSelectEvent?: (event: IEvent) => void;
  /** Where the grid opens (a chat card's own date); today when absent. Read at mount. */
  initialDate?: Date;
  /** The person moved the date (a chat card keeps it). */
  onSelectedDateChange?: (date: Date) => void;
}) {
  const [badgeVariant, setBadgeVariant] = useState<TBadgeVariant>("colored");
  const [visibleHours, setVisibleHours] = useState<TVisibleHours>(VISIBLE_HOURS);
  const [workingHours, setWorkingHours] = useState<TWorkingHours>(WORKING_HOURS);

  const [selectedDate, setSelectedDate] = useState(() => initialDate ?? new Date());

  const [localEvents, setLocalEvents] = useState<IEvent[]>(events);
  const [selectedActionId, setSelectedActionIdRaw] = useState<string | null>(null);
  const [draftPopover, setDraftPopover] = useState<DraftPopover | null>(null);

  // Resync local events when a fresh fetch supersedes them. `localEvents` is
  // seeded once and then mutated in place by optimistic helpers (useUpdateEvent);
  // without this, a re-fetch (poll, realtime bus, workspace switch) that updates
  // the `events` prop would never reach the grid. The fetch keys on prop identity,
  // and useCalendarEvents produces a new array only on a real fetch (cached
  // identity is stable across re-renders). A slightly-stale fetch can land mid
  // drag/reschedule, though, so for ids with an in-flight optimistic edit
  // (isEventPending) we keep the local version rather than clobber the user's
  // move — the pending flag is cleared the moment the write resolves/rejects.
  const prevEventsRef = useRef(events);
  useEffect(() => {
    if (prevEventsRef.current !== events) {
      prevEventsRef.current = events;
      setLocalEvents((prev) => {
        const localById = new Map(prev.map((e) => [e.id, e]));
        return events.map((e) => (isEventPending(e.id) ? localById.get(e.id) ?? e : e));
      });
    }
  }, [events]);

  const suppressOpenRef = useRef(false);

  const openEventPopover = useCallback((anchorEl: HTMLElement | null, start: Date, end: Date) => {
    if (suppressOpenRef.current) return;
    setDraftPopover((prev) => {
      const hasDirtyContent = prev && (prev.draft.title.trim() || prev.draft.description.trim() || prev.draft.location.trim());
      if (hasDirtyContent) {
        // Preserve user input, update time + anchor
        return { anchorEl, draft: { ...prev.draft, start, end } };
      }
      // Fresh draft
      return { anchorEl, draft: { title: "", start, end, description: "", location: "" } };
    });
  }, []);

  const closeEventPopover = useCallback((suppress = false) => {
    setDraftPopover(null);
    if (suppress) {
      suppressOpenRef.current = true;
      setTimeout(() => { suppressOpenRef.current = false; }, 0);
    }
  }, []);

  // The select callbacks come in as props; route them through refs so the
  // mutators object can stay identity-stable for the provider's lifetime.
  const onSelectActionRef = useRef(onSelectAction);
  onSelectActionRef.current = onSelectAction;
  const onSelectEventRef = useRef(onSelectEvent);
  onSelectEventRef.current = onSelectEvent;

  const setSelectedActionId = useCallback((id: string | null) => {
    setSelectedActionIdRaw(id);
    if (id && onSelectActionRef.current) {
      onSelectActionRef.current(id);
    }
  }, []);

  const selectEvent = useCallback((event: IEvent) => {
    if (event.isAction && event.actionId) {
      setSelectedActionId(event.actionId);
    } else if (onSelectEventRef.current) {
      onSelectEventRef.current(event);
    }
  }, [setSelectedActionId]);

  const onSelectedDateChangeRef = useRef(onSelectedDateChange);
  onSelectedDateChangeRef.current = onSelectedDateChange;
  const handleSelectDate = useCallback((date: Date | undefined) => {
    if (!date) return;
    setSelectedDate(date);
    onSelectedDateChangeRef.current?.(date);
  }, []);

  const mutators = useMemo<ICalendarMutators>(
    () => ({
      setSelectedDate: handleSelectDate,
      setBadgeVariant,
      setWorkingHours,
      setVisibleHours,
      setLocalEvents,
      setSelectedActionId,
      selectEvent,
      openEventPopover,
      closeEventPopover,
      setDraftPopover,
    }),
    [handleSelectDate, setSelectedActionId, selectEvent, openEventPopover, closeEventPopover],
  );

  const settings = useMemo<ICalendarSettings>(
    () => ({ badgeVariant, workingHours, visibleHours }),
    [badgeVariant, workingHours, visibleHours],
  );

  const data = useMemo<ICalendarData>(
    () => ({ selectedDate, events: localEvents, selectedActionId }),
    [selectedDate, localEvents, selectedActionId],
  );

  return (
    <MutatorsContext.Provider value={mutators}>
      <SettingsContext.Provider value={settings}>
        <DataContext.Provider value={data}>
          <DraftContext.Provider value={draftPopover}>{children}</DraftContext.Provider>
        </DataContext.Provider>
      </SettingsContext.Provider>
    </MutatorsContext.Provider>
  );
}

/** Stable mutation callbacks — subscribing to these never causes a re-render. */
export function useCalendarMutators(): ICalendarMutators {
  const context = useContext(MutatorsContext);
  if (!context) throw new Error("useCalendarMutators must be used within a CalendarProvider.");
  return context;
}

/** Badge variant + hour config; effectively static. For hot leaf components. */
export function useCalendarSettings(): ICalendarSettings {
  const context = useContext(SettingsContext);
  if (!context) throw new Error("useCalendarSettings must be used within a CalendarProvider.");
  return context;
}

/** Quick-add popover state. Changes on every keystroke — subscribe sparingly. */
export function useCalendarDraft(): DraftPopover | null {
  const context = useContext(DraftContext);
  if (context === undefined) throw new Error("useCalendarDraft must be used within a CalendarProvider.");
  return context;
}

export function useCalendar(): ICalendarContext {
  const mutators = useContext(MutatorsContext);
  const settings = useContext(SettingsContext);
  const data = useContext(DataContext);
  if (!mutators || !settings || !data) throw new Error("useCalendar must be used within a CalendarProvider.");
  return useMemo(() => ({ ...data, ...settings, ...mutators }), [data, settings, mutators]);
}
