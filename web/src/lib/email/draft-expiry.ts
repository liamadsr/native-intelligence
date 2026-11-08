import type { SupabaseClient } from '@supabase/supabase-js'
import { releaseHold } from './hold'
import { ownedMailbox } from './thread-mailbox'
import { deleteDraftInMailbox } from './provider-drafts'
import { resolveWorkForDeliverable } from '@/lib/work/resolve'

/**
 * Automatic drafts nobody acted on stop waiting (Liam, 2026-10-27, GEN-1164:
 * drafts about an Oct 10 appointment, an Oct 13 event and an Oct 16 dinner
 * were still pending weeks later). An automatic draft still untouched
 * ('pending_review', never edited or approved) is dismissed when
 *   'age'           it is 7 days old; or
 *   'event_passed'  the day it is about has passed: the latest date the draft
 *                   names (its subject and text) that was still AHEAD when it
 *                   was written (after that UTC day). A date already past or
 *                   current then ("great speaking on Oct 26", "your invoice
 *                   dated today") is not what it is about.
 * Dismissed as the person's dismiss does it, minus the "reviewed" stamp (this
 * isn't their activity): the row goes (only while still untouched), its hold
 * with it when no other draft rests on it, the draft in the mailbox by the id
 * Native Intelligence saved (an edit made in Gmail has a new id and stays), and its work
 * item stops waiting. A draft whose hold is mid-send is left alone. Drafts the
 * person asked for (chat, Generate) and their own are never swept.
 * Runs in the hourly `email-hold-expiry` (src/lib/inngest/email-functions.ts).
 */

/** An untouched automatic draft is dismissed this long after it was written. */
export const AUTO_DRAFT_TTL_MS = 7 * 24 * 60 * 60_000

/** Most drafts one run dismisses (each may cost a provider call); the next hour takes the rest. */
export const MAX_EXPIRED_PER_RUN = 50

const DAY_MS = 24 * 60 * 60_000

/**
 * A day counts as passed this long after its UTC start: the whole day is over
 * in every time zone (UTC-12 to UTC+14) by then.
 */
const DAY_OVER_MS = 2 * DAY_MS

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
}
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?'
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?'
const YEAR = '(?:,?\\s+(\\d{4}))?'
const MONTH_DAY = new RegExp(`\\b${MONTH}\\s+${DAY}\\b${YEAR}`, 'gi')
const DAY_MONTH = new RegExp(`\\b${DAY}\\s+(?:of\\s+)?${MONTH}\\b${YEAR}`, 'gi')
const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/g
const SLASHED = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g

/** The UTC start of a calendar day, or null when it isn't one. */
function utcDay(year: number, month: number, day: number): number | null {
  const ms = Date.UTC(year, month, day)
  const date = new Date(ms)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? ms : null
}

/** A month and day with no year: the year that puts it nearest the anchor. */
function nearestYear(month: number, day: number, anchorMs: number): number | null {
  const year = new Date(anchorMs).getUTCFullYear()
  const options = [year - 1, year, year + 1].map((y) => utcDay(y, month, day)).filter((ms): ms is number => ms !== null)
  if (!options.length) return null
  return options.reduce((best, ms) => (Math.abs(ms - anchorMs) < Math.abs(best - anchorMs) ? ms : best))
}

/**
 * Every calendar date the text names ("Oct 16", "Thursday, October 16th,
 * 2026", "16 October", "2026-10-16", "10/16/2026"), as UTC day starts. A date
 * without a year takes the year nearest `anchorMs`. Relative words
 * ("tomorrow", "Thursday") are not dates here. Pure.
 */
