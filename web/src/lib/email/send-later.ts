/**
 * Send later, in the browser: the times the composer offers, how a time
 * reads, and the calls the composer and the Scheduled folder make
 * (/api/account/email/scheduled; the server half is ./scheduled-send.ts).
 *
 * Times are the browser's own (its timezone): "Tomorrow, 8:00 AM" is 8 in the
 * morning where the person is, sent to the server as an instant.
 *
 * After scheduling, the toast says when it goes, with Undo: Undo cancels the
 * schedule and the message stays in the mailbox as a normal draft (Drafts
 * reads it after the sync the cancel asks for).
 *
 * Client-safe. `deps` exists for tests.
 */
import { toast as sonner } from 'sonner'

/** The hour the presets send at, local time. */
export const PRESET_HOUR = 8

export interface SendLaterPreset {
  id: 'tomorrow' | 'monday'
  label: string
  at: Date
}

function atHour(day: Date, hour: number): Date {
  const d = new Date(day)
  d.setHours(hour, 0, 0, 0)
  return d
}

function addDays(day: Date, n: number): Date {
  const d = new Date(day)
  d.setDate(d.getDate() + n)
  return d
}

/**
 * The composer's preset times from `now`: tomorrow at 8:00 AM, and the next
 * Monday at 8:00 AM (after today; left out when tomorrow is that Monday, which
 * the first already is).
 */
export function sendLaterPresets(now: Date): SendLaterPreset[] {
  const tomorrow = atHour(addDays(now, 1), PRESET_HOUR)
  const out: SendLaterPreset[] = [{ id: 'tomorrow', label: 'Tomorrow, 8:00 AM', at: tomorrow }]
  if (tomorrow.getDay() !== 1) {
    // Days until the next Monday after today (1..7).
    const ahead = ((1 - now.getDay() + 7) % 7) || 7
    out.push({ id: 'monday', label: 'Monday, 8:00 AM', at: atHour(addDays(now, ahead), PRESET_HOUR) })
  }
  return out
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A Date as a datetime-local input's value (local time, to the minute). */
export function toLocalInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The earliest a picked time may be: the next whole minute. */
export function minPickValue(now: Date): string {
  const next = new Date(now)
  next.setSeconds(0, 0)
  next.setMinutes(next.getMinutes() + 1)
  return toLocalInputValue(next)
}

/** A datetime-local value as a send time: a local time strictly after `now`, else null. */
export function pickedSendAt(value: string, now: Date): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  const [, y, mo, d, h, mi] = m.map(Number)
  const at = new Date(y, mo - 1, d, h, mi, 0, 0)
  // An impossible date (Feb 30) rolls over: refuse it rather than send on another day.
  if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d) return null
  return at.getTime() > now.getTime() ? at : null
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/**
 * How a send time reads: "Today, 3:30 PM", "Tomorrow, 8:00 AM", a weekday
 * within the week ("Monday, 8:00 AM"), else the date ("Nov 30, 8:00 AM"; the
 * year when it is not this one).
 */
export function scheduledForLabel(at: Date, now: Date): string {
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (sameDay(at, now)) return `Today, ${time}`
  if (sameDay(at, addDays(now, 1))) return `Tomorrow, ${time}`
  const days = (atHour(at, 0).getTime() - atHour(now, 0).getTime()) / 86_400_000
  if (days > 0 && days < 7) return `${at.toLocaleDateString('en-US', { weekday: 'long' })}, ${time}`
  const date = at.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  })
  return `${date}, ${time}`
}

// ── The calls ───────────────────────────────────────────────────────────────

/** A scheduled send as the routes answer it. */
export interface ScheduledSendView {
  id: string
  account_id: string
  provider: 'google' | 'microsoft'
  thread_id: string | null
  to_emails: string[] | null
  subject: string | null
  send_at: string
  status: 'scheduled' | 'sending' | 'sent' | 'failed' | 'cancelled'
  error: string | null
  sent_at: string | null
  created_at: string
}

/** What scheduling sends: a new message, or a draft on a thread; the time is added. */
export type ScheduleRequest =
  | { account_id: string; to: string[]; cc?: string[]; bcc?: string[]; subject: string; body_html: string }
  | { thread_id: string; draft_id: string; edits?: unknown; shown?: { to: string[]; subject: string } }

interface ToastOptions {
  description?: string
  action?: { label: string; onClick: () => void }
}

export interface SendLaterDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  toast: { success: (message: string, opts?: ToastOptions) => void; error: (message: string) => void }
  now: () => Date
}

export const defaultSendLaterDeps: SendLaterDeps = {
  fetch: (input, init) => fetch(input, init),
  toast: {
    success: (message, opts) => void sonner.success(message, opts),
    error: (message) => void sonner.error(message),
  },
  now: () => new Date(),
}

async function errorOf(res: Response | null, fallback: string): Promise<string> {
  if (!res) return fallback
  try {
    const data = (await res.json()) as { error?: unknown }
    return typeof data.error === 'string' && data.error ? data.error : fallback
  } catch {
    return fallback
  }
}

async function call(deps: SendLaterDeps, url: string, init: RequestInit): Promise<Response | null> {
  try {
    return await deps.fetch(url, init)
  } catch {
    return null
  }
}

/** Ask the mailbox sync to read again, so a draft kept by Undo or Cancel is in Drafts. */
function syncMail(deps: SendLaterDeps): void {
  void call(deps, '/api/account/email/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
}

/**
 * Cancel a scheduled send: it stays a normal draft in the mailbox. True when
 * cancelled; a refusal (already sent, being sent) is toasted.
 */
export async function cancelScheduledSend(id: string, deps: SendLaterDeps = defaultSendLaterDeps): Promise<boolean> {
  const res = await call(deps, `/api/account/email/scheduled/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
  if (!res?.ok) {
    deps.toast.error(await errorOf(res, "Couldn't cancel it"))
    return false
  }
  syncMail(deps)
  return true
}

/**
 * Schedule a message for `at`, then toast "Scheduled for <when>" with Undo
 * (which cancels it, leaving a normal draft). The row, or null (the refusal
 * toasted).
 */
export async function scheduleSend(request: ScheduleRequest, at: Date, deps: SendLaterDeps = defaultSendLaterDeps): Promise<ScheduledSendView | null> {
  const res = await call(deps, '/api/account/email/scheduled', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...request, send_at: at.toISOString() }),
  })
  if (!res?.ok) {
    deps.toast.error(await errorOf(res, "Couldn't schedule the email"))
    return null
  }
  const data = (await res.json().catch(() => null)) as { scheduled?: ScheduledSendView } | null
  const row = data?.scheduled ?? null
  if (!row) return null
  deps.toast.success(`Scheduled for ${scheduledForLabel(new Date(row.send_at), deps.now())}`, {
    action: {
      label: 'Undo',
      onClick: () => {
        void cancelScheduledSend(row.id, deps).then((ok) => {
          if (ok) deps.toast.success('Kept as a draft')
        })
      },
    },
  })
  return row
}
