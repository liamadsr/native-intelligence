import { describe, it, expect } from 'vitest'
import {
  DEFAULT_OPT_OUT_LINE,
  defaultStepBody,
  describeEnrollmentProgress,
  describeSendWindow,
  groupLaunchFailures,
  humanizeSendTime,
  renderSequencePreview,
  SAMPLE_PREVIEW_CONTACT,
  replyRate,
  summarizeEnrollResult,
  timezoneAbbreviation,
  unresolvedTokenLabel,
} from '@/lib/sequences/ui-helpers'

// ── summarizeEnrollResult ────────────────────────────────────────────────

describe('summarizeEnrollResult', () => {
  it('summarizes enrolled + per-reason skip counts', () => {
    const msg = summarizeEnrollResult({
      enrolled: Array.from({ length: 14 }, (_, i) => `c${i}`),
      skipped: [
        { contact_id: 'a', reason: 'already_active' },
        { contact_id: 'b', reason: 'already_active' },
        { contact_id: 'c', reason: 'no_email' },
      ],
    })
    expect(msg).toBe('14 enrolled, 2 skipped (already in a sequence), 1 skipped (no email)')
  })

  it('reads cleanly with nothing skipped', () => {
    expect(summarizeEnrollResult({ enrolled: ['a'], skipped: [] })).toBe('1 enrolled')
  })

  it('passes unknown skip reasons through verbatim', () => {
    const msg = summarizeEnrollResult({
      enrolled: [],
      skipped: [{ contact_id: 'a', reason: 'brand_new_reason' }],
    })
    expect(msg).toBe('0 enrolled, 1 skipped (brand_new_reason)')
  })

  it('labels suppression skips', () => {
    const msg = summarizeEnrollResult({
      enrolled: [],
      skipped: [{ contact_id: 'a', reason: 'suppressed' }],
    })
    expect(msg).toContain('on the do-not-email list')
  })

  // Enrolling into an already-launched sequence stages the contacts inert
  // (next_send_at NULL) — the summary must not read as "they're in the wave".
  it('says "staged" + spells out the launch follow-through for a live sequence', () => {
    const msg = summarizeEnrollResult(
      { enrolled: ['a', 'b'], skipped: [{ contact_id: 'c', reason: 'no_email' }] },
      { requiresLaunch: true },
    )
    expect(msg).toBe(
      '2 staged, 1 skipped (no email) — run Review & launch to schedule them',
    )
  })

  it('omits the launch call-to-action when nothing was actually staged', () => {
    const msg = summarizeEnrollResult(
      { enrolled: [], skipped: [{ contact_id: 'a', reason: 'already_active' }] },
      { requiresLaunch: true },
    )
    expect(msg).toBe('0 staged, 1 skipped (already in a sequence)')
  })
})

// ── groupLaunchFailures ──────────────────────────────────────────────────

describe('groupLaunchFailures', () => {
  it('groups the launch 400 payload back onto enrollment rows', () => {
    const grouped = groupLaunchFailures([
      { enrollment_id: 'e1', step_order: 2, tokens: ['company'] },
      { enrollment_id: 'e1', step_order: 1, tokens: ['first_name', 'company'] },
      { enrollment_id: 'e2', step_order: 3, tokens: ['missing:subject'] },
    ])
    expect(grouped.size).toBe(2)
    expect(grouped.get('e1')).toEqual({
      steps: [1, 2],
      tokens: ['company', 'first_name'],
    })
    expect(grouped.get('e2')).toEqual({ steps: [3], tokens: ['missing:subject'] })
  })

  it('returns an empty map for no failures', () => {
    expect(groupLaunchFailures([]).size).toBe(0)
  })
})

describe('unresolvedTokenLabel', () => {
  it('wraps plain token names in braces', () => {
    expect(unresolvedTokenLabel('first_name')).toBe('{{first_name}}')
  })
  it('names the missing-subject case', () => {
    expect(unresolvedTokenLabel('missing:subject')).toBe('missing subject')
  })
  it('shows malformed spans raw', () => {
    expect(unresolvedTokenLabel('malformed:{{first name}}')).toBe('{{first name}}')
  })
})

// ── humanizeSendTime ─────────────────────────────────────────────────────

