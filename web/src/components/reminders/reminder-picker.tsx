'use client'

import * as React from 'react'
import { AlarmClock, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DateTimeCalendar, TimePicker } from '@/components/ui/datetime-picker'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { clearReminder, fetchReminder, setReminder } from '@/lib/reminders/client'
import { atNine, formatReminderDate, reminderPresets } from '@/lib/reminders/time'
import type { ReminderPresetOption } from '@/lib/reminders/time'
import type { Reminder, ReminderEntityType } from '@/lib/reminders/types'

/**
 * The "Remind me" picker (Linear parity) — ONE Command list reused by every
 * entry point: the detail-panel toolbar button, the header pill, and the list
 * row's right-click submenu. Splitting it would let the surfaces drift, and the
 * whole point of the feature is that ⇧H means the same thing everywhere.
 *
 * Empty input shows the preset ladder with each preset's resolved absolute
 * instant on the right — a reminder is stored as a timestamptz, so the client
 * resolves "tomorrow" to a real instant at pick time and the server never has to
 * guess a timezone. Typed input switches to chrono-node parsing, DYNAMICALLY
 * imported (~200KB) so free-text date parsing never lands in the dashboard
 * bundle for the 99% of sessions that only ever click a preset.
 */

/** How the picker addresses an entity's kind in the custom-dialog title. */
const ENTITY_NOUN: Record<ReminderEntityType, string> = {
  action: 'action',
  project: 'project',
  initiative: 'initiative',
  capture: 'capture',
  document: 'document',
}

/** Minimal shape of the chrono module we use — avoids importing its types eagerly. */
interface ChronoModule {
  parse(
    text: string,
    ref?: Date,
    option?: { forwardDate?: boolean },
  ): Array<{ date(): Date }>
}

export interface ReminderPickerProps {
  entityType: ReminderEntityType
  entityId: string
  /**
   * The pending reminder, when the caller already knows it — drives the Remove
   * row. THREE-valued on purpose:
   *   Reminder  the caller fetched one (header pill, detail-panel toolbar)
   *   null      the caller knows there is none — don't spend a request
   *   undefined UNKNOWN: the picker fetches it itself on mount. This is what
   *             the list row's context menu passes, and it's the only way that
   *             entry point can ever offer Remove.
   */
  existing?: Reminder | null
  /** Close the popover / context menu after a set or remove lands. */
  onDone?: () => void
}

/**
 * The instant a picked date should actually be saved at.
 *
 * Every path here resolves a date from a wall-clock intent ("tomorrow", "in 2
 * minutes") and the surface can then sit open indefinitely — the row context
 * menu in particular has no timer and no auto-close. A target that has gone
 * past in the meantime would be rejected by the server (its slack is only a
 * minute), so nudge it just far enough out to be a real reminder, the same way
 * the custom dialog treats "today at 9am" picked in the afternoon.
 */
function clampToFuture(target: Date, now: Date = new Date()): Date {
  return target.getTime() > now.getTime()
    ? target
    : new Date(now.getTime() + 5 * 60 * 1000)
}

// ── Custom date dialog ─────────────────────────────────────