export function mentionedDays(text: string, anchorMs: number): number[] {
  const days: number[] = []
  const push = (ms: number | null) => { if (ms !== null) days.push(ms) }
  const named = (monthName: string, day: string, year: string | undefined) => {
    const month = MONTHS[monthName.toLowerCase().replace('.', '')]
    if (month === undefined) return
    push(year ? utcDay(Number(year), month, Number(day)) : nearestYear(month, Number(day), anchorMs))
  }
  for (const m of text.matchAll(MONTH_DAY)) named(m[1], m[2], m[3])
  for (const m of text.matchAll(DAY_MONTH)) named(m[2], m[1], m[3])
  for (const m of text.matchAll(ISO)) push(utcDay(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  for (const m of text.matchAll(SLASHED)) push(utcDay(Number(m[3]), Number(m[1]) - 1, Number(m[2])))
  return [...new Set(days)].sort((a, b) => a - b)
}

/** The day a draft is about: the latest named day still ahead (after its UTC day) when it was written, or null. Pure. */
export function draftEventDay(text: string, createdMs: number): number | null {
  const createdDay = Math.floor(createdMs / DAY_MS) * DAY_MS
  const ahead = mentionedDays(text, createdMs).filter((day) => day > createdDay)
  return ahead.length ? ahead[ahead.length - 1] : null
}

export interface ExpiringDraft {
  created_at: string | null
  subject?: string | null
  body_text?: string | null
}

/** Why an untouched automatic draft is dismissed now, or null while it still waits. Pure. */
export function draftExpiry(draft: ExpiringDraft, nowMs: number): 'age' | 'event_passed' | null {
  const created = draft.created_at ? Date.parse(draft.created_at) : NaN
  if (!Number.isFinite(created)) return null
  if (nowMs - created >= AUTO_DRAFT_TTL_MS) return 'age'
  const day = draftEventDay(`${draft.subject ?? ''}\n${draft.body_text ?? ''}`, created)
  return day !== null && nowMs >= day + DAY_OVER_MS ? 'event_passed' : null
}

interface DraftRow extends ExpiringDraft {
  id: string
  user_id: string
  account_id: string | null
  hold_id: string | null
  provider_draft_id: string | null
}

export interface DraftExpiryDeps {
  deleteMailboxDraft?: (userId: string, accountId: string, providerDraftId: string) => Promise<boolean>
  resolveWork?: (draftId: string) => Promise<void>
}

async function defaultDeleteMailboxDraft(userId: string, accountId: string, providerDraftId: string): Promise<boolean> {
  const mailbox = await ownedMailbox(userId, accountId)
  return mailbox ? deleteDraftInMailbox(mailbox, providerDraftId) : false
}

/**
 * The hourly sweep: dismisses up to MAX_EXPIRED_PER_RUN untouched automatic
 * drafts past draftExpiry, oldest first. Each draft on its own; never throws.
 */
export async function expireAutomaticDrafts(
  supabase: SupabaseClient,
  now: Date = new Date(),
  deps: DraftExpiryDeps = {},
): Promise<{ age: number; eventPassed: number }> {
  const out = { age: 0, eventPassed: 0 }
  const deleteMailboxDraft = deps.deleteMailboxDraft ?? defaultDeleteMailboxDraft
  const resolveWork = deps.resolveWork ?? ((id: string) => resolveWorkForDeliverable(supabase, { type: 'email_draft', id }))
  let rows: DraftRow[] = []
  try {
    const { data, error } = await supabase
      .from('email_draft')
      .select('id, user_id, account_id, hold_id, provider_draft_id, subject, body_text, created_at')
      .eq('status', 'pending_review')
      .eq('metadata->>origin', 'automatic')
      .order('created_at', { ascending: true })
      .limit(500)
    if (error) throw new Error(error.message)
    rows = (data ?? []) as DraftRow[]
  } catch (err) {
    console.warn('[email-drafts] expiry read failed:', err instanceof Error ? err.message : err)
    return out
  }
  const nowMs = now.getTime()
  const due = rows.map((row) => ({ row, why: draftExpiry(row, nowMs) })).filter((d) => d.why !== null).slice(0, MAX_EXPIRED_PER_RUN)
  for (const { row, why } of due) {
    try {
      // Mid-send: the send settles it (hold.ts markHoldsSending).
      if (row.hold_id) {
        const { data: hold, error } = await supabase.from('email_hold').select('status').eq('user_id', row.user_id).eq('id', row.hold_id).maybeSingle()
        if (error || (hold as { status?: unknown } | null)?.status === 'sending') continue
      }
      // Only while still untouched: an edit or a send since the read keeps it.
      const { data: gone, error } = await supabase.from('email_draft').delete()
        .eq('id', row.id).eq('user_id', row.user_id).eq('status', 'pending_review').select('id')
      if (error || !gone?.length) continue
      if (row.hold_id) {
        // Fail closed: the hold's delete cascades to every draft on it.
        const { data: others, error: othersError } = await supabase.from('email_draft').select('id').eq('user_id', row.user_id).eq('hold_id', row.hold_id).limit(1)
        if (!othersError && others && !others.length) await releaseHold(supabase, row.user_id, row.hold_id)
      }
      if (row.account_id && row.provider_draft_id) await deleteMailboxDraft(row.user_id, row.account_id, row.provider_draft_id).catch(() => false)
      await resolveWork(row.id).catch(() => {})
      if (why === 'age') out.age += 1
      else out.eventPassed += 1
    } catch (err) {
      console.warn('[email-drafts] draft not expired:', err instanceof Error ? err.message : err)
    }
  }
  if (out.age || out.eventPassed) console.info('[email-drafts] expired automatic drafts', out)
  return out
}