describe('humanizeSendTime', () => {
  // Fixed "now": Tue 2026-08-11 17:00 UTC = 10:00 in Los Angeles.
  const now = new Date('2026-08-11T17:00:00Z')

  it('says Today with the wall-clock time in the sequence zone', () => {
    // 2026-08-11 21:42 UTC = 14:42 LA, same LA day.
    expect(humanizeSendTime('2026-08-11T21:42:00Z', 'America/Los_Angeles', now)).toBe(
      'Today 2:42 PM',
    )
  })

  it('says Tomorrow across the zone-local midnight', () => {
    // 2026-08-12 16:05 UTC = 09:05 LA on the next LA day.
    expect(humanizeSendTime('2026-08-12T16:05:00Z', 'America/Los_Angeles', now)).toBe(
      'Tomorrow 9:05 AM',
    )
  })

  it('uses the weekday within the coming week', () => {
    // Thu 2026-08-13 16:42 UTC = Thu 09:42 LA.
    expect(humanizeSendTime('2026-08-13T16:42:00Z', 'America/Los_Angeles', now)).toBe(
      'Thu 9:42 AM',
    )
  })

  it('falls back to an absolute date beyond a week', () => {
    expect(humanizeSendTime('2026-08-24T16:00:00Z', 'America/Los_Angeles', now)).toBe(
      'Aug 24, 9:00 AM',
    )
  })

  it('is timezone-aware: same instant, different zone label', () => {
    // 21:42 UTC on the 11th is 06:42 on the 12th in Tokyo — and "now"
    // (17:00 UTC) is ALSO already the 12th there, so it's Today in Tokyo
    // while being Today-the-11th in LA (asserted above).
    expect(humanizeSendTime('2026-08-11T21:42:00Z', 'Asia/Tokyo', now)).toBe('Today 6:42 AM')
  })

  it('degrades an invalid zone to UTC instead of throwing', () => {
    expect(humanizeSendTime('2026-08-11T21:42:00Z', 'Not/A_Zone', now)).toBe('Today 9:42 PM')
  })

  it('renders a dash for missing or invalid timestamps', () => {
    expect(humanizeSendTime(null, 'UTC', now)).toBe('—')
    expect(humanizeSendTime('garbage', 'UTC', now)).toBe('—')
  })
})

// ── timezoneAbbreviation ─────────────────────────────────────────────────

describe('timezoneAbbreviation', () => {
  it('returns the short zone name for an IANA zone', () => {
    // A fixed winter instant so the answer is DST-stable.
    const at = new Date('2026-01-15T12:00:00Z')
    expect(timezoneAbbreviation('America/New_York', at)).toBe('EST')
  })

  it('falls back to the spaced IANA name for an invalid zone', () => {
    expect(timezoneAbbreviation('Not/A_Zone')).toBe('Not/A Zone')
  })
})

// ── describeSendWindow ───────────────────────────────────────────────────

describe('describeSendWindow', () => {
  it('collapses contiguous day runs into a range', () => {
    expect(describeSendWindow({ days: [1, 2, 3, 4, 5], start_hour: 9, end_hour: 16 })).toBe(
      'Mon–Fri, 9 AM–4 PM',
    )
  })

  it('lists non-contiguous days', () => {
    expect(describeSendWindow({ days: [1, 3, 5], start_hour: 9, end_hour: 12 })).toBe(
      'Mon, Wed, Fri, 9 AM–12 PM',
    )
  })

  it('mixes runs and singles', () => {
    expect(describeSendWindow({ days: [1, 2, 3, 6], start_hour: 8, end_hour: 17 })).toBe(
      'Mon–Wed, Sat, 8 AM–5 PM',
    )
  })

  it('degrades to empty on malformed days rather than throwing', () => {
    expect(describeSendWindow({ days: [], start_hour: 9, end_hour: 16 })).toBe('')
    expect(describeSendWindow({ days: [0, 9, 2.5] as number[], start_hour: 9, end_hour: 16 })).toBe('')
  })
})

// ── describeEnrollmentProgress ───────────────────────────────────────────

describe('describeEnrollmentProgress', () => {
  it('shows the NEXT step for an active enrollment (current = last completed)', () => {
    expect(describeEnrollmentProgress(0, 3, 'active')).toBe('Step 1 of 3')
    expect(describeEnrollmentProgress(1, 3, 'active')).toBe('Step 2 of 3')
  })

  it('caps at the last step', () => {
    expect(describeEnrollmentProgress(3, 3, 'active')).toBe('Step 3 of 3')
  })

  it('describes exits by how far they got', () => {
    expect(describeEnrollmentProgress(3, 3, 'exited')).toBe('All 3 sent')
    expect(describeEnrollmentProgress(1, 3, 'exited')).toBe('After step 1')
    expect(describeEnrollmentProgress(0, 3, 'exited')).toBe('Before step 1')
  })

  it('renders a dash with no steps', () => {
    expect(describeEnrollmentProgress(0, 0, 'active')).toBe('—')
  })
})

// ── renderSequencePreview ────────────────────────────────────────────────

const STEPS = [
  { step_order: 1, subject: 'Intro to {{company}}', body: 'Hi {{first_name|there}}' },
  { step_order: 2, subject: null, body: 'Bumping this, {{first_name}}' },
  { step_order: 3, subject: 'New angle', body: 'Third note' },
]

const CONTACT = {
  first_name: 'Sarah',
  last_name: 'Chen',
  full_name: 'Sarah Chen',
  company: 'Initialized',
  email: 'sarah@initialized.com',
}
const SENDER = { name: 'Liam Alizadeh', email: 'liam@dial8.ai' }

