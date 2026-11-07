/**
 * The win-back recipe (roadmap D2): customers quiet for N months, two short
 * emails, rolling. Its copy must pass the sequence's own write checks and
 * launch for anyone: every merge field has a fallback.
 */
import { describe, it, expect } from 'vitest'
import { recipeCampaign, isCampaignRecipe } from '../recipes'
import { parseAudience } from '../shape'
import { normalizeSteps } from '@/lib/sequences/mutations'
import { buildStepEmail } from '@/lib/sequences/engine-logic'

describe('win_back', () => {
  it('targets customers quiet for 6 months by default, rolling, with two emails a week apart', () => {
    const r = recipeCampaign('win_back', {}, 'Bright Weave')
    if (r instanceof Error) throw r
    expect(r.audience).toEqual({ relationship_types: ['customer'], last_contacted_more_than_days: 180 })
    expect(parseAudience(r.audience).ok).toBe(true)
    expect(r.rolling).toBe(true)
    expect(r.sequence.steps.map((s) => [s.step_order, s.delay_days, Boolean(s.subject)])).toEqual([[1, 0, true], [2, 7, false]])
    expect(normalizeSteps(r.sequence.steps).ok).toBe(true)
  })

  it('renders for a contact with no name and a sender with none: nothing blocks a launch', () => {
    const r = recipeCampaign('win_back', {}, 'Bright Weave')
    if (r instanceof Error) throw r
    for (const step of r.sequence.steps) {
      const email = buildStepEmail(
        { overrides: null, thread_subject: 'Checking in, there', provider_thread_id: 't-1' },
        { step_order: step.step_order, subject: step.subject ?? null, body: step.body },
        {},
        [],
        { first_name: null, last_name: null, full_name: null, company: null, email: 'x@example.com' },
        { name: null, email: 'owner@brightweave.com' },
      )
      expect(email.blocked, step.body).toBeFalsy()
    }
    expect(r.sequence.steps[0].body).toContain('{{sender_name|Bright Weave}}')
  })

  it('takes months from 1 to 36, and keeps a stray brace out of the sign-off', () => {
    const r = recipeCampaign('win_back', { months: 12 }, 'Bright {Weave}|')
    if (r instanceof Error) throw r
    expect(r.audience.last_contacted_more_than_days).toBe(360)
    expect(r.sequence.steps[0].body).toContain('{{sender_name|Bright Weave}}')
    for (const months of [0, 37, 2.5]) expect(recipeCampaign('win_back', { months })).toBeInstanceOf(Error)
  })

  it('knows only its own recipes', () => {
    expect(isCampaignRecipe('win_back')).toBe(true)
    expect(isCampaignRecipe('weekly_posts')).toBe(false)
  })
})
