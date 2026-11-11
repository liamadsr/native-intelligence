"use client";

/**
 * "Copy availability" in the calendar's toolbar: the person's free time for
 * a range (Today, This week, Next 7 days, Next 14 days) as plain text, from
 * the server's engine (src/lib/availability/copy-text.ts: working hours,
 * every calendar that counts, all-day events). Read only on the click.
 * When the time can't be known (a calendar needs signing in again), the
 * person is told so and nothing is copied: never a guess on the clipboard.
 * Renders nothing when no calendar is connected.
 */
import { useCallback, useState } from "react";
import { CalendarClock } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useHasConnectedAccount } from "@/components/account-filter-dropdown";
import { copyDeferredTextToClipboard } from "@/lib/clipboard";
import { COPY_RANGES, COPY_RANGE_LABELS, type CopyRange } from "@/lib/availability/copy-ranges";

/** The text for a range, or a rejection carrying why it is unknown. */
export async function fetchAvailabilityText(range: CopyRange, timeZone: string | undefined, load: typeof fetch = fetch): Promise<string> {
  const tz = timeZone ? `&tz=${encodeURIComponent(timeZone)}` : "";
  const res = await load(`/api/account/availability/copy?range=${range}${tz}`);
  const body = (await res.json().catch(() => ({}))) as { known?: boolean; text?: string; reason?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? "Couldn't read your calendar");
  if (body.known !== true || typeof body.text !== "string") throw new Error(body.reason ?? "Couldn't read your calendar");
  return body.text;
}

export function CopyAvailabilityButton({ compact = false, className }: { compact?: boolean; className?: string }) {
  const connected = useHasConnectedAccount("calendar");
  const [busy, setBusy] = useState(false);

  const copy = useCallback((range: CopyRange) => {
    let zone: string | undefined;
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      zone = undefined;
    }
    const text = fetchAvailabilityText(range, zone);
    const why = text.then(
      () => null,
      (err: unknown) => (err instanceof Error ? err.message : null),
    );
    setBusy(true);
    // Started inside the click, so the desktop app's WebKit keeps the write.
    void copyDeferredTextToClipboard(text).then(async (ok) => {
      setBusy(false);
      if (ok) {
        toast.success(`Availability copied · ${COPY_RANGE_LABELS[range]}`);
        return;
      }
      const reason = await why;
      toast.error(reason ? `Your availability is unknown: ${reason}. Nothing was copied.` : "Couldn't copy your availability");
    });
  }, []);

  if (!connected) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <Button variant="ghost" size="sm" className={cn("h-7 w-7 shrink-0 rounded-full p-0", className)} aria-label="Copy availability" title="Copy availability" disabled={busy}>
            <CalendarClock className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button variant="ghost" size="sm" className={cn("h-7 gap-1.5 text-xs", className)} disabled={busy}>
            <CalendarClock className="h-3.5 w-3.5" />
            Copy availability
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Copy your free time</DropdownMenuLabel>
        {COPY_RANGES.map((range) => (
          <DropdownMenuItem key={range} className="text-sm" onSelect={() => copy(range)}>
            {COPY_RANGE_LABELS[range]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
