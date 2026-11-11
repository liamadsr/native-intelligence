import { useCallback } from "react";
import { toast } from "sonner";
import { useCalendarMutators } from "@/calendar/contexts/calendar-context";
import { patchCalendarEventsCache } from "@/calendar/hooks/use-calendar-events";

import type { IEvent } from "@/calendar/interfaces";

// Ids of events with an in-flight optimistic edit. Module-scoped (like the
// shared cache in useCalendarEvents) so the CalendarProvider prop-resync effect
// can preserve the local version of these ids instead of clobbering them with a
// slightly-stale server fetch mid-drag. Always removed in a resolve/reject
// handler so the set can't leak.
const pendingEventIds = new Set<string>();
export function isEventPending(id: string): boolean {
  return pendingEventIds.has(id);
}

// Once the server confirms the write, fold it into the shared fetch cache so
// the other calendar surfaces (dashboard widget, a remount within the freshness
// window) show the moved event without waiting for the next poll.
function patchCacheWithEvent(updated: IEvent) {
  patchCalendarEventsCache((prev) => {
    const index = prev.findIndex((e) => e.id === updated.id);
    if (index === -1) return prev;
    return [...prev.slice(0, index), updated, ...prev.slice(index + 1)];
  });
}

export function useUpdateEvent() {
  const { setLocalEvents } = useCalendarMutators();

  const updateEvent = useCallback(
    (event: IEvent) => {
      const newEvent: IEvent = {
        ...event,
        startDate: new Date(event.startDate).toISOString(),
        endDate: new Date(event.endDate).toISOString(),
      };

      // Optimistic local update
      setLocalEvents(prev => {
        const index = prev.findIndex(e => e.id === event.id);
        if (index === -1) return prev;
        return [...prev.slice(0, index), newEvent, ...prev.slice(index + 1)];
      });

      // Mark this id as having an in-flight optimistic edit so a concurrent
      // prop-resync can't overwrite it with a stale fetch. Cleared in finally.
      pendingEventIds.add(event.id);

      const revert = () => {
        setLocalEvents(prev => {
          const index = prev.findIndex(e => e.id === event.id);
          if (index === -1) return prev;
          return [...prev.slice(0, index), event, ...prev.slice(index + 1)];
        });
        toast.error("Couldn't update the event — reverted");
      };

      // Route through Tauri bridge for local Exchange events. The native write
      // is awaited and its result checked: it resolves { success: false } on
      // a refused write (read-only calendar, permission revoked).
      if (event.source === 'local_exchange') {
        import("@/lib/tauri-bridge").then(async ({ tauriBridge }) => {
          const result = await tauriBridge.updateLocalExchangeEvent({
            eventId: event.id,
            title: newEvent.title,
            start: newEvent.startDate,
            end: newEvent.endDate,
            location: newEvent.location,
            notes: newEvent.description || undefined,
          });
          if (!result?.success) throw new Error(result?.error ?? "update failed");
          patchCacheWithEvent(newEvent);
        }).catch(() => {
          revert();
        }).finally(() => {
          pendingEventIds.delete(event.id);
        });
        return;
      }

      // Persist to server API for OAuth events (fire-and-forget, revert on error)

      fetch("/api/calendar/events", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId: event.id,
          title: newEvent.title,
          start: newEvent.startDate,
          end: newEvent.endDate,
          description: newEvent.description,
          location: newEvent.location,
        }),
      }).then(res => {
        // A non-2xx response never throws — revert here too, not just in catch.
        if (!res.ok) revert();
        else {
          patchCacheWithEvent(newEvent);
          // Saved, with a word to say (a meeting link that couldn't follow the new length exactly).
          void res.json().then((json: { notice?: string }) => {
            if (json?.notice) toast(json.notice);
          }).catch(() => {});
        }
      }).catch(() => {
        revert();
      }).finally(() => {
        pendingEventIds.delete(event.id);
      });
    },
    [setLocalEvents],
  );

  return { updateEvent };
}