describe('renderSequencePreview', () => {
  it('renders every step with resolved tokens', () => {
    const previews = renderSequencePreview(STEPS, {}, CONTACT, SENDER)
    expect(previews).toHaveLength(3)
    expect(previews[0].subject).toBe('Intro to Initialized')
    expect(previews[0].body).toBe('Hi Sarah')
    expect(previews[0].unresolved).toEqual([])
  })

  it('threads a NULL-subject follow-up under the rendered step-1 subject', () => {
    const previews = renderSequencePreview(STEPS, {}, CONTACT, SENDER)
    expect(previews[1].sameThread).toBe(true)
    expect(previews[1].subject).toBe('Re: Intro to Initialized')
  })

  it('starts a new thread when a later step has its own subject', () => {
    const previews = renderSequencePreview(STEPS, {}, CONTACT, SENDER)
    expect(previews[2].sameThread).toBe(false)
    expect(previews[2].subject).toBe('New angle')
  })

  it('applies overrides with precedence over the step template', () => {
    const previews = renderSequencePreview(
      STEPS,
      { '1': { subject: 'Custom for {{first_name}}', body: 'Custom body' } },
      CONTACT,
      SENDER,
    )
    expect(previews[0].subject).toBe('Custom for Sarah')
    expect(previews[0].body).toBe('Custom body')
    // The thread anchor for step 2 follows the OVERRIDDEN step-1 subject —
    // exactly what the engine snapshots as thread_subject at send time.
    expect(previews[1].subject).toBe('Re: Custom for Sarah')
  })

  it('treats a null subject override as no-override, exactly like the engine', () => {
    // buildStepEmail resolves `override.subject ?? step.subject`, so a null
    // override falls through to the step's own subject — it does NOT force
    // the step back to same-thread. The preview must agree or Review & Launch
    // would show a different email than the engine sends.
    const previews = renderSequencePreview(
      STEPS,
      { '3': { subject: null } },
      CONTACT,
      SENDER,
    )
    expect(previews[2].sameThread).toBe(false)
    expect(previews[2].subject).toBe('New angle')
  })

  it('reports unresolved tokens exactly like the engine (blocks launch)', () => {
    const previews = renderSequencePreview(
      STEPS,
      {},
      { ...CONTACT, first_name: null, full_name: null },
      SENDER,
    )
    // Step 1 body has a fallback ({{first_name|there}}) — resolved.
    expect(previews[0].unresolved).toEqual([])
    // Step 2 body has no fallback — unresolved.
    expect(previews[1].unresolved).toEqual(['first_name'])
  })

  it('flags a blank subject on a new-thread step as missing:subject', () => {
    const previews = renderSequencePreview(
      [{ step_order: 1, subject: '   ', body: 'Hello' }],
      {},
      CONTACT,
      SENDER,
    )
    expect(previews[0].unresolved).toContain('missing:subject')
  })

  it('propagates malformed brace syntax as unresolved', () => {
    const previews = renderSequencePreview(
      [{ step_order: 1, subject: 'Hi', body: 'Broken {{first name}} span' }],
      {},
      CONTACT,
      SENDER,
    )
    expect(previews[0].unresolved.some((t) => t.startsWith('malformed:'))).toBe(true)
  })

  it('resolves sender tokens from the sending account', () => {
    const previews = renderSequencePreview(
      [{ step_order: 1, subject: 'Hi', body: 'Best, {{sender_first_name}}' }],
      {},
      CONTACT,
      SENDER,
    )
    expect(previews[0].body).toBe('Best, Liam')
  })
})

// ── misc ─────────────────────────────────────────────────────────────────

describe('defaultStepBody', () => {
  it('ends with the plain-text opt-out line', () => {
    expect(defaultStepBody().endsWith(DEFAULT_OPT_OUT_LINE)).toBe(true)
  })
  it('renders with zero unresolved tokens even for an empty contact', () => {
    const previews = renderSequencePreview(
      [{ step_order: 1, subject: 'Hi', body: defaultStepBody() }],
      {},
      {},
      {},
    )
    expect(previews[0].unresolved).toEqual([])
  })
})

describe('replyRate', () => {
  it('formats a percentage', () => {
    expect(replyRate(3, 13)).toBe('23%')
  })
  it('dashes out an empty denominator', () => {
    expect(replyRate(0, 0)).toBe('—')
  })
})

describe('builder sample preview sender', () => {
  const steps = [{ step_order: 1, subject: 'Intro', body: 'Hi {{first_name}},\n\n{{sender_first_name}}' }]

  it('signs with the real member name once resolved', () => {
    const [preview] = renderSequencePreview(steps, {}, SAMPLE_PREVIEW_CONTACT, {
      name: 'Liam Alizadeh',
      email: 'liam@dial8.ai',
    })
    expect(preview.body).toContain('Liam')
    expect(preview.unresolved).toEqual([])
  })

  it('never flashes an unresolved sender token while the lookups are in flight', () => {
    // Both lookups pending — the builder falls back to 'You' rather than
    // passing nulls, which would render a spurious "Unresolved" warning on a
    // template that is actually valid.
    const [preview] = renderSequencePreview(steps, {}, SAMPLE_PREVIEW_CONTACT, {
      name: 'You',
      email: 'you@example.com',
    })
    expect(preview.unresolved).toEqual([])
  })
})
