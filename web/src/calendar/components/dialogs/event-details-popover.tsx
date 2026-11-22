"use client";

/**
 * The event card: a click on a calendar event opens it beside the block, over
 * the grid, which stays where it is (the owner's ask, 11-22: no page of its
 * own). Top to bottom: the event's buttons (copy its link, download it as an
 * .ics, pass it on by email, edit, delete, open the full panel, close), the
 * title by its calendar's colour, the date line, the call with Join and our
 * own Start capture, where, the description, the calendar it is on, the
 * guests, and "Going?" when the person can answer it.
 *
 * Mounted once per calendar (client-container.tsx), beside the quick-add
 * popover; the calendar context says which event is open and which block it
 * sits beside. It closes on Esc, its X, or a click anywhere but the card.
 * A click on another event moves it there.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { parseISO } from "date-fns";
import { toast } from "sonner";
import {
  AlignLeft,
  Calendar as CalendarIcon,
  Check,
  ChevronDown,
  Copy,
  Disc,
  Download,
  ExternalLink,
  Forward,
  HelpCircle,
  Link2,
  Loader2,
  Mail,
  MapPin,
  Maximize2,
  Pencil,
  Trash2,
  Users,
  Video,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import { Linkify } from "@/components/ui/linkify";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useJoinOurMeeting, useOurMeeting } from "@/components/meeting-links/join-meeting";

import { useCalendarData, useCalendarEventDetails, useCalendarMutators } from "@/calendar/contexts/calendar-context";
import { useStartMeetingFromEvent } from "@/calendar/hooks/use-start-meeting";
import {
  canAnswerHere,
  descriptionText,
  eventDateLine,
  eventGuests,
  eventSummaryText,
  eventToIcs,
  icsFileName,
  initials,
  mailtoHref,
  meetingProviderName,
  otherGuestEmails,
  placeCard,
  CARD_EDGE,
  type Guest,
} from "@/calendar/event-details";
import {
  answerGoing,
  deleteCalendarEvent,
  readGoingStatus,
  saveEventEdits,
  EventWriteError,
  type GoingAnswer,
  type GoingStatus,
} from "@/calendar/event-writes";
import { saveTextFile } from "@/lib/download";
import { isDesktopApp } from "@/lib/platform";
import { SYSTEM_BROWSER_PROPS } from "@/lib/open-external";
import { cn } from "@/lib/utils";

import type { IEvent } from "@/calendar/interfaces";

const CARD_WIDTH = 380;
/** Above this many guests the list starts folded. */
const GUESTS_OPEN_MAX = 8;

async function copyText(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error("Couldn’t copy to the clipboard");
  }
}

/**
 * Open a mailto: link in the person's mail app. The desktop app hands it to
 * the system; if that is refused, the addresses go to the clipboard instead,
 * so the button never does nothing.
 */
async function openMail(href: string, fallback: { text: string; done: string }) {
  if (isDesktopApp()) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(href);
      return;
    } catch {
      await copyText(fallback.text, fallback.done);
      return;
    }
  }
  window.location.href = href;
}

