/**
 * The Rankings page's words, pure, so the views and their tests read the
 * same strings. House style as ../ui-helpers.ts: sentence case, plural-aware
 * counts, a clause whose value is missing dropped, ` · ` between clauses.
 *
 * Positions: a LOWER number is better. A keyword's `change` (from the
 * backend) is places gained, so positive is up the page (better).
 */
import type { SeoMarketOptions } from '@/lib/seo/keywords/view'
import type {
  RankDevice,
  RankEstimateView,
  RankPositionView,
  RankRunView,
  RankTrackerView,
  RankTrackingDevices,
  RankTrackingScheduleInterval,
  RankTrendPoint,
} from '@/lib/seo/rank/view'
import type { SeoSpendView } from '@/lib/seo/spend-view'
import type { SeoDataState } from '../shared/data-status'
import { count, relativeWhen } from '../ui-helpers'
import type { KeywordsOutcome } from './api'

// ── Settings ─────────────────────────────────────────────────────────────

export const DEVICE_OPTIONS: ReadonlyArray<{ value: RankTrackingDevices; label: string }> = [
  { value: 'mobile', label: 'Mobile' },
  { value: 'desktop', label: 'Desktop' },
  { value: 'both', label: 'Both' },
]

/** The backend's order (manual first: creating a tracker never starts spending on its own). */
export const INTERVAL_OPTIONS: ReadonlyArray<{ value: RankTrackingScheduleInterval; label: string }> = [
  { value: 'manual', label: 'By hand' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
]

export const DEVICE_LABEL: Record<RankDevice, string> = { mobile: 'Mobile', desktop: 'Desktop' }

/** "mobile", "desktop", "mobile and desktop". */
export function devicesWords(devices: RankTrackingDevices): string {
  return devices === 'both' ? 'mobile and desktop' : devices
}

/** "checked daily", "checked by hand". */
export function scheduleWords(interval: RankTrackingScheduleInterval): string {
  return interval === 'manual' ? 'checked by hand' : `checked ${interval}`
}

/**
 * Where the tracker reads Google from: the city when it has one ("Austin,
 * Texas"), else the country, and the language only when it is not the
 * country's own. Null when the markets aren't known yet.
 */
export function marketWords(
  tracker: Pick<RankTrackerView, 'location_code' | 'language_code' | 'location_name'>,
  markets: SeoMarketOptions | null,
): string | null {
  const location = markets?.locations.find((l) => l.code === tracker.location_code) ?? null
  let place: string | null = location?.label ?? null
  if (tracker.location_name) {
    const parts = tracker.location_name.split(',').map((p) => p.trim()).filter(Boolean)
    if (location && parts.length > 1 && parts[parts.length - 1] === location.label) parts.pop()
    place = parts.join(', ') || place
  }
  if (!place) return null
  if (location && tracker.language_code !== location.default_language) {
    const language =
      location.languages.find((l) => l.code === tracker.language_code)?.label ??
      markets?.serp_languages.find((l) => l.code === tracker.language_code)?.label ??
      tracker.language_code
    return `${place} · ${language}`
  }
  return place
}

/** An index row's sub-line: "31 keywords · United States · mobile · checked daily". */
export function trackerSubline(tracker: RankTrackerView, markets: SeoMarketOptions | null): string {
  return [
    tracker.keyword_count > 0 ? count(tracker.keyword_count, 'keyword') : 'No keywords yet',
    marketWords(tracker, markets),
    devicesWords(tracker.devices),
    scheduleWords(tracker.schedule.interval),
  ]
    .filter(Boolean)
    .join(' · ')
}

/** "today 9:00 AM", "tomorrow 9:00 AM", "Mon 9:00 AM", "Nov 30"; null when it isn't a date. */
export function nextCheckWords(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  if (at.getTime() <= now.getTime()) return 'due now'
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(at) - day(now)) / 86_400_000)
  if (days === 0) return `today ${time}`
  if (days === 1) return `tomorrow ${time}`
  if (days < 7) return `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })
}

/**
 * The tracker's quiet line under its title: "United States · mobile ·
 * checked daily · next check tomorrow 9:00 AM", or "… · Paused".
 */
export function trackerSettingsLine(tracker: RankTrackerView, markets: SeoMarketOptions | null, now: Date = new Date()): string {
  const scheduled = tracker.schedule.interval !== 'manual'
  const next = scheduled && !tracker.paused ? nextCheckWords(tracker.next_check_at, now) : null
  return [
    marketWords(tracker, markets),
    devicesWords(tracker.devices),
    scheduleWords(tracker.schedule.interval),
    tracker.paused ? 'Paused' : next ? `next check ${next}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The status word an index row shows, when there is one. */
