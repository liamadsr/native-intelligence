/**
 * The graduation rules (docs/plans/earned-autonomy.md §2): one pure function
 * over a kind's outcomes and the person's own decisions, saying the level it
 * is at, whether it is eligible to be OFFERED the next one, and what it still
 * needs. It never promotes: only the person's yes on an offer does (§3), and
 * nothing writes a level in phase 1.
 *
 * Levels: ask (a card, today) → tell (do it and tell me, with undo) → quiet
 * (do it, in the daily digest). A single undo or complaint puts a kind back to
 * ask at once, from either.
 *
 * Liam, 11-27 (roadmap #14, "let's do it"): "The agent takes over recurring
 * work as it earns your trust." The numbers below were the plan's proposal;
 * Liam, 11-27, decision 4: "Thresholds kept as proposed".
 *
 * Quiet is OFF at launch (Liam, 11-27, decision 2: "Ceiling at launch is
 * tell"): unless the caller passes `quiet: true` (EARNED_AUTONOMY_QUIET,
 * config.ts), nothing is offered quiet and a stored quiet reads as tell.
 */

export const AUTONOMY_LEVELS = ['ask', 'tell', 'quiet'] as const
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number]

export const AUTONOMY_OUTCOMES = ['approved', 'approved_edited', 'dismissed', 'expired', 'failed', 'ran', 'undone', 'complaint'] as const
export type AutonomyOutcomeKind = (typeof AUTONOMY_OUTCOMES)[number]

const DAY = 86_400_000

/**
 * Ask → tell: 10 clean approvals in a row. With none rejected in 10, the rule
 * of succession puts the next one's chance of rejection near 1 in 12; at tell
 * the person still sees each one and can undo it.
 */
export const TELL_STREAK = 10
/** …spanning at least a week: one afternoon's batch says little about next week. */
export const TELL_MIN_DAYS = 7
/** …on at least three different days: a habit, not a batch. */
export const TELL_MIN_DISTINCT_DAYS = 3
/** Tell → quiet: 20 clean autonomous runs at tell, none undone (0 undos in 30 bounds the rate near 10%, rule of three). */
export const QUIET_STREAK = 20
/** …after at least two weeks at tell. */
export const QUIET_MIN_DAYS = 14
/** No dismissal, undo or complaint this recently before an offer of tell. */
export const RECENT_CLEAN_DAYS = 14
/** …nor an undo or complaint this recently before an offer of quiet. */
export const QUIET_RECENT_CLEAN_DAYS = 30
/** An edit at or under this ratio (a typo, a sign-off) neither counts nor breaks the streak. */
export const TRIVIAL_EDIT_RATIO = 0.05
/** After a demotion, no offer for this long. */
export const DEMOTION_COOLDOWN_DAYS = 14
/** After "Not now", no offer for this long. */
export const OFFER_DECLINED_COOLDOWN_DAYS = 30
/** Even graduated, the 21st autonomous call of a kind in a day is a card. */
export const MAX_AUTONOMOUS_PER_KIND_PER_DAY = 20
/** …and the 51st across a person's kinds. */
export const MAX_AUTONOMOUS_PER_PERSON_PER_DAY = 50
/** How many of a kind's newest outcomes the rules read (enough for both streaks and the windows). */
export const OUTCOMES_READ = 200

export interface OutcomeEvent {
  outcome: AutonomyOutcomeKind
  /** ISO time it happened. */
  at: string
  /** For approved_edited: how much changed (edit-ratio.ts). */
  editRatio?: number | null
}

/** The person's decisions on a kind (autonomy_kind), all optional: a kind nobody decided is at ask. */
export interface KindDecisions {
  level?: AutonomyLevel | null
  pinnedAsk?: boolean | null
  grantedAt?: string | null
  demotedAt?: string | null
  offerDeclinedAt?: string | null
}

export type NotEligible =
  | 'hard_limit'
  | 'pinned'
  | 'at_top'
  | 'streak'
  | 'span'
  | 'distinct_days'
  | 'recent_no'
  | 'demotion_cooldown'
  | 'declined_cooldown'

export interface KindEvaluation {
  /** Where it is now: the person's grant, unless an undo or complaint since demotes it. */
  level: AutonomyLevel
  /** True when an undo or complaint after the grant puts it back to ask (the caller writes the demotion). */
  demoted: boolean
  /** The level it could be OFFERED now, or null. */
  eligible: Exclude<AutonomyLevel, 'ask'> | null
  /** Why not, when not eligible (the first reason in rule order). */
  blocked: NotEligible | null
  /** Clean approvals in a row at ask (or clean runs at tell). */
  streak: number
  /** Days from the streak's first clean one to now. */
  streakDays: number
  distinctDays: number
  /** What it still needs before an offer: more clean ones, more days. */
  needs: { more: number; days: number }
  counts: Record<AutonomyOutcomeKind, number>
  lastAt: string | null
}

function ms(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : NaN
}

function zeroCounts(): Record<AutonomyOutcomeKind, number> {
  return Object.fromEntries(AUTONOMY_OUTCOMES.map((o) => [o, 0])) as Record<AutonomyOutcomeKind, number>
}

