/**
 * The graduation rules (docs/plans/earned-autonomy.md §2): every threshold
 * passing and failing, demotion from each level on one undo or complaint, the
 * cooldowns, "Never", and that the rules never promote on their own (only
 * `eligible`, an offer the person answers).
 */
import { describe, expect, it } from 'vitest'
import {
  DEMOTION_COOLDOWN_DAYS,
  evaluateKind,
  OFFER_DECLINED_COOLDOWN_DAYS,
  QUIET_MIN_DAYS,
  QUIET_RECENT_CLEAN_DAYS,
  QUIET_STREAK,
  RECENT_CLEAN_DAYS,
  TELL_MIN_DAYS,
  TELL_MIN_DISTINCT_DAYS,
  TELL_STREAK,
  TRIVIAL_EDIT_RATIO,
  type OutcomeEvent,
} from '../rules'

const NOW = new Date('2026-11-27T12:00:00Z')
const DAY = 86_400_000
const ago = (days: number, hours = 0) => new Date(NOW.getTime() - days * DAY - hours * 3_600_000).toISOString()
const ev = (outcome: OutcomeEvent['outcome'], daysAgo: number, editRatio?: number): OutcomeEvent => ({ outcome, at: ago(daysAgo), editRatio })

/** `n` clean approvals spread evenly from `spanDays` ago to (almost) now. */
function cleanRun(n: number, spanDays: number, outcome: OutcomeEvent['outcome'] = 'approved', endDaysAgo = 0.1): OutcomeEvent[] {
  return Array.from({ length: n }, (_, i) => ev(outcome, endDaysAgo + (n === 1 ? 0 : (spanDays - endDaysAgo) * (i / (n - 1)))))
}

describe('the thresholds are the plan\'s', () => {
  it('pins every constant (the owner confirms them, decision 2)', () => {
    expect({ TELL_STREAK, TELL_MIN_DAYS, TELL_MIN_DISTINCT_DAYS, QUIET_STREAK, QUIET_MIN_DAYS, RECENT_CLEAN_DAYS, QUIET_RECENT_CLEAN_DAYS, TRIVIAL_EDIT_RATIO, DEMOTION_COOLDOWN_DAYS, OFFER_DECLINED_COOLDOWN_DAYS }).toEqual({
      TELL_STREAK: 10,
      TELL_MIN_DAYS: 7,
      TELL_MIN_DISTINCT_DAYS: 3,
      QUIET_STREAK: 20,
      QUIET_MIN_DAYS: 14,
      RECENT_CLEAN_DAYS: 14,
      QUIET_RECENT_CLEAN_DAYS: 30,
      TRIVIAL_EDIT_RATIO: 0.05,
      DEMOTION_COOLDOWN_DAYS: 14,
      OFFER_DECLINED_COOLDOWN_DAYS: 30,
    })
  })
})