/** Where the card is, and the block it sits by (found again when the grid redraws it). */
function useCardPlacement(anchorEl: HTMLElement | null, eventId: string | null, cardRef: React.RefObject<HTMLDivElement | null>, onLost: () => void) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLElement | null>(anchorEl);
  anchorRef.current = anchorEl;
  const onLostRef = useRef(onLost);
  onLostRef.current = onLost;

  const update = useCallback(() => {
    if (!eventId) return;
    let anchor = anchorRef.current;
    if (!anchor || !anchor.isConnected) {
      // The grid redrew the block (a drag, a new fetch): the same event's block, if it is still on screen.
      const id = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(eventId) : eventId.replace(/["\\]/g, "\\$&");
      anchor = document.querySelector<HTMLElement>(`[data-calendar-event-trigger="${id}"]`);
      if (!anchor) {
        onLostRef.current();
        return;
      }
      anchorRef.current = anchor;
    }
    const rect = anchor.getBoundingClientRect();
    const card = cardRef.current;
    const height = card?.offsetHeight || 420;
    const width = card?.offsetWidth || CARD_WIDTH;
    const next = placeCard(rect, { width, height }, { width: window.innerWidth, height: window.innerHeight });
    setPosition((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : { top: next.top, left: next.left }));
  }, [eventId, cardRef]);

  useLayoutEffect(() => {
    if (!eventId) {
      setPosition(null);
      return;
    }
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    const card = cardRef.current;
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    if (card && observer) observer.observe(card);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [eventId, anchorEl, update, cardRef]);

  return { position, update, anchorRef };
}

export function EventDetailsPopover() {
  const details = useCalendarEventDetails();
  const { events } = useCalendarData();
  const { closeEventDetails } = useCalendarMutators();
  const cardRef = useRef<HTMLDivElement>(null);

  // The event as the grid has it now, so an edit or an answer shows at once.
  const live = details ? events.find((e) => e.id === details.eventId) ?? null : null;
  const lastRef = useRef<IEvent | null>(null);
  if (live) lastRef.current = live;
  const event = details ? live ?? (lastRef.current?.id === details.eventId ? lastRef.current : null) : null;

  const { position, update } = useCardPlacement(details?.anchorEl ?? null, event ? details!.eventId : null, cardRef, closeEventDetails);

  // Gone from the calendar (deleted, or a fetch no longer has it): nothing to show.
  useEffect(() => {
    if (details && !live && !lastRef.current) closeEventDetails();
  }, [details, live, closeEventDetails]);

  // The grid moved under it (a drag, a resize): follow the block.
  useLayoutEffect(() => {
    if (live) update();
  }, [live?.startDate, live?.endDate, update]); // eslint-disable-line react-hooks/exhaustive-deps

  const [confirming, setConfirming] = useState(false);
  const confirmingRef = useRef(confirming);
  confirmingRef.current = confirming;

  // Esc, or a press anywhere but the card, closes it. A press on another event is left to its click,
  // which moves the card there; one inside a picker or dialog the card opened is the card's own.
  useEffect(() => {
    if (!details) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Element) || cardRef.current?.contains(target)) return;
      if (confirmingRef.current) return;
      if (target.closest("[data-radix-popper-content-wrapper], [role='dialog'], [role='alertdialog'], [role='listbox']")) return;
      if (target.closest("[data-calendar-event-trigger]")) return;
      closeEventDetails();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || confirmingRef.current) return;
      if (e.target instanceof Element && e.target.closest("[data-radix-popper-content-wrapper]")) return;
      closeEventDetails();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [details, closeEventDetails]);

  if (!details || !event) return null;

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-label={event.title || "Event"}
      data-event-card=""
      className={cn(
        "fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-border/70 text-popover-foreground",
        // The app's glass: the popover colour, see-through enough to show the grid soft behind it.
        "bg-popover/90 backdrop-blur-xl backdrop-saturate-150",
        "shadow-[0_16px_40px_-8px_rgba(0,0,0,0.18),0_2px_6px_rgba(0,0,0,0.06)] dark:shadow-[0_16px_40px_-8px_rgba(0,0,0,0.6),0_0_0_1px_rgba(255,255,255,0.04)]",
        "animate-in fade-in-0 zoom-in-95 duration-150",
      )}
      style={{
        width: `min(${CARD_WIDTH}px, calc(100vw - ${CARD_EDGE * 2}px))`,
        maxHeight: `calc(100vh - ${CARD_EDGE * 2}px)`,
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        visibility: position ? "visible" : "hidden",
      }}
    >
      <EventCardBody key={event.id} event={event} onConfirmingChange={setConfirming} />
    </div>,
    document.body,
  );
}

