'use client'

import * as React from 'react'
import { AlarmClock } from 'lucide-react'
import { fetchReminder, onReminderChanged } from '@/lib/reminders/client'
import { formatFromNow } from '@/lib/reminders/time'
import type { Reminder, ReminderEntityType } from '@/lib/reminders/types'
import { ReminderPickerPopover } from './reminder-picker'

/**
 * The header pill — the only always-visible trace of a pending reminder, sitting
 * in the shared breadcrumb header next to the prev/next nav. Renders nothing
 * when there's no pending reminder, so the header is unchanged for the entities
 * (the vast majority) that have none.
 *
 * Clicking it reopens the same picker, pre-loaded with the pending reminder so
 * the Remove row appears: reschedule and cancel are the two things you want from
 * a reminder you can see, and both live one click away.
 *
 * The label is relative ("13 hours from now"), so it goes stale on its own — a
 * 60s tick re-renders it. Cross-surface writes (toolbar button, row context
 * menu) arrive through the `ni:reminder-changed` window event rather than a
 * shared store; the pill and the picker never share a React tree. DELIVERY
 * arrives on the same event: notification-context re-emits it when the cron's
 * `reminder` notification lands, and the "now" poll below covers the case where
 * realtime was down when it did.
 */
export function ReminderHeaderPill({
  entityType,
  entityId,
}: {
  entityType: ReminderEntityType
  entityId: string
}) {
  const [reminder, setReminder] = React.useState<Reminder | null>(null)
  const [open, setOpen] = React.useState(false)
  // Bumped by the 60s tick purely to re-render the relative label.
  const [, setTick] = React.useState(0)

  const load = React.useCallback(async () => {
    try {
      const r = await fetchReminder(entityType, entityId)
      return r
    } catch {
      // A failed read must not blank an already-rendered pill or surface a toast
      // in a header the user didn't interact with.
      return undefined
    }
  }, [entityType, entityId])

  React.useEffect(() => {
    let cancelled = false
    setReminder(null)
    void (async () => {
      const r = await load()
      if (!cancelled && r !== undefined) setReminder(r)
    })()
    return () => {
      cancelled = true
    }
  }, [load])

  // Any surface that sets/clears a reminder for THIS entity → refetch. The
  // detail is matched loosely: an emitter that hands back nothing still triggers
  // a refetch (correct, just chattier), and a mismatched entity is skipped.
  React.useEffect(() => {
    return onReminderChanged((detail) => {
      if (detail && (detail.entityType !== entityType || detail.entityId !== entityId)) return
      void (async () => {
        const r = await load()
        if (r !== undefined) setReminder(r)
      })()
    })
  }, [entityType, entityId, load])

  React.useEffect(() => {
    if (!reminder) return
    const id = window.setInterval(() => setTick((t) => t + 1), 60_000)
    return () => window.clearInterval(id)
  }, [reminder])

  const label = reminder ? formatFromNow(reminder.remind_at) : null

  // Belt and braces for delivery. The realtime `reminder` notification already
  // triggers a refetch via `ni:reminder-changed`, but the cron sweeps on a
  // 5-minute tick and the row can be delivered while realtime is down. Once the
  // label collapses to "now" the target is past, so poll the truth a couple of
  // times rather than sitting on "now" forever with a phantom Remove row.
  const isNow = label === 'now'
  React.useEffect(() => {
    if (!isNow) return
    const id = window.setInterval(() => {
      void (async () => {
        const r = await load()
        if (r !== undefined) setReminder(r)
      })()
    }, 60_000)
    return () => window.clearInterval(id)
  }, [isNow, load])

  if (!reminder || !label) return null

  return (
    <ReminderPickerPopover
      open={open}
      onOpenChange={setOpen}
      entityType={entityType}
      entityId={entityId}
      existing={reminder}
    >
      <button
        type="button"
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-indigo-500/40 bg-indigo-500/10 px-3 py-1 text-xs font-medium text-indigo-600 transition-colors hover:bg-indigo-500/20 dark:text-indigo-300"
        title="Reminder — click to reschedule or remove"
      >
        <AlarmClock className="h-3 w-3" />
        {label}
      </button>
    </ReminderPickerPopover>
  )
}