describe('ask → tell', () => {
  it('10 clean approvals over 8 days on many days: eligible for tell, still at ask (only the person promotes)', () => {
    const r = evaluateKind(cleanRun(10, 8), {}, NOW, false)
    expect(r).toMatchObject({ level: 'ask', eligible: 'tell', blocked: null, streak: 10 })
    expect(r.distinctDays).toBeGreaterThanOrEqual(3)
  })

  it('9 is not enough, and says one more', () => {
    const r = evaluateKind(cleanRun(9, 8), {}, NOW, false)
    expect(r).toMatchObject({ eligible: null, blocked: 'streak', needs: { more: 1, days: 0 } })
  })

  it('10 in one afternoon is not a week', () => {
    const r = evaluateKind(cleanRun(10, 0.2), {}, NOW, false)
    expect(r).toMatchObject({ eligible: null, blocked: 'span' })
    expect(r.needs.days).toBeGreaterThan(0)
  })

  it('9 on one day and 1 a week before: the span holds, but not 3 different days', () => {
    const events = [...Array.from({ length: 9 }, (_, i) => ({ outcome: 'approved' as const, at: new Date(NOW.getTime() - 3_600_000 * (i + 1)).toISOString() })), ev('approved', 8)]
    expect(evaluateKind(events, {}, NOW, false)).toMatchObject({ eligible: null, blocked: 'distinct_days' })
  })

  it('a dismissal breaks the streak: only the ones after it count', () => {
    const events = [...cleanRun(6, 3), ev('dismissed', 4), ...cleanRun(10, 20, 'approved', 5)]
    expect(evaluateKind(events, {}, NOW, false)).toMatchObject({ streak: 6, eligible: null, blocked: 'streak' })
  })

  it('a real rewrite breaks the streak; a trivial edit neither counts nor breaks it', () => {
    const rewrite = [...cleanRun(5, 3), ev('approved_edited', 4, 0.4), ...cleanRun(5, 12, 'approved', 5)]
    expect(evaluateKind(rewrite, {}, NOW, false).streak).toBe(5)
    const typo = [...cleanRun(5, 3), ev('approved_edited', 4, TRIVIAL_EDIT_RATIO), ...cleanRun(5, 12, 'approved', 5)]
    expect(evaluateKind(typo, {}, NOW, false)).toMatchObject({ streak: 10, eligible: 'tell' })
  })

  it('an edit with no ratio is a rewrite (the safe side)', () => {
    const events = [...cleanRun(5, 3), ev('approved_edited', 4), ...cleanRun(5, 12, 'approved', 5)]
    expect(evaluateKind(events, {}, NOW, false).streak).toBe(5)
  })

  it('expired and failed cards are neutral', () => {
    const events = [...cleanRun(5, 3), ev('expired', 3.5), ev('failed', 3.6), ...cleanRun(5, 12, 'approved', 4)]
    expect(evaluateKind(events, {}, NOW, false)).toMatchObject({ streak: 10, eligible: 'tell' })
  })

  it('a dismissal in the last 14 days blocks the offer even when the streak after it is long enough', () => {
    // Streak of 10 over 9 days after a dismissal 10 days ago.
    const events = [...cleanRun(10, 9), ev('dismissed', 10)]
    expect(evaluateKind(events, {}, NOW, false)).toMatchObject({ streak: 10, eligible: null, blocked: 'recent_no' })
  })

  it('"Not now" holds offers for 30 days', () => {
    expect(evaluateKind(cleanRun(10, 8), { offerDeclinedAt: ago(29) }, NOW, false)).toMatchObject({ eligible: null, blocked: 'declined_cooldown' })
    expect(evaluateKind(cleanRun(10, 8), { offerDeclinedAt: ago(31) }, NOW, false)).toMatchObject({ eligible: 'tell' })
  })

  it('"Never" pins it to ask whatever the record says, and even over a stored level', () => {
    expect(evaluateKind(cleanRun(40, 30), { pinnedAsk: true }, NOW, false)).toMatchObject({ level: 'ask', eligible: null, blocked: 'pinned' })
    expect(evaluateKind(cleanRun(40, 30), { pinnedAsk: true, level: 'quiet', grantedAt: ago(60) }, NOW, false)).toMatchObject({ level: 'ask', eligible: null })
  })

  it('a hard-limited kind never graduates: a perfect record and a stored level both read ask', () => {
    const perfect = cleanRun(200, 120)
    expect(evaluateKind(perfect, {}, NOW, true)).toMatchObject({ level: 'ask', eligible: null, blocked: 'hard_limit' })
    expect(evaluateKind(perfect, { level: 'tell', grantedAt: ago(100) }, NOW, true)).toMatchObject({ level: 'ask', eligible: null, blocked: 'hard_limit' })
    expect(evaluateKind(perfect, { level: 'quiet', grantedAt: ago(100) }, NOW, true)).toMatchObject({ level: 'ask', eligible: null, blocked: 'hard_limit' })
    expect(evaluateKind(perfect, { level: 'quiet', grantedAt: ago(100) }, NOW, true, { quiet: true })).toMatchObject({ level: 'ask', eligible: null, blocked: 'hard_limit' })
  })

  it('no record: ask, needs all ten', () => {
    expect(evaluateKind([], {}, NOW, false)).toMatchObject({ level: 'ask', eligible: null, blocked: 'streak', needs: { more: 10, days: 7 }, lastAt: null })
  })

  it('order of input does not matter', () => {
    const events = cleanRun(10, 8)
    expect(evaluateKind([...events].reverse(), {}, NOW, false)).toMatchObject({ eligible: 'tell', streak: 10 })
  })
})