/** Does this outcome break a streak? (a no, or a real rewrite) */
function breaks(e: OutcomeEvent): boolean {
  if (e.outcome === 'dismissed' || e.outcome === 'undone' || e.outcome === 'complaint') return true
  if (e.outcome === 'approved_edited') return !(typeof e.editRatio === 'number' && e.editRatio <= TRIVIAL_EDIT_RATIO)
  return false
}

/** The clean ones in a row, newest back, among events after `since`; `clean` says which outcomes count. */
function streakOf(events: OutcomeEvent[], since: number, clean: ReadonlySet<AutonomyOutcomeKind>): OutcomeEvent[] {
  const out: OutcomeEvent[] = []
  for (const e of events) {
    const t = ms(e.at)
    if (!Number.isFinite(t)) continue
    if (Number.isFinite(since) && t <= since) break
    if (breaks(e)) break
    if (clean.has(e.outcome)) out.push(e)
  }
  return out
}

const ASK_CLEAN: ReadonlySet<AutonomyOutcomeKind> = new Set(['approved'])
const TELL_CLEAN: ReadonlySet<AutonomyOutcomeKind> = new Set(['ran'])

export function evaluateKind(
  outcomes: readonly OutcomeEvent[],
  decisions: KindDecisions,
  now: Date,
  hardLimited: boolean,
  opts: { quiet?: boolean } = {},
): KindEvaluation {
  const quietOn = opts.quiet === true
  const nowMs = now.getTime()
  // Newest first, whatever order they came in.
  const events = [...outcomes].filter((e) => Number.isFinite(ms(e.at))).sort((a, b) => ms(b.at) - ms(a.at))
  const counts = zeroCounts()
  for (const e of events) if (e.outcome in counts) counts[e.outcome]++
  const lastAt = events[0]?.at ?? null

  const granted = ms(decisions.grantedAt)
  let level: AutonomyLevel = hardLimited ? 'ask' : decisions.level === 'tell' || decisions.level === 'quiet' ? decisions.level : 'ask'
  if (decisions.pinnedAsk) level = 'ask'
  // Decision 2 (Liam, 11-27): with quiet off, a stored quiet is tell.
  if (level === 'quiet' && !quietOn) level = 'tell'
  // One undo or complaint after the grant: straight back to ask.
  const demoted = level !== 'ask' && events.some((e) => (e.outcome === 'undone' || e.outcome === 'complaint') && (!Number.isFinite(granted) || ms(e.at) > granted))
  if (demoted) level = 'ask'

  // The streak restarts at a demotion (stored, or the one found just now).
  const demotedAt = demoted
    ? Math.max(...events.filter((e) => e.outcome === 'undone' || e.outcome === 'complaint').map((e) => ms(e.at)))
    : ms(decisions.demotedAt)
  const atAsk = level === 'ask'
  const since = atAsk ? demotedAt : granted
  const streak = streakOf(events, since, atAsk ? ASK_CLEAN : TELL_CLEAN)
  const first = streak.length ? ms(streak[streak.length - 1].at) : NaN
  const streakDays = Number.isFinite(first) ? (nowMs - first) / DAY : 0
  const distinctDays = new Set(streak.map((e) => e.at.slice(0, 10))).size

  const base = { level, demoted, streak: streak.length, streakDays, distinctDays, counts, lastAt }
  const no = (blocked: NotEligible, needs = { more: 0, days: 0 }): KindEvaluation => ({ ...base, eligible: null, blocked, needs })

  if (hardLimited) return no('hard_limit')
  if (decisions.pinnedAsk) return no('pinned')
  if (level === 'quiet') return no('at_top')
  // Quiet off: tell is the top (decision 2).
  if (level === 'tell' && !quietOn) return no('at_top')

  const wantStreak = atAsk ? TELL_STREAK : QUIET_STREAK
  const wantDays = atAsk ? TELL_MIN_DAYS : QUIET_MIN_DAYS
  // At tell, the days count from the grant (two weeks of watching it work).
  const daysSoFar = atAsk ? streakDays : Number.isFinite(granted) ? (nowMs - granted) / DAY : 0
  const needs = { more: Math.max(0, wantStreak - streak.length), days: Math.max(0, Math.ceil(wantDays - daysSoFar)) }
  if (streak.length < wantStreak) return no('streak', needs)
  if (daysSoFar < wantDays) return no('span', needs)
  if (atAsk && distinctDays < TELL_MIN_DISTINCT_DAYS) return no('distinct_days', needs)
  const recentDays = atAsk ? RECENT_CLEAN_DAYS : QUIET_RECENT_CLEAN_DAYS
  const recentNo = events.some((e) => {
    const bad = atAsk ? e.outcome === 'dismissed' || e.outcome === 'undone' || e.outcome === 'complaint' : e.outcome === 'undone' || e.outcome === 'complaint'
    return bad && nowMs - ms(e.at) < recentDays * DAY
  })
  if (recentNo) return no('recent_no', needs)
  if (Number.isFinite(demotedAt) && nowMs - demotedAt < DEMOTION_COOLDOWN_DAYS * DAY) return no('demotion_cooldown', needs)
  const declined = ms(decisions.offerDeclinedAt)
  if (Number.isFinite(declined) && nowMs - declined < OFFER_DECLINED_COOLDOWN_DAYS * DAY) return no('declined_cooldown', needs)
  return { ...base, eligible: atAsk ? 'tell' : 'quiet', blocked: null, needs }
}