interface CustomReminderDialogProps extends ReminderPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function CustomReminderDialog({
  entityType,
  entityId,
  open,
  onOpenChange,
  onDone,
}: CustomReminderDialogProps) {
  // `selected` is the full instant (date + time). It's seeded to today-at-9am on
  // open so the calendar shows a selection and the time reads 9:00 AM from the
  // start — the same time-of-day the presets use — rather than making the user
  // set a time before Apply enables.
  const [selected, setSelected] = React.useState<Date>(() => atNine(new Date()))
  // The month the calendar is showing (drives the month/year dropdowns). Kept
  // separate from `selected` so paging months doesn't move the chosen day.
  const [month, setMonth] = React.useState<Date>(() => atNine(new Date()))
  const [saving, setSaving] = React.useState(false)

  // Fresh dialog every open: re-seed to today-at-9am so a stale choice from a
  // previous open (or an earlier day) never carries over.
  React.useEffect(() => {
    if (open) {
      const seed = atNine(new Date())
      setSelected(seed)
      setMonth(seed)
    }
  }, [open])

  // Picking a calendar day keeps the currently-chosen time-of-day.
  const onPickDay = (day: Date | undefined) => {
    if (!day) return
    const next = new Date(day)
    next.setHours(selected.getHours(), selected.getMinutes(), 0, 0)
    setSelected(next)
    setMonth(next)
  }

  const today = React.useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d
  }, [])

  const apply = async () => {
    setSaving(true)
    try {
      // The user picked an explicit date AND time; only nudge it forward if it's
      // already gone (e.g. a time earlier today), so the cron doesn't fire it on
      // the very next tick.
      await setReminder(entityType, entityId, clampToFuture(selected))
      onOpenChange(false)
      onDone?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not set the reminder')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-auto max-w-none p-5 sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6 text-sm font-medium">
            <AlarmClock className="h-4 w-4 shrink-0 text-muted-foreground" />
            Remind me about this {ENTITY_NOUN[entityType]} on
          </DialogTitle>
        </DialogHeader>
        {/* The same calendar + time controls the properties panel uses (month/
            year dropdowns, styled grid), rendered OPEN — no trigger button to
            click through. Time is selected right below the calendar.

            `relative` wrapper: DateTimeCalendar's prev/next nav is absolutely
            positioned (top-5, left/right-5) against its nearest positioned
            ancestor. Without this box it escapes up into the dialog header and
            collides with the alarm icon and the × close button. */}
        <div className="flex flex-col items-center gap-3">
          <div className="relative">
            <DateTimeCalendar
              mode="single"
              selected={selected}
              onSelect={onPickDay}
              month={month}
              onMonthChange={setMonth}
              disabled={{ before: today }}
            />
          </div>
          <div className="flex w-full items-center justify-center gap-2 border-t pt-3">
            <span className="text-sm text-muted-foreground">Time</span>
            <TimePicker
              date={selected}
              onChange={(d) => d && setSelected(d)}
              hourCycle={12}
              granularity="minute"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={saving} onClick={() => void apply()}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Shared content ─────────────────────────────────────────

export function ReminderPickerContent({
  entityType,
  entityId,
  existing,
  onDone,
}: ReminderPickerProps) {
  const [query, setQuery] = React.useState('')
  const [parsed, setParsed] = React.useState<Date | null>(null)
  const [parsing, setParsing] = React.useState(false)
  const [customOpen, setCustomOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  // The pending reminder when the caller didn't supply one (`existing` is
  // undefined = "unknown"). Fetched once on mount — the picker only exists
  // while a popover/submenu is open, so this is one request per open.
  const [fetched, setFetched] = React.useState<Reminder | null>(null)
  // The chrono module, cached across keystrokes — one dynamic import per mount.
  const chronoRef = React.useRef<ChronoModule | null>(null)

  const knownExisting = existing !== undefined ? existing : fetched

  React.useEffect(() => {
    if (existing !== undefined) return
    let cancelled = false
    void (async () => {
      try {
        const r = await fetchReminder(entityType, entityId)
        if (!cancelled) setFetched(r)
      } catch {
        // No Remove row is the honest fallback for a read we couldn't make —
        // and a toast in a menu the user only just opened would be noise.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [existing, entityType, entityId])

  // Presets resolve against mount time for DISPLAY only; `applyDate` re-derives
  // the picked one against a fresh clock, so a surface left open for an hour
  // still saves what its label promises rather than a stale instant.
  const presets = React.useMemo(() => reminderPresets(), [])

  const trimmed = query.trim()

  // Parse typed input with chrono, loading it on the first keystroke only. The
  // request counter drops stale results when the user types faster than the
  // import resolves.
  const parseSeq = React.useRef(0)
  React.useEffect(() => {
    if (!trimmed) {
      setParsing(false)
      setParsed(null)
      return
    }
    const seq = ++parseSeq.current
    // Set SYNCHRONOUSLY, before the awaited import: the first keystroke has to
    // fetch ~200KB of chrono, and during that window `parsed` is still null.
    // Without this the list would tell the user their perfectly valid input is
    // unparseable for the whole duration of the download.
    setParsing(true)
    void (async () => {
      try {
        if (!chronoRef.current) {
          // chrono-node ships dual CJS/ESM. Under CJS interop the callable
          // surface can land on `.default` instead of the namespace itself, so
          // take whichever object actually carries `parse`.
          //
          // The namespace is checked FIRST and `.default` is only touched when
          // it doesn't resolve: a module namespace is not a plain object, and
          // reading an export it doesn't have can throw (Vitest's mock proxy
          // does exactly that) — so a bare `mod.default?.parse` probe is unsafe.
          const mod = (await import('chrono-node')) as unknown as ChronoModule & {
            default?: ChronoModule
          }
          chronoRef.current =
            typeof mod.parse === 'function' ? mod : (mod.default as ChronoModule)
        }
        const results = chronoRef.current.parse(trimmed, new Date(), { forwardDate: true })
        const date = results[0]?.date() ?? null
        if (seq !== parseSeq.current) return
        setParsed(date && !Number.isNaN(date.getTime()) ? date : null)
        setParsing(false)
      } catch {
        if (seq !== parseSeq.current) return
        setParsed(null)
        setParsing(false)
      }
    })()
  }, [trimmed])

  /**
   * Save a picked date, re-resolved against the clock AT SELECT TIME.
   *
   * `source` says what the user actually picked, not what it resolved to when
   * it was rendered: a preset id is re-derived from a fresh `reminderPresets()`
   * and free text is re-parsed with a fresh reference date, because the surface
   * may have been sitting open for minutes. `fallback` is the rendered instant,
   * used when the re-resolve can't produce one (chrono stopped matching, say).
   */
  const applyDate = async (
    source: { kind: 'preset'; id: ReminderPresetOption['id'] } | { kind: 'text' },
    fallback: Date,
  ) => {
    setBusy(true)
    try {
      let target = fallback
      if (source.kind === 'preset') {
        target = reminderPresets().find((p) => p.id === source.id)?.date ?? fallback
      } else if (chronoRef.current && trimmed) {
        const again = chronoRef.current
          .parse(trimmed, new Date(), { forwardDate: true })[0]
          ?.date()
        if (again && !Number.isNaN(again.getTime())) target = again
      }
      await setReminder(entityType, entityId, clampToFuture(target))
      onDone?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not set the reminder')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await clearReminder(entityType, entityId)
      onDone?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove the reminder')
    } finally {
      setBusy(false)
    }
  }

  const parsedIsFuture = parsed !== null && parsed.getTime() > Date.now()

  return (
    <>
      {/* shouldFilter={false}: the list is driven by the parse result, not by
          cmdk's fuzzy match — "4 pm" must not be matched against preset labels. */}
      <Command shouldFilter={false}>
        <CommandInput
          placeholder="Try: 4 pm, 2 days, in 5 weeks..."
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          {trimmed ? (
            parsedIsFuture ? (
              <CommandGroup>
                <CommandItem
                  value="parsed"
                  disabled={busy}
                  onSelect={() => void applyDate({ kind: 'text' }, parsed)}
                >
                  <AlarmClock className="mr-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{trimmed}</span>
                  <span className="ml-auto shrink-0 whitespace-nowrap pl-3 text-xs text-muted-foreground">
                    {formatReminderDate(parsed)}
                  </span>
                </CommandItem>
              </CommandGroup>
            ) : parsing ? (
              // Neutral while chrono loads/runs — telling the user their valid
              // input is unparseable and then contradicting it a moment later
              // is exactly what makes people give up on free-text entry.
              <CommandEmpty>Parsing...</CommandEmpty>
            ) : (
              <CommandEmpty>No date found</CommandEmpty>
            )
          ) : (
            <CommandGroup>
              {presets.map((p) => (
                <CommandItem
                  key={p.id}
                  value={p.id}
                  disabled={busy}
                  onSelect={() => void applyDate({ kind: 'preset', id: p.id }, p.date)}
                >
                  <AlarmClock className="mr-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="whitespace-nowrap">{p.label}</span>
                  <span className="ml-auto shrink-0 whitespace-nowrap pl-3 text-xs text-muted-foreground">
                    {formatReminderDate(p.date)}
                  </span>
                </CommandItem>
              ))}
              <CommandItem value="custom" disabled={busy} onSelect={() => setCustomOpen(true)}>
                <AlarmClock className="mr-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span>Custom...</span>
              </CommandItem>
              {knownExisting && (
                <CommandItem
                  value="remove"
                  disabled={busy}
                  onSelect={() => void remove()}
                  className="text-destructive"
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5 shrink-0" />
                  <span>Remove reminder</span>
                </CommandItem>
              )}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
      <CustomReminderDialog
        entityType={entityType}
        entityId={entityId}
        existing={knownExisting}
        open={customOpen}
        onOpenChange={setCustomOpen}
        // Applying from the dialog closes the dialog AND the popover behind it.
        onDone={onDone}
      />
    </>
  )
}

// ── Popover wrapper ────────────────────────────────────────

interface ReminderPickerPopoverProps extends ReminderPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  align?: 'start' | 'center' | 'end'
  /** The trigger — rendered `asChild`, so it must forward props to one element. */
  children: React.ReactNode
}

export function ReminderPickerPopover({
  open,
  onOpenChange,
  align = 'end',
  children,
  entityType,
  entityId,
  existing,
  onDone,
}: ReminderPickerPopoverProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-[360px] p-0" align={align}>
        <ReminderPickerContent
          entityType={entityType}
          entityId={entityId}
          existing={existing}
          onDone={() => {
            onOpenChange(false)
            onDone?.()
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
