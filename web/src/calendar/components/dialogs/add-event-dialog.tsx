"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { format } from "date-fns";
import { Clock, MapPin, AlignLeft, Loader2, X, CalendarDays } from "lucide-react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DateTimePicker } from "@/components/ui/datetime-picker";

import { useCalendar, useCalendarDraft, useCalendarMutators } from "@/calendar/contexts/calendar-context";
import { calendarEventToIEvent } from "@/calendar/adapters";
import { patchCalendarEventsCache } from "@/calendar/hooks/use-calendar-events";
import { isDesktopApp } from "@/lib/platform";

import type { CalendarEvent } from "@/lib/integrations/calendar";

interface CalendarOption {
  id: string;
  name: string;
  accountName: string;
  color: string;
  type: "oauth" | "local_exchange";
  accountId?: string;
}

const STORAGE_KEY_DEFAULT_CALENDAR = "ni:default-calendar-id";

// The writable-calendars list changes only when an account is (dis)connected,
// but /api/calendar/calendars fans out to live provider APIs — far too slow to
// re-pay on every calendar mount. Module-level cache, refreshed after a TTL.
let cachedCalendarOptions: CalendarOption[] | null = null;
let cachedCalendarOptionsAt = 0;
const CALENDAR_OPTIONS_TTL_MS = 5 * 60_000;

async function loadCalendarOptions(): Promise<CalendarOption[]> {
  if (cachedCalendarOptions && Date.now() - cachedCalendarOptionsAt < CALENDAR_OPTIONS_TTL_MS) {
    return cachedCalendarOptions;
  }
  const options: CalendarOption[] = [];

  // Fetch OAuth calendars
  try {
    const res = await fetch("/api/calendar/calendars");
    if (res.ok) {
      const data = await res.json();
      for (const account of data.accounts || []) {
        if (!account.is_visible) continue;
        const visibleCals = (account.calendars || []).filter(
          (cal: { is_visible: boolean }) => cal.is_visible,
        );

        if (visibleCals.length > 0) {
          for (const cal of visibleCals) {
            options.push({
              id: `oauth:${account.id}:${cal.id}`,
              name: cal.name || cal.summary,
              accountName: account.display_name || account.account_email,
              color: cal.color || account.color || "#3b82f6",
              type: "oauth",
              accountId: account.id,
            });
          }
        } else {
          // Fallback: show the account itself when sub-calendars aren't available
          const providerLabel = account.provider === "google" ? "Google Calendar" : "Outlook Calendar";
          options.push({
            id: `oauth:${account.id}:primary`,
            name: providerLabel,
            accountName: account.display_name || account.account_email,
            color: account.color || "#3b82f6",
            type: "oauth",
            accountId: account.id,
          });
        }
      }
    }
  } catch {
    // silently fail
  }

  // Fetch local Exchange calendars (desktop only)
  if (isDesktopApp()) {
    try {
      const { tauriBridge } = await import("@/lib/tauri-bridge");
      const status = await tauriBridge.getLocalCalendarStatus();
      if (status.hasAccess) {
        let disabledIds = new Set<string>();
        try {
          const stored = localStorage.getItem("ni:local-exchange:disabled-calendars");
          if (stored) disabledIds = new Set(JSON.parse(stored));
        } catch { /* ignore */ }

        for (const cal of status.exchangeCalendars) {
          if (disabledIds.has(cal.id)) continue;
          options.push({
            id: `local:${cal.id}`,
            name: cal.title,
            accountName: `${cal.accountName} (Local)`,
            color: cal.color,
            type: "local_exchange",
          });
        }
      }
    } catch {
      // sidecar not available
    }
  }

  cachedCalendarOptions = options;
  cachedCalendarOptionsAt = Date.now();
  return options;
}

/**
 * AddEventPopover — a single floating popover rendered via portal.
 * Reads from the calendar context's draftPopover state and positions itself near the anchor element.
 * Mount this once at the calendar view level.
 */
