"use client";

/**
 * "Copy availability" in the calendar's toolbar: the person's free time for
 * a range (Today, This week, Next 7 days, Next 14 days) as plain text, from
 * the server's engine (src/lib/availability/copy-text.ts: working hours,
 * every calendar that counts, all-day events). Read only on the click.
 * When the time can't be known (a calendar needs signing in again), the
 * person is told so and nothing is copied: never a guess on the clipboard.
 * Under them, the person's booking links (availability phase 4b), read each
 * time the menu opens (one made since shows up): each copies its address. A
 * read that fails never reads as "no links". Renders nothing when no
 * calendar is connected. "Manage booking links" opens the Availability page
 * (Liam, 11-11: its own page under Calendar, out of Settings): its card in
 * the chat, or the dashboard opening it where there is no chat.
 */
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useHasConnectedAccount } from "@/components/account-filter-dropdown";
import { copyDeferredTextToClipboard, copyTextToClipboard } from "@/lib/clipboard";
import { useCanOpenCards } from "@/app/account/(dashboard)/main-chat/main-chat-context";
import { openTarget, pageDeepLink } from "@/lib/chat-cards/open-card";
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

export interface MenuLink {
  id: string;
  title: string;
  url: string;
}

/** The person's booking links that are on, to copy (theirs to host or theirs to own), at most five. Throws on a failed read. */
export async function fetchMyBookingLinks(load: typeof fetch = fetch): Promise<MenuLink[]> {
  const res = await load("/api/account/booking-links");
  if (!res.ok) throw new Error("Booking links could not be read");
  const body = (await res.json().catch(() => ({}))) as { user_id?: string; links?: Array<{ id: string; title: string; url: string | null; active: boolean; hosts: string[]; owner_user_id: string; purpose: string }> };
  const me = body.user_id;
  return (body.links ?? [])
    .filter((l) => l.active && l.url && l.purpose === "meeting" && (l.owner_user_id === me || l.hosts.includes(me ?? "")))
    .slice(0, 5)
    .map((l) => ({ id: l.id, title: l.title, url: l.url as string }));
}

export function CopyAvailabilityButton({ compact = false, className }: { compact?: boolean; className?: string }) {
  const connected = useHasConnectedAccount("calendar");
  const router = useRouter();
  const canOpenCards = useCanOpenCards();
  const openAvailability = useCallback(() => {
    if (canOpenCards) openTarget({ type: "page", slug: "availability" }, { from: "calendar" });
    else router.push(pageDeepLink("availability"));
  }, [canOpenCards, router]);
  const [busy, setBusy] = useState(false);
  // Read each time the menu opens (the last list stays while it loads); null until then, or after a failed read.
  const [links, setLinks] = useState<MenuLink[] | null>(null);

  const opened = useCallback((open: boolean) => {
    if (open) void fetchMyBookingLinks().then(setLinks, () => setLinks(null));
  }, []);

  const copyLink = useCallback(async (link: MenuLink) => {
    if (await copyTextToClipboard(link.url)) toast.success(`Booking link copied · ${link.title}`);
    else toast.error("Couldn't copy the link");
  }, []);

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
    <DropdownMenu onOpenChange={opened}>
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
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Copy your free time</DropdownMenuLabel>
        {COPY_RANGES.map((range) => (
          <DropdownMenuItem key={range} className="text-sm" onSelect={() => copy(range)}>
            {COPY_RANGE_LABELS[range]}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Booking links</DropdownMenuLabel>
        {links?.map((link) => (
          <DropdownMenuItem key={link.id} className="text-sm" onSelect={() => void copyLink(link)} data-booking-link-copy="">
            <span className="truncate">Copy {link.title}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem className="text-sm text-muted-foreground" onSelect={openAvailability} data-manage-booking-links="">
          {links && links.length === 0 ? "Make a booking link" : "Manage booking links"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