describe('demotion: one undo or complaint, straight back to ask', () => {
  const granted = ago(20)

  it('at tell, one undo after the grant → ask, demoted, not eligible (cooldown)', () => {
    const events = [ev('undone', 1), ...cleanRun(10, 19, 'ran', 2)]
    const r = evaluateKind(events, { level: 'tell', grantedAt: granted }, NOW, false)
    expect(r).toMatchObject({ level: 'ask', demoted: true, eligible: null, streak: 0 })
  })

  it('at quiet, one complaint → ask (never one step down to tell)', () => {
    const events = [ev('complaint', 1), ...cleanRun(30, 19, 'ran', 2)]
    expect(evaluateKind(events, { level: 'quiet', grantedAt: granted }, NOW, false, { quiet: true })).toMatchObject({ level: 'ask', demoted: true })
    expect(evaluateKind(events, { level: 'quiet', grantedAt: granted }, NOW, false)).toMatchObject({ level: 'ask', demoted: true })
  })

  it('an undo from BEFORE the grant does not demote', () => {
    const events = [...cleanRun(5, 5, 'ran'), ev('undone', 25)]
    expect(evaluateKind(events, { level: 'tell', grantedAt: granted }, NOW, false)).toMatchObject({ level: 'tell', demoted: false })
  })

  it('after a stored demotion the streak restarts and no offer comes for 14 days', () => {
    const demotedAt = ago(10)
    // 10 clean since the demotion, over 9.5 days, and old ones before it.
    const events = [...cleanRun(10, 9.5), ...cleanRun(10, 30, 'approved', 11)]
    const r = evaluateKind(events, { demotedAt }, NOW, false)
    expect(r.streak).toBe(10)
    expect(r).toMatchObject({ eligible: null, blocked: 'demotion_cooldown' })
    const later = new Date(NOW.getTime() + 5 * DAY)
    expect(evaluateKind(events, { demotedAt }, later, false)).toMatchObject({ eligible: 'tell' })
  })

  it('a dismissal at ask resets the streak but is not a demotion', () => {
    const r = evaluateKind([ev('dismissed', 0.5), ...cleanRun(10, 9, 'approved', 1)], {}, NOW, false)
    expect(r).toMatchObject({ level: 'ask', demoted: false, streak: 0 })
  })
})

describe('tell → quiet', () => {
  it('20 clean runs, 15 days at tell, no undo: eligible for quiet, still at tell', () => {
    const r = evaluateKind(cleanRun(20, 14, 'ran'), { level: 'tell', grantedAt: ago(15) }, NOW, false, { quiet: true })
    expect(r).toMatchObject({ level: 'tell', eligible: 'quiet', streak: 20 })
  })

  it('approvals at ask before the grant do not count toward quiet', () => {
    const events = [...cleanRun(5, 3, 'ran'), ...cleanRun(30, 40, 'approved', 16)]
    expect(evaluateKind(events, { level: 'tell', grantedAt: ago(15) }, NOW, false, { quiet: true })).toMatchObject({ streak: 5, eligible: null, blocked: 'streak' })
  })

  it('20 runs in the first week at tell: wait for two weeks', () => {
    expect(evaluateKind(cleanRun(20, 6, 'ran'), { level: 'tell', grantedAt: ago(7) }, NOW, false, { quiet: true })).toMatchObject({ eligible: null, blocked: 'span' })
  })

  it('quiet is the top: nothing more to offer', () => {
    expect(evaluateKind(cleanRun(50, 40, 'ran'), { level: 'quiet', grantedAt: ago(45) }, NOW, false, { quiet: true })).toMatchObject({ level: 'quiet', eligible: null, blocked: 'at_top' })
  })
})

describe('quiet is off at launch (Liam, 11-27, decision 2: "Ceiling at launch is tell")', () => {
  it('a record that would earn quiet is never offered it while the quiet switch is off', () => {
    const r = evaluateKind(cleanRun(20, 14, 'ran'), { level: 'tell', grantedAt: ago(15) }, NOW, false)
    expect(r).toMatchObject({ level: 'tell', eligible: null, blocked: 'at_top' })
  })

  it('a stored quiet reads as tell while the switch is off', () => {
    expect(evaluateKind(cleanRun(5, 3, 'ran'), { level: 'quiet', grantedAt: ago(40) }, NOW, false)).toMatchObject({ level: 'tell', eligible: null })
  })

  it('ask → tell is unaffected by the quiet switch', () => {
    expect(evaluateKind(cleanRun(10, 8), {}, NOW, false)).toMatchObject({ eligible: 'tell' })
  })
})