export function AddEventPopover() {
  const { setDraftPopover, closeEventPopover, setLocalEvents } = useCalendarMutators();
  const draftPopover = useCalendarDraft();
  const popoverRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const [showLocation, setShowLocation] = useState(false);
  const [showDescription, setShowDescription] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [calendars, setCalendars] = useState<CalendarOption[]>(() => cachedCalendarOptions ?? []);
  const [selectedCalendarId, setSelectedCalendarId] = useState<string | null>(null);
  const [showCalendarPicker, setShowCalendarPicker] = useState(false);

  const draft = draftPopover?.draft;
  const anchorEl = draftPopover?.anchorEl;

  // Load available calendars on mount (module-cached — see loadCalendarOptions)
  useEffect(() => {
    let cancelled = false;
    loadCalendarOptions().then((options) => {
      if (cancelled) return;
      setCalendars(options);

      // Restore last-used calendar or default to first
      const savedId = localStorage.getItem(STORAGE_KEY_DEFAULT_CALENDAR);
      if (savedId && options.some((c) => c.id === savedId)) {
        setSelectedCalendarId(savedId);
      } else if (options.length > 0) {
        setSelectedCalendarId(options[0].id);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Calculate position whenever anchor changes
  useEffect(() => {
    if (!anchorEl) {
      setPosition(null);
      return;
    }

    const update = () => {
      const rect = anchorEl.getBoundingClientRect();
      const popoverWidth = 380;
      const popoverHeight = 340;
      const anchorCenter = rect.left + rect.width / 2;
      const screenMidpoint = window.innerWidth / 2;

      let top = rect.top;
      let left: number;

      if (anchorCenter < screenMidpoint) {
        left = rect.right + 8;
      } else {
        left = rect.left - popoverWidth - 8;
      }

      if (left + popoverWidth > window.innerWidth - 16) {
        left = window.innerWidth - popoverWidth - 16;
      }
      if (left < 16) left = 16;
      if (top + popoverHeight > window.innerHeight - 16) {
        top = window.innerHeight - popoverHeight - 16;
      }
      if (top < 16) top = 16;

      setPosition({ top, left });
    };

    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [anchorEl]);

  // Reset expanded fields when popover opens fresh
  useEffect(() => {
    if (draftPopover && !draftPopover.draft.location) setShowLocation(false);
    if (draftPopover && !draftPopover.draft.description) setShowDescription(false);
    setShowCalendarPicker(false);
  }, [draftPopover?.anchorEl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle click outside
  useEffect(() => {
    if (!draftPopover) return;

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (popoverRef.current?.contains(target)) return;
      if (target.closest("[data-radix-popper-content-wrapper]")) return;
      if (target.closest("[role='listbox']")) return;
      if (target.closest("[data-radix-select-viewport]")) return;

      const isDirty = draftPopover.draft.title.trim() || draftPopover.draft.description.trim() || draftPopover.draft.location.trim();

      if (!isDirty) {
        // Empty form — close and suppress the time slot click from reopening
        closeEventPopover(true);
      } else {
        // Dirty form — only keep open if clicking inside the calendar grid
        const clickedTimeSlot = target.closest("[data-day-column]");
        if (!clickedTimeSlot) {
          closeEventPopover();
        }
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener("pointerdown", handlePointerDown, true);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [draftPopover, closeEventPopover]);

  const updateDraft = useCallback(
    (partial: Partial<typeof draft>) => {
      setDraftPopover((prev) => (prev ? { ...prev, draft: { ...prev.draft, ...partial } } : null));
    },
    [setDraftPopover],
  );

  const selectedCalendar = calendars.find((c) => c.id === selectedCalendarId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft?.title.trim() || saving) return;
    setSaving(true);

    // Remember the selected calendar for next time
    if (selectedCalendarId) {
      localStorage.setItem(STORAGE_KEY_DEFAULT_CALENDAR, selectedCalendarId);
    }

    try {
      if (selectedCalendar?.type === "local_exchange") {
        // Create via Tauri bridge (EventKit)
        const localCalId = selectedCalendarId!.replace("local:", "");
        const { tauriBridge } = await import("@/lib/tauri-bridge");
        const result = await tauriBridge.createLocalExchangeEvent({
          calendarId: localCalId,
          title: draft.title.trim(),
          start: draft.start.toISOString(),
          end: draft.end.toISOString(),
          location: draft.location.trim() || undefined,
          notes: draft.description.trim() || undefined,
        });

        if (result.success && result.eventId) {
          const newEvent = calendarEventToIEvent({
            id: result.eventId,
            title: draft.title.trim(),
            start: draft.start.toISOString(),
            end: draft.end.toISOString(),
            location: draft.location.trim() || undefined,
            description: draft.description.trim() || undefined,
            calendarName: selectedCalendar.name,
            calendarId: localCalId,
            source: "local_exchange",
          });
          setLocalEvents((prev) => [...prev, newEvent]);
          patchCalendarEventsCache((prev) => [...prev, newEvent]);
          closeEventPopover();
        }
      } else {
        // Create via server API (OAuth)
        const res = await fetch("/api/calendar/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: draft.title.trim(),
            start: draft.start.toISOString(),
            end: draft.end.toISOString(),
            description: draft.description.trim() || undefined,
            location: draft.location.trim() || undefined,
            accountId: selectedCalendar?.accountId,
          }),
        });

        if (res.ok) {
          const data = await res.json();
          const newEvent = calendarEventToIEvent(data.event as CalendarEvent);
          setLocalEvents((prev) => [...prev, newEvent]);
          patchCalendarEventsCache((prev) => [...prev, newEvent]);
          closeEventPopover();
        }
      }
    } finally {
      setSaving(false);
    }
  };

  if (!draftPopover || !draft || !position) return null;

  const dayStr = format(draft.start, "EEEE, MMMM d");

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed z-50 w-[380px] animate-in fade-in-0 zoom-in-95 rounded-2xl border border-border bg-popover shadow-xl"
      style={{ top: position.top, left: position.left }}
    >
      <form onSubmit={handleSubmit}>
        {/* Header with close */}
        <div className="flex items-center justify-end px-3 pt-3">
          <button
            type="button"
            onClick={() => closeEventPopover()}
            className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Title input */}
        <div className="px-5 pb-4">
          <input
            type="text"
            placeholder="Add title"
            value={draft.title}
            onChange={(e) => updateDraft({ title: e.target.value })}
            autoFocus
            className="w-full border-0 border-b-2 border-transparent bg-transparent pb-1.5 text-xl font-normal text-foreground placeholder:text-muted-foreground/60 outline-none focus:border-primary"
          />
        </div>

        {/* Date & time row */}
        <div className="flex items-start gap-3 px-5 py-2.5">
          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="flex-1 space-y-2">
            <p className="text-sm text-foreground">{dayStr}</p>
            <div className="flex items-center gap-1.5 text-sm">
              <DateTimePicker
                value={draft.start}
                onChange={(d) => d && updateDraft({ start: d })}
                granularity="minute"
                hourCycle={12}
                displayFormat={{ hour12: "h:mm a" }}
                placeholder="Start"
                className="h-7 w-auto min-w-0 gap-1 border-none px-2 text-sm font-medium shadow-none hover:bg-muted"
              />
              <span className="text-muted-foreground">&ndash;</span>
              <DateTimePicker
                value={draft.end}
                onChange={(d) => d && updateDraft({ end: d })}
                granularity="minute"
                hourCycle={12}
                displayFormat={{ hour12: "h:mm a" }}
                placeholder="End"
                className="h-7 w-auto min-w-0 gap-1 border-none px-2 text-sm font-medium shadow-none hover:bg-muted"
              />
            </div>
          </div>
        </div>

        {/* Calendar picker row */}
        {calendars.length > 1 && (
          <div>
            <button
              type="button"
              onClick={() => setShowCalendarPicker((p) => !p)}
              className="flex w-full items-center gap-3 px-5 py-2.5 text-sm transition-colors hover:bg-muted/50"
            >
              <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {selectedCalendar && (
                  <div
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: selectedCalendar.color }}
                  />
                )}
                <span className="truncate text-foreground">
                  {selectedCalendar?.name || "Select calendar"}
                </span>
                <span className="text-xs text-muted-foreground truncate">
                  {selectedCalendar?.accountName}
                </span>
              </div>
            </button>

            {showCalendarPicker && (
              <div
                className="mx-4 mb-1 rounded-lg border border-border bg-muted/30"
                style={{ maxHeight: 160, overflowY: "auto", overscrollBehavior: "contain", scrollbarWidth: "thin" }}
              >
                {Object.entries(
                  calendars.reduce<Record<string, CalendarOption[]>>((acc, cal) => {
                    const key = cal.accountName;
                    if (!acc[key]) acc[key] = [];
                    acc[key].push(cal);
                    return acc;
                  }, {}),
                ).map(([accountName, cals]) => (
                  <div key={accountName}>
                    <div className="sticky top-0 z-1 bg-muted/80 backdrop-blur-sm px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {accountName}
                    </div>
                    {cals.map((cal) => (
                      <button
                        key={cal.id}
                        type="button"
                        className="flex w-full items-center gap-2.5 px-3 py-1.5 text-sm transition-colors hover:bg-muted/50"
                        onClick={() => {
                          setSelectedCalendarId(cal.id);
                          setShowCalendarPicker(false);
                        }}
                      >
                        <div
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: cal.color }}
                        />
                        <span className="truncate">{cal.name}</span>
                        {cal.id === selectedCalendarId && (
                          <span className="ml-auto text-xs text-primary">&#10003;</span>
                        )}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Location row */}
        {showLocation ? (
          <div className="flex items-start gap-3 px-5 py-2.5">
            <MapPin className="mt-2 h-4 w-4 shrink-0 text-muted-foreground" />
            <Input
              placeholder="Add location"
              value={draft.location}
              onChange={(e) => updateDraft({ location: e.target.value })}
              className="h-8 border-none bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
              autoFocus
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowLocation(true)}
            className="flex w-full items-center gap-3 px-5 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50"
          >
            <MapPin className="h-4 w-4 shrink-0" />
            <span>Add location</span>
          </button>
        )}

        {/* Description row */}
        {showDescription ? (
          <div className="flex items-start gap-3 px-5 py-2.5">
            <AlignLeft className="mt-2 h-4 w-4 shrink-0 text-muted-foreground" />
            <Textarea
              placeholder="Add description"
              value={draft.description}
              onChange={(e) => updateDraft({ description: e.target.value })}
              rows={2}
              className="min-h-0 resize-none border-none bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
              autoFocus
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowDescription(true)}
            className="flex w-full items-center gap-3 px-5 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50"
          >
            <AlignLeft className="h-4 w-4 shrink-0" />
            <span>Add description</span>
          </button>
        )}

        {/* Footer */}
        <div className="mt-2 flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button type="button" variant="ghost" size="sm" className="h-8 text-sm" onClick={() => closeEventPopover()}>
            Cancel
          </Button>
          <Button type="submit" size="sm" className="h-8 text-sm" disabled={!draft.title.trim() || saving}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/**
 * Legacy wrapper — used by the calendar header "New event" button.
 * Opens the popover anchored to its trigger children.
 */
export function AddEventDialog({ children, startDate, startTime, endTime: endTimeProp }: {
  children?: React.ReactNode;
  startDate?: Date;
  startTime?: { hour: number; minute: number };
  endTime?: { hour: number; minute: number };
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { selectedDate, openEventPopover } = useCalendar();

  const handleClick = (e: React.MouseEvent) => {
    const date = startDate || selectedDate;
    const startHour = startTime?.hour ?? new Date().getHours();
    const startMin = startTime?.minute ?? 0;
    const endHour = endTimeProp?.hour ?? startHour + 1;
    const endMin = endTimeProp?.minute ?? (endTimeProp ? 0 : startMin);

    const start = new Date(date);
    start.setHours(startHour, startMin, 0, 0);
    const end = new Date(date);
    end.setHours(endHour, endMin, 0, 0);

    let anchor = e.target as HTMLElement;
    while (anchor && anchor !== document.body) {
      const rect = anchor.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) break;
      anchor = anchor.parentElement as HTMLElement;
    }
    openEventPopover(anchor, start, end);
  };

  if (!children) return null;

  return (
    <div onClick={handleClick} className="contents">
      {children}
    </div>
  );
}