export function trackerStatus(tracker: RankTrackerView): { word: string; tone: 'muted' | 'red'; title?: string } | null {
  const run = tracker.latest_run
  if (run?.status === 'running') return { word: 'Checking', tone: 'muted' }
  if (run?.status === 'queued') return { word: 'Starting', tone: 'muted' }
  if (tracker.paused) return { word: 'Paused', tone: 'muted', title: 'Its scheduled checks are paused' }
  if (tracker.skip_reason) return { word: 'Skipped', tone: 'muted', title: tracker.skip_message ?? undefined }
  if (run?.status === 'failed') return { word: 'Check failed', tone: 'red', title: run.error ?? undefined }
  return null
}

// ── Money ────────────────────────────────────────────────────────────────

/** "$0.06", or "less than a cent". Only ever a figure the estimate route returned. */
export function usdWords(usd: number): string {
  if (usd < 0.005) return 'less than a cent'
  return `$${usd.toFixed(2)}`
}

const about = (usd: number) => (usd < 0.005 ? 'less than a cent' : `about ${usdWords(usd)}`)

/** "A check costs about $0.06. Daily, about $1.80 a month." Null with no keywords. */
export function estimateSentence(estimate: RankEstimateView): string | null {
  if (estimate.keyword_count === 0) return null
  const check = `A check costs ${about(estimate.per_check_usd)}.`
  if (estimate.schedule === 'manual' || estimate.checks_per_month <= 0) return check
  const how = estimate.schedule.charAt(0).toUpperCase() + estimate.schedule.slice(1)
  return `${check} ${how}, ${about(estimate.monthly_usd)} a month.`
}

/** What a tracker spends on its own each month, in words: "about $1.80 a month" or "nothing on its own". */
export function monthlyWords(estimate: RankEstimateView): string {
  if (estimate.checks_per_month <= 0 || estimate.keyword_count === 0) return 'nothing on its own'
  return `${about(estimate.monthly_usd)} a month`
}

// ── Keywords ─────────────────────────────────────────────────────────────

/** The keywords typed one per line, as the tracker will store them (trimmed, lowercased, once each). */
export function parseKeywordLines(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const k = line.trim().replace(/\s+/g, ' ').toLowerCase()
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}