function IconButton({ label, onClick, children, disabled, className }: { label: string; onClick: () => void; children: React.ReactNode; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

function Row({ icon, children, className }: { icon: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start gap-3 px-4 py-1.5", className)}>
      <span className="flex h-7 w-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1 py-[5px] text-sm leading-[18px]">{children}</div>
    </div>
  );
}

const pill =
  "inline-flex h-7 items-center gap-1.5 rounded-full border border-border/80 bg-background/60 px-3 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 dark:bg-white/[0.04] dark:hover:bg-white/[0.08]";

function EventCardBody({ event, onConfirmingChange }: { event: IEvent; onConfirmingChange: (open: boolean) => void }) {
  const { closeEventDetails, openFullEvent } = useCalendarMutators();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => onConfirmingChange(confirmDelete), [confirmDelete, onConfirmingChange]);

  const guests = useMemo(() => eventGuests(event), [event]);
  const description = useMemo(() => descriptionText(event.description), [event.description]);

  const downloadIcs = async () => {
    try {
      const saved = await saveTextFile(icsFileName(event), eventToIcs(event), "text/calendar");
      if (saved && isDesktopApp()) toast.success("Saved the event");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t save the event");
    }
  };

  const forward = () => {
    const text = eventSummaryText(event);
    void openMail(mailtoHref([], event.title || "Event", text), { text, done: "Copied the event’s details" });
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await deleteCalendarEvent(event);
      setConfirmDelete(false);
      closeEventDetails();
    } catch (err) {
      toast.error(err instanceof EventWriteError ? err.message : "Could not delete the event");
      setDeleting(false);
    }
  };

  return (
    <>
      {/* The event's buttons. */}
      <div className="flex shrink-0 items-center justify-end gap-0.5 px-2 pt-2">
        {event.htmlLink && (
          <IconButton label="Copy link to event" onClick={() => void copyText(event.htmlLink!, "Copied the event’s link")}>
            <Link2 className="size-4" />
          </IconButton>
        )}
        <IconButton label="Download .ics" onClick={() => void downloadIcs()}>
          <Download className="size-4" />
        </IconButton>
        <IconButton label="Send by email" onClick={forward}>
          <Forward className="size-4" />
        </IconButton>
        <IconButton label={editing ? "Stop editing" : "Edit event"} onClick={() => setEditing((v) => !v)} className={cn(editing && "bg-foreground/[0.07] text-foreground")}>
          <Pencil className="size-4" />
        </IconButton>
        <IconButton label="Delete event" onClick={() => setConfirmDelete(true)} disabled={deleting} className="hover:text-destructive">
          <Trash2 className="size-4" />
        </IconButton>
        {openFullEvent && (
          <IconButton label="Open full details" onClick={() => openFullEvent(event)}>
            <Maximize2 className="size-3.5" />
          </IconButton>
        )}
        <IconButton label="Close" onClick={closeEventDetails}>
          <X className="size-4" />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2" style={{ scrollbarWidth: "thin" }}>
        {editing ? (
          <EditForm event={event} onDone={() => setEditing(false)} />
        ) : (
          <>
            <div className="flex items-start gap-3 px-4 pb-1 pt-1">
              <span className="flex h-7 w-4 shrink-0 items-center justify-center">
                <span className={cn(`cal-${event.color}`, "cal-dot size-3 rounded-full")} aria-hidden />
              </span>
              <h2 className={cn("min-w-0 flex-1 text-xl font-semibold leading-7 tracking-tight [overflow-wrap:anywhere]", event.response === "declined" && "line-through opacity-70")}>
                {event.title || "(no title)"}
              </h2>
            </div>
            <p className="px-4 pb-2 pl-11 text-sm text-muted-foreground tabular-nums">{eventDateLine(event)}</p>

            <MeetingRow event={event} />

            {event.location && (
              <Row icon={<MapPin />}>
                <span className="[overflow-wrap:anywhere]">
                  <Linkify text={event.location} />
                </span>
              </Row>
            )}

            {description && (
              <Row icon={<AlignLeft />}>
                <Description text={description} />
              </Row>
            )}

            {(event.accountEmail || event.calendarName) && (
              <Row icon={<CalendarIcon />}>
                <span className="block truncate">{event.accountEmail ?? event.calendarName}</span>
                {event.accountEmail && event.calendarName && event.calendarName !== event.accountEmail && (
                  <span className="block truncate text-xs text-muted-foreground">{event.calendarName}</span>
                )}
              </Row>
            )}

            {guests.length > 0 && <Guests event={event} guests={guests} />}
          </>
        )}
      </div>

      {!editing && <GoingFooter event={event} />}

      <AlertDialog open={confirmDelete} onOpenChange={(open) => !deleting && setConfirmDelete(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete event</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &ldquo;{event.title}&rdquo;? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void remove();
              }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Join the call (its service by name), copy its link, and our addition: Start capture, or the capture there is. */
function MeetingRow({ event }: { event: IEvent }) {
  const { openCapture } = useCalendarMutators();
  const ourMeeting = useOurMeeting(event.conferenceUrl);
  const { join: joinOurMeeting, joining } = useJoinOurMeeting();
  const { startMeeting, startingId, isRecording } = useStartMeetingFromEvent();
  const provider = meetingProviderName(event.conferenceUrl);
  const capture = event.linkedCapture;
  const starting = startingId === event.id;
  const recording = capture?.auto_capture_status === "recording";
  const captured = !!capture && (capture.auto_capture_status === "completed" || capture.ai_processed);

  const join = event.conferenceUrl ? (
    ourMeeting ? (
      <button type="button" className={pill} disabled={joining} onClick={() => void joinOurMeeting(ourMeeting)} data-calendar-join-meeting="">
        {joining ? <Loader2 className="size-3.5 animate-spin" /> : null}
        Join meeting
      </button>
    ) : (
      // Joining launches the meeting app (and needs a camera and mic): the person's own browser.
      <a href={event.conferenceUrl} target="_blank" rel="noopener noreferrer" {...SYSTEM_BROWSER_PROPS} className={pill}>
        Join {provider ?? "meeting"}
        <ExternalLink className="size-3 opacity-70" />
      </a>
    )
  ) : null;

  const captureButton = recording ? (
    <button
      type="button"
      className={cn(pill, "border-red-500/30 text-red-600 dark:text-red-400")}
      disabled={!openCapture}
      onClick={() => openCapture?.(capture!.capture_id, event.title)}
      title={openCapture ? "Open the capture" : "Recording"}
      data-event-card-capture="recording"
    >
      <span className="size-1.5 animate-pulse rounded-full bg-red-500" />
      Recording
    </button>
  ) : captured ? (
    <button
      type="button"
      className={pill}
      disabled={!openCapture}
      onClick={() => openCapture?.(capture!.capture_id, event.title)}
      data-event-card-capture="captured"
    >
      <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
      {capture!.source_action_count > 0 ? `View capture · ${capture!.source_action_count} actions` : "View capture"}
    </button>
  ) : (
    <button
      type="button"
      className={cn(pill, "border-transparent bg-foreground text-background hover:bg-foreground/85 dark:bg-foreground dark:hover:bg-foreground/85")}
      disabled={starting || isRecording}
      title={isRecording ? "A capture is already in progress" : "Start a capture linked to this meeting"}
      onClick={() => void startMeeting(event)}
      data-event-card-capture="start"
    >
      {starting ? <Loader2 className="size-3.5 animate-spin" /> : <Disc className="size-3.5" />}
      Start capture
    </button>
  );

  return (
    <Row icon={<Video />} className="py-1">
      <div className="-my-[5px] flex flex-wrap items-center gap-1.5">
        {join}
        {event.conferenceUrl && (
          <IconButton label="Copy meeting link" onClick={() => void copyText(event.conferenceUrl!, "Copied the meeting link")}>
            <Copy className="size-3.5" />
          </IconButton>
        )}
        {captureButton}
      </div>
    </Row>
  );
}

/** The description, a few lines of it until asked for the rest. */
function Description({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > 280 || text.split("\n").length > 6;
  return (
    <>
      <p className={cn("whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground/90", long && !all && "line-clamp-6")}>
        <Linkify text={text} />
      </p>
      {long && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-1 text-xs font-medium text-muted-foreground hover:text-foreground">
          {all ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

function ResponseMark({ response }: { response: Guest["response"] }) {
  if (response === "accepted") return <Check aria-label="Going" className="size-4 text-emerald-600 dark:text-emerald-400" />;
  if (response === "declined") return <X aria-label="Not going" className="size-4 text-red-500" />;
  if (response === "tentative") return <HelpCircle aria-label="Maybe" className="size-4 text-amber-500" />;
  return <span aria-label="No answer yet" title="No answer yet" className="mr-1 size-1.5 rounded-full bg-muted-foreground/40" />;
}

function Guests({ event, guests }: { event: IEvent; guests: Guest[] }) {
  const [open, setOpen] = useState(guests.length <= GUESTS_OPEN_MAX);
  const others = otherGuestEmails(event);
  const all = guests.map((g) => g.email);

  return (
    <div className="pt-1">
      <div className="flex items-center gap-3 px-4 py-1">
        <span className="flex h-7 w-4 shrink-0 items-center justify-center text-muted-foreground">
          <Users className="size-4" />
        </span>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-1 text-left text-sm font-medium">
          {guests.length} {guests.length === 1 ? "attendee" : "attendees"}
          <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")} />
        </button>
        <IconButton label="Copy all emails" onClick={() => void copyText(all.join(", "), all.length === 1 ? "Copied the email" : `Copied ${all.length} emails`)}>
          <Copy className="size-3.5" />
        </IconButton>
        {others.length > 0 && (
          <IconButton
            label="Email everyone"
            onClick={() =>
              void openMail(mailtoHref(others, event.title || undefined), {
                text: others.join(", "),
                done: "Copied the guests’ emails",
              })
            }
          >
            <Mail className="size-3.5" />
          </IconButton>
        )}
      </div>
      {open && (
        <ul className="pb-1">
          {guests.map((g) => (
            <li key={g.email} className="flex items-center gap-3 px-4 py-1.5" data-guest={g.email}>
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground/[0.08] text-[10px] font-semibold text-foreground/80" aria-hidden>
                {initials(g)}
              </span>
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-sm">
                  {g.name ?? g.email}
                  {g.isSelf && <span className="text-muted-foreground"> (you)</span>}
                </p>
                {g.name && <p className="truncate text-xs text-muted-foreground">{g.email}</p>}
                {g.isOrganizer && <p className="text-[11px] text-muted-foreground">Organizer</p>}
              </div>
              <ResponseMark response={g.response} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ANSWERS: { value: GoingAnswer; label: string }[] = [
  { value: "accepted", label: "Yes" },
  { value: "tentative", label: "Maybe" },
  { value: "declined", label: "No" },
];

/** "Going?" Yes / Maybe / No, answered on the person's calendar; there only when they are a guest who can answer. */
function GoingFooter({ event }: { event: IEvent }) {
  const eligible = canAnswerHere(event);
  const [status, setStatus] = useState<GoingStatus | null>(null);
  const [pending, setPending] = useState<GoingAnswer | null>(null);
  const [chosen, setChosen] = useState<GoingAnswer | null>(null);

  // The calendar's own word: whether it can be answered, and the answer it holds.
  useEffect(() => {
    if (!eligible) return;
    const controller = new AbortController();
    void readGoingStatus(event, controller.signal).then((s) => {
      if (!controller.signal.aborted) setStatus(s);
    });
    return () => controller.abort();
  }, [eligible, event.icalUid]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!eligible) return null;
  // Found, and the calendar says no (they organize it, aren't on it, or it was cancelled): no footer.
  if (status?.found && status.canAnswer === false) {
    return status.blocked === "cancelled" ? (
      <div className="shrink-0 border-t border-border/60 bg-foreground/[0.03] px-4 py-2.5 text-xs text-muted-foreground">This event was cancelled.</div>
    ) : null;
  }

  const held = status?.found && status.response && status.response !== "pending" ? status.response : null;
  const fromGrid = event.response && event.response !== "pending" ? event.response : null;
  const current: GoingAnswer | null = pending ?? chosen ?? held ?? fromGrid;
  const recurring = !!(event.hasRecurrence || event.seriesMasterId || status?.recurring);

  const answer = async (value: GoingAnswer) => {
    if (pending || value === current) return;
    setPending(value);
    try {
      await answerGoing(event, value);
      setChosen(value);
    } catch (err) {
      toast.error(err instanceof EventWriteError ? err.message : "Couldn’t answer the invitation");
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="shrink-0 border-t border-border/60 bg-foreground/[0.03] px-4 py-2.5" data-event-card-going="">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-sm font-medium">Going?</span>
        {ANSWERS.map((a) => (
          <button
            key={a.value}
            type="button"
            aria-pressed={current === a.value}
            disabled={!!pending}
            onClick={() => void answer(a.value)}
            className={cn(
              "inline-flex h-7 min-w-12 items-center justify-center gap-1 rounded-full border px-3 text-xs font-medium transition-colors disabled:cursor-default",
              current === a.value
                ? "border-transparent bg-foreground text-background"
                : "border-border/80 bg-background/60 text-foreground hover:bg-muted dark:bg-white/[0.04] dark:hover:bg-white/[0.08]",
            )}
          >
            {pending === a.value && <Loader2 className="size-3 animate-spin" />}
            {a.label}
          </button>
        ))}
      </div>
      {recurring && <p className="mt-1 text-[11px] text-muted-foreground">Your answer goes for every event in the series.</p>}
    </div>
  );
}

/** Edit in place: the title, the times (not an all-day event's days), where, and the description. */
function EditForm({ event, onDone }: { event: IEvent; onDone: () => void }) {
  const [title, setTitle] = useState(event.title);
  const [start, setStart] = useState(() => parseISO(event.startDate));
  const [end, setEnd] = useState(() => parseISO(event.endDate));
  const [location, setLocation] = useState(event.location ?? "");
  const [description, setDescription] = useState(() => descriptionText(event.description));
  const [saving, setSaving] = useState(false);
  const durationMs = end.getTime() - start.getTime();

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    // An HTML description the person didn't touch is written back as it was.
    const descriptionOut = description === descriptionText(event.description) ? event.description : description;
    setSaving(true);
    try {
      const { notice } = await saveEventEdits(event, { title, start, end, location, description: descriptionOut ?? "" });
      if (notice) toast(notice);
      onDone();
    } catch (err) {
      toast.error(err instanceof EventWriteError ? err.message : "Could not save the event");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-1 px-4 pb-2 pt-1" data-event-card-edit="">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Event title"
        aria-label="Title"
        autoFocus
        className="w-full border-0 border-b-2 border-transparent bg-transparent pb-1 text-xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground/60 focus:border-primary"
      />
      {event.isAllDay ? (
        <p className="py-1 text-sm text-muted-foreground">{eventDateLine(event)}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-1 py-1 text-sm">
          <DateTimePicker
            value={start}
            onChange={(d) => {
              if (!d) return;
              setStart(d);
              // Moving the start keeps the length.
              setEnd(new Date(d.getTime() + Math.max(durationMs, 15 * 60_000)));
            }}
            granularity="minute"
            hourCycle={12}
            displayFormat={{ hour12: "MMM d, h:mm a" }}
            placeholder="Start"
            className="h-7 w-auto min-w-0 gap-1 border-none px-2 text-sm font-medium shadow-none hover:bg-muted"
          />
          <span className="text-muted-foreground">&ndash;</span>
          <DateTimePicker
            value={end}
            onChange={(d) => d && setEnd(d)}
            granularity="minute"
            hourCycle={12}
            displayFormat={{ hour12: "h:mm a" }}
            placeholder="End"
            className="h-7 w-auto min-w-0 gap-1 border-none px-2 text-sm font-medium shadow-none hover:bg-muted"
          />
        </div>
      )}
      <div className="flex items-center gap-2">
        <MapPin className="size-4 shrink-0 text-muted-foreground" />
        <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Add location" aria-label="Location" className="h-8 border-none bg-transparent px-1 text-sm shadow-none focus-visible:ring-0" />
      </div>
      <div className="flex items-start gap-2">
        <AlignLeft className="mt-2 size-4 shrink-0 text-muted-foreground" />
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Add description"
          aria-label="Description"
          rows={3}
          className="min-h-0 resize-none border-none bg-transparent px-1 text-sm shadow-none focus-visible:ring-0"
        />
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" className="h-8" onClick={onDone} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" size="sm" className="h-8" disabled={saving || !title.trim() || (!event.isAllDay && end <= start)}>
          {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
          Save
        </Button>
      </div>
    </form>
  );
}