/** "Added 12 keywords · 3 already tracked · 2 over the limit". */
export function keywordsOutcomeWords(outcome: KeywordsOutcome, cap: number): string {
  return [
    outcome.added.length > 0 ? `Added ${count(outcome.added.length, 'keyword')}` : 'No new keywords',
    outcome.already_tracked > 0 ? `${outcome.already_tracked.toLocaleString()} already tracked` : null,
    outcome.over_cap > 0 ? `${outcome.over_cap.toLocaleString()} over the limit of ${cap.toLocaleString()}` : null,
    outcome.rejected > 0 ? `${outcome.rejected.toLocaleString()} left out (empty or too long)` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

// ── Positions ────────────────────────────────────────────────────────────

/** A keyword's position cell: the number, "Not in top 20", or a dash saying why. */
export function positionCell(view: RankPositionView | null, depth: number): { text: string; muted: boolean; title?: string } {
  if (!view || view.status === 'not_checked') return { text: '—', muted: true, title: 'Not checked yet' }
  if (view.status === 'not_found' || view.position === null) {
    return { text: `Not in top ${depth}`, muted: true, title: `Not in the first ${depth} Google results` }
  }
  return { text: view.position.toLocaleString(), muted: false }
}

export type ChangeTone = 'up' | 'down'

/** A keyword's move since the previous check; null when there is none to show. */
export function changeNote(view: RankPositionView | null): { text: string; tone: ChangeTone; title: string } | null {
  if (!view) return null
  if (view.movement === 'up' && view.change) {
    return { text: `↑ ${view.change.toLocaleString()}`, tone: 'up', title: `Up ${count(view.change, 'place')} since the last check` }
  }
  if (view.movement === 'down' && view.change) {
    const n = Math.abs(view.change)
    return { text: `↓ ${n.toLocaleString()}`, tone: 'down', title: `Down ${count(n, 'place')} since the last check` }
  }
  if (view.movement === 'new') return { text: 'New', tone: 'up', title: 'Found this check, not in the one before' }
  if (view.movement === 'lost') return { text: 'Dropped', tone: 'down', title: 'Found in the check before, not this one' }
  return null
}

/** A tile's note for a count where more is better, since the last check: "2 more", "1 fewer". */
export function countChange(now: number, before: number | null | undefined): { note: string; tone: 'up' | 'down' | 'flat' } | null {
  if (before === null || before === undefined) return null
  const d = now - before
  if (d === 0) return { note: 'No change', tone: 'flat' }
  return d > 0 ? { note: `${d.toLocaleString()} more`, tone: 'up' } : { note: `${Math.abs(d).toLocaleString()} fewer`, tone: 'down' }
}

/** The average position's note since the last check, where LOWER is better: "1.4 better". */
export function averageChange(now: number | null, before: number | null | undefined): { note: string; tone: 'up' | 'down' | 'flat' } | null {
  if (now === null || before === null || before === undefined) return null
  const d = Math.round((before - now) * 10) / 10
  if (d === 0) return { note: 'No change', tone: 'flat' }
  const n = Math.abs(d).toLocaleString(undefined, { maximumFractionDigits: 1 })
  return d > 0 ? { note: `${n} better`, tone: 'up' } : { note: `${n} worse`, tone: 'down' }
}

/** The two newest completed checks of a device's trend: the newest and the one before. */
export function lastTwo(points: readonly RankTrendPoint[] | undefined): { last: RankTrendPoint | null; previous: RankTrendPoint | null } {
  if (!points || points.length === 0) return { last: null, previous: null }
  const sorted = [...points].sort((a, b) => Date.parse(a.checked_at) - Date.parse(b.checked_at))
  return { last: sorted[sorted.length - 1], previous: sorted.length > 1 ? sorted[sorted.length - 2] : null }
}

// ── Checks ───────────────────────────────────────────────────────────────

/** The run rail's verb and clauses: "Checking rankings · 31 keywords · started 12 minutes ago". */
export function runRailLine(run: RankRunView, now: Date = new Date()): { verb: string; clauses: string[] } {
  const total = run.keywords_total
  const done = run.keywords_checked
  const clauses: string[] = []
  if (total > 0) clauses.push(done > 0 && done < total ? `${done.toLocaleString()} of ${count(total, 'keyword')}` : count(total, 'keyword'))
  const when = relativeWhen(run.started_at ?? run.created_at, now)
  if (when) clauses.push(`started ${when}`)
  return { verb: run.status === 'queued' ? 'Starting the check' : 'Checking rankings', clauses }
}

export const RUN_STATUS_WORD: Record<RankRunView['status'], string> = {
  queued: 'Starting',
  running: 'Checking',
  completed: 'Done',
  failed: 'Failed',
  canceled: 'Stopped',
}

/** "Nov 12, 9:04 AM". */
export function checkWhen(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}

// ── Lookups on or off ───────────────────────────────────────────────────

const OFF_MESSAGE = 'Search data isn’t set up on this server yet'

/** The spend read, or (when it failed) what the trackers route says about the server. */
export function dataView(seo: Pick<SeoDataState, 'view'>, configured: boolean | undefined): SeoSpendView | null {
  if (seo.view) return seo.view
  if (configured === false) {
    return { spent_dollars: 0, cap_dollars: 0, resets_at: '', configured: false, can_buy: false, refusal: { code: 'SEO_NOT_CONFIGURED', message: OFF_MESSAGE } }
  }
  return null
}

