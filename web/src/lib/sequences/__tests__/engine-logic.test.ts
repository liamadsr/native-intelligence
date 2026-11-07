import { describe, it, expect } from 'vitest'
import {
  INFLIGHT_STALE_MS,
  bodyTextToHtml,
  buildStepEmail,
  containsHeaderInjectionChars,
  escapeIlikePattern,
  isStaleInFlight,
  ledgerConflictDecision,
  selectNextActiveStep,
  shouldExitAsReplied,
  type BuildStepEmailLedgerRow,
} from '@/lib/sequences/engine-logic'

const NOW = Date.parse('2026-08-11T18:00:00Z')

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString()
}

// ---------------------------------------------------------------------------
// ledgerConflictDecision
// ---------------------------------------------------------------------------

describe('ledgerConflictDecision', () => {
  it("'sent' → finalize-only (never resend)", () => {
    expect(
      ledgerConflictDecision({ status: 'sent', updated_at: iso(-60_000) }, NOW),
    ).toBe('finalize-only')
  })

  it("'sent' is finalize-only even when ancient", () => {
    expect(
      ledgerConflictDecision({ status: 'sent', updated_at: iso(-24 * 60 * 60_000) }, NOW),
    ).toBe('finalize-only')
  })

  it("fresh 'claimed' → abort (a concurrent invocation owns it)", () => {
    expect(
      ledgerConflictDecision({ status: 'claimed', updated_at: iso(-60_000) }, NOW),
    ).toBe('abort')
  })

  it("fresh 'sending' → abort", () => {
    expect(
      ledgerConflictDecision({ status: 'sending', updated_at: iso(-14 * 60_000) }, NOW),
    ).toBe('abort')
  })

  it("stale 'claimed' → stale-failed", () => {
    expect(
      ledgerConflictDecision({ status: 'claimed', updated_at: iso(-16 * 60_000) }, NOW),
    ).toBe('stale-failed')
  })

  it("stale 'sending' → stale-failed", () => {
    expect(
      ledgerConflictDecision({ status: 'sending', updated_at: iso(-16 * 60_000) }, NOW),
    ).toBe('stale-failed')
  })

  it('exactly at the stale wall is NOT yet stale (strictly greater)', () => {
    expect(
      ledgerConflictDecision(
        { status: 'sending', updated_at: iso(-INFLIGHT_STALE_MS) },
        NOW,
      ),
    ).toBe('abort')
  })

  it("'failed' → abort (terminal; the reaper/exit already handled it)", () => {
    expect(
      ledgerConflictDecision({ status: 'failed', updated_at: iso(-60_000) }, NOW),
    ).toBe('abort')
  })
})

describe('isStaleInFlight', () => {
  it('false within the wall, true past it', () => {
    expect(isStaleInFlight(iso(-INFLIGHT_STALE_MS + 1000), NOW)).toBe(false)
    expect(isStaleInFlight(iso(-INFLIGHT_STALE_MS - 1000), NOW)).toBe(true)
  })

  it('treats an unparseable timestamp as dead', () => {
    expect(isStaleInFlight('not-a-date', NOW)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// shouldExitAsReplied
// ---------------------------------------------------------------------------

describe('shouldExitAsReplied', () => {
  const enrollment = { provider_thread_id: 'thread-1', expected_message_count: 2 }

  it('no provider_thread_id → never a reply', () => {
    expect(
      shouldExitAsReplied(
        { provider_thread_id: null, expected_message_count: 0 },
        { message_count: 99 },
      ),
    ).toBe(false)
  })

  it('missing thread row → not a reply (index lags; never exit on absence)', () => {
    expect(shouldExitAsReplied(enrollment, null)).toBe(false)
    expect(shouldExitAsReplied(enrollment, undefined)).toBe(false)
  })

  it('index equal to expected → not a reply', () => {
    expect(shouldExitAsReplied(enrollment, { message_count: 2 })).toBe(false)
  })

  it('index BEHIND expected → not a reply (lagging sync counts up, never past)', () => {
    expect(shouldExitAsReplied(enrollment, { message_count: 1 })).toBe(false)
  })

  it('index ahead of expected → reply', () => {
    expect(shouldExitAsReplied(enrollment, { message_count: 3 })).toBe(true)
  })

  it('null message_count is treated as 0', () => {
    expect(shouldExitAsReplied(enrollment, { message_count: null })).toBe(false)
    expect(
      shouldExitAsReplied(
        { provider_thread_id: 't', expected_message_count: -1 },
        { message_count: null },
      ),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// bodyTextToHtml
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// selectNextActiveStep — the claim's skip-forward contract
// ---------------------------------------------------------------------------

describe('selectNextActiveStep', () => {
  const steps = [
    { step_order: 1, is_active: true },
    { step_order: 2, is_active: true },
    { step_order: 3, is_active: true },
  ]

  it('returns the immediate next step when it is active', () => {
    expect(selectNextActiveStep(steps, 1)).toMatchObject({ step_order: 2 })
    expect(selectNextActiveStep(steps, 0)).toMatchObject({ step_order: 1 })
  })

  it('SKIPS FORWARD over a deactivated next step (mid-flight is_active edit)', () => {
    const edited = [
      { step_order: 1, is_active: true },
      { step_order: 2, is_active: false }, // deactivated after scheduling
      { step_order: 3, is_active: true },
    ]
    expect(selectNextActiveStep(edited, 1)).toMatchObject({ step_order: 3 })
  })

  it('returns null when no active step remains — the claim exits the enrollment completed', () => {
    expect(selectNextActiveStep(steps, 3)).toBeNull()
    const allTailOff = [
      { step_order: 1, is_active: true },
      { step_order: 2, is_active: false },
      { step_order: 3, is_active: false },
    ]
    expect(selectNextActiveStep(allTailOff, 1)).toBeNull()
    expect(selectNextActiveStep([], 0)).toBeNull()
  })

  it('does not require sorted input', () => {
    const shuffled = [
      { step_order: 3, is_active: true },
      { step_order: 1, is_active: true },
      { step_order: 2, is_active: true },
    ]
    expect(selectNextActiveStep(shuffled, 1)).toMatchObject({ step_order: 2 })
  })

  it('treats a missing is_active flag as active (pre-filtered caller lists)', () => {
    expect(selectNextActiveStep([{ step_order: 2 }, { step_order: 4 }], 2)).toMatchObject({
      step_order: 4,
    })
  })

  it('never returns the current or an earlier step', () => {
    expect(selectNextActiveStep(steps, 2)).toMatchObject({ step_order: 3 })
    expect(selectNextActiveStep(steps, 99)).toBeNull()
  })
})

describe('bodyTextToHtml', () => {
  it('double newline starts a paragraph, single newline is a <br />', () => {
    expect(bodyTextToHtml('Hi Sarah,\n\nQuick note.\nSecond line.')).toBe(
      '<p>Hi Sarah,</p>\n<p>Quick note.<br />Second line.</p>',
    )
  })

  it('collapses 3+ newlines into one paragraph break', () => {
    expect(bodyTextToHtml('a\n\n\n\nb')).toBe('<p>a</p>\n<p>b</p>')
  })

  it('normalizes CRLF', () => {
    expect(bodyTextToHtml('a\r\n\r\nb\r\nc')).toBe('<p>a</p>\n<p>b<br />c</p>')
  })

  it('wraps a single line in one paragraph', () => {
    expect(bodyTextToHtml('hello')).toBe('<p>hello</p>')
  })
})

describe('escapeIlikePattern', () => {
  it('escapes underscores, percent, and backslash', () => {
    expect(escapeIlikePattern('a_b%c\\d@x.com')).toBe('a\\_b\\%c\\\\d@x.com')
  })
})

describe('containsHeaderInjectionChars', () => {
  it('flags CR and LF (SMTP header injection vectors)', () => {
    expect(containsHeaderInjectionChars('Hi\r\nBcc: exfil@attacker.com')).toBe(true)
    expect(containsHeaderInjectionChars('Hi\nBcc: exfil@attacker.com')).toBe(true)
    expect(containsHeaderInjectionChars('Hi\rthere')).toBe(true)
  })

  it('flags other control characters', () => {
    expect(containsHeaderInjectionChars('Hi\u0000there')).toBe(true)
    expect(containsHeaderInjectionChars('Hi\u001bthere')).toBe(true)
    expect(containsHeaderInjectionChars('Hi\u007fthere')).toBe(true)
  })

  it('passes ordinary subjects, including unicode', () => {
    expect(containsHeaderInjectionChars('Quick question about Acme')).toBe(false)
    expect(containsHeaderInjectionChars('Résumé — follow-up ✨')).toBe(false)
    expect(containsHeaderInjectionChars('')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildStepEmail
// ---------------------------------------------------------------------------

const contact = {
  first_name: 'Sarah',
  last_name: 'Chen',
  full_name: 'Sarah Chen',
  company: 'Acme',
  email: 'sarah@acme.com',
}
const sender = { name: 'Liam Alizadeh', email: 'liam@dial8.ai' }

const step1 = {
  step_order: 1,
  subject: 'Intro from {{sender_first_name}}',
  body: 'Hi {{first_name|there}},\n\nWould love to chat about {{company}}.',
}
const followupNoSubject = {
  step_order: 2,
  subject: null,
  body: 'Bumping this, {{first_name|there}}.',
}

const freshEnrollment = {
  overrides: {},
  thread_subject: null,
  provider_thread_id: null,
}

const threadedEnrollment = {
  overrides: {},
  thread_subject: 'Intro from Liam',
  provider_thread_id: 'gthread-1',
}

const sentLedger: BuildStepEmailLedgerRow[] = [
  {
    status: 'sent',
    provider_message_id: 'gmsg-2',
    rfc_message_id: 'rfc-2@dial8.ai',
    sent_at: '2026-08-05T17:00:00Z',
    created_at: '2026-08-05T16:59:00Z',
  },
  {
    status: 'failed',
    provider_message_id: 'gmsg-x',
    rfc_message_id: 'rfc-x@dial8.ai',
    sent_at: null,
    created_at: '2026-08-04T12:00:00Z',
  },
  {
    status: 'sent',
    provider_message_id: 'gmsg-1',
    rfc_message_id: 'rfc-1@dial8.ai',
    sent_at: '2026-08-03T17:00:00Z',
    created_at: '2026-08-03T16:59:00Z',
  },
]

describe('buildStepEmail — step 1 (new thread)', () => {
  it('renders subject and body, no threading fields', () => {
    const result = buildStepEmail(freshEnrollment, step1, {}, [], contact, sender)
    expect(result.blocked).toBeUndefined()
    if (result.blocked) throw new Error('unreachable')
    expect(result.subject).toBe('Intro from Liam')
    expect(result.bodyHtml).toBe(
      '<p>Hi Sarah,</p>\n<p>Would love to chat about Acme.</p>',
    )
    expect(result.threadId).toBeNull()
    expect(result.inReplyTo).toBeNull()
    expect(result.references).toEqual([])
  })

  it('HTML-escapes substituted values in the body but not in the subject', () => {
    const result = buildStepEmail(
      freshEnrollment,
      { step_order: 1, subject: 'For {{company}}', body: 'About {{company}}' },
      {},
      [],
      { ...contact, company: 'A&B <Co>' },
      sender,
    )
    if (result.blocked) throw new Error('unexpected block')
    expect(result.subject).toBe('For A&B <Co>')
    expect(result.bodyHtml).toBe('<p>About A&amp;B &lt;Co&gt;</p>')
  })
})

describe('buildStepEmail — step N, NULL subject (same thread)', () => {
  it("threads under step 1: 'Re:' subject, parent, full references chain oldest-first", () => {
    const result = buildStepEmail(
      threadedEnrollment,
      followupNoSubject,
      {},
      sentLedger,
      contact,
      sender,
    )
    if (result.blocked) throw new Error('unexpected block')
    expect(result.subject).toBe('Re: Intro from Liam')
    expect(result.threadId).toBe('gthread-1')
    // Parent = LATEST 'sent' row's provider id (never the failed row's).
    expect(result.inReplyTo).toBe('gmsg-2')
    // References = ALL 'sent' rows' rfc ids, oldest first.
    expect(result.references).toEqual(['rfc-1@dial8.ai', 'rfc-2@dial8.ai'])
  })

  it('drops null rfc ids from the references chain', () => {
    const ledger: BuildStepEmailLedgerRow[] = [
      { ...sentLedger[2], rfc_message_id: null },
      sentLedger[0],
    ]
    const result = buildStepEmail(
      threadedEnrollment,
      followupNoSubject,
      {},
      ledger,
      contact,
      sender,
    )
    if (result.blocked) throw new Error('unexpected block')
    expect(result.references).toEqual(['rfc-2@dial8.ai'])
  })

  it('no sent rows yet → null parent, empty references, still threads by id', () => {
    const result = buildStepEmail(
      threadedEnrollment,
      followupNoSubject,
      {},
      [],
      contact,
      sender,
    )
    if (result.blocked) throw new Error('unexpected block')
    expect(result.inReplyTo).toBeNull()
    expect(result.references).toEqual([])
    expect(result.threadId).toBe('gthread-1')
  })

  it("missing thread_subject degrades to bare 'Re: '", () => {
    const result = buildStepEmail(
      { ...threadedEnrollment, thread_subject: null },
      followupNoSubject,
      {},
      sentLedger,
      contact,
      sender,
    )
    if (result.blocked) throw new Error('unexpected block')
    expect(result.subject).toBe('Re: ')
  })
})

describe('buildStepEmail — step N with its own subject (new thread)', () => {
  it('starts a new thread: rendered subject, no thread/parent/references', () => {
    const result = buildStepEmail(
      threadedEnrollment,
      { step_order: 3, subject: 'One more idea for {{company}}', body: 'Hi again.' },
      {},
      sentLedger,
      contact,
      sender,
    )
    if (result.blocked) throw new Error('unexpected block')
    expect(result.subject).toBe('One more idea for Acme')
    expect(result.threadId).toBeNull()
    expect(result.inReplyTo).toBeNull()
    expect(result.references).toEqual([])
  })
})

describe('buildStepEmail — override precedence', () => {
  it('override body beats the step body; keyed by String(step_order)', () => {
    const result = buildStepEmail(
      {
        ...freshEnrollment,
        overrides: { '1': { body: 'Custom pitch for {{first_name}}.' } },
      },
      step1,
      {},
      [],
      contact,
      sender,
    )
    if (result.blocked) throw new Error('unexpected block')
    expect(result.bodyHtml).toBe('<p>Custom pitch for Sarah.</p>')
    // Un-overridden subject still comes from the step.
    expect(result.subject).toBe('Intro from Liam')
  })

  it('override subject beats the step subject', () => {
    const result = buildStepEmail(
      { ...freshEnrollment, overrides: { '1': { subject: 'Hello {{first_name}}' } } },
      step1,
      {},
      [],
      contact,
      sender,
    )
    if (result.blocked) throw new Error('unexpected block')
    expect(result.subject).toBe('Hello Sarah')
  })

  it('an override subject on a NULL-subject follow-up deliberately starts a new thread', () => {
    const result = buildStepEmail(
      { ...threadedEnrollment, overrides: { '2': { subject: 'Fresh subject' } } },
      followupNoSubject,
      {},
      sentLedger,
      contact,
      sender,
    )
    if (result.blocked) throw new Error('unexpected block')
    expect(result.subject).toBe('Fresh subject')
    expect(result.threadId).toBeNull()
    expect(result.inReplyTo).toBeNull()
  })

  it('overrides for OTHER steps are ignored', () => {
    const result = buildStepEmail(
      { ...freshEnrollment, overrides: { '2': { body: 'wrong step' } } },
      step1,
      {},
      [],
      contact,
      sender,
    )
    if (result.blocked) throw new Error('unexpected block')
    expect(result.bodyHtml).toContain('Would love to chat')
  })
})

describe('buildStepEmail — blocked renders', () => {
  it('an unresolved token without fallback blocks the send', () => {
    const result = buildStepEmail(
      freshEnrollment,
      { step_order: 1, subject: 'Hi', body: 'Dear {{first_name}}' },
      {},
      [],
      { ...contact, first_name: null, full_name: null },
      sender,
    )
    expect(result.blocked).toEqual(['first_name'])
  })

  it('malformed brace syntax blocks (never mail brace residue)', () => {
    const result = buildStepEmail(
      freshEnrollment,
      { step_order: 1, subject: 'Hi', body: 'Dear {{first-name}}' },
      {},
      [],
      contact,
      sender,
    )
    expect(result.blocked?.some((t) => t.startsWith('malformed:'))).toBe(true)
  })

  it('collects unresolved tokens from BOTH subject and body, deduplicated', () => {
    const result = buildStepEmail(
      freshEnrollment,
      { step_order: 1, subject: '{{missing_a}}', body: '{{missing_a}} {{missing_b}}' },
      {},
      [],
      contact,
      sender,
    )
    expect(result.blocked?.sort()).toEqual(['missing_a', 'missing_b'])
  })

  it('a new-thread step with no subject at all blocks with missing:subject', () => {
    const result = buildStepEmail(
      freshEnrollment,
      { step_order: 1, subject: null, body: 'body' },
      {},
      [],
      contact,
      sender,
    )
    expect(result.blocked).toEqual(['missing:subject'])
  })

  it('an override blanking the subject on step 1 blocks', () => {
    const result = buildStepEmail(
      { ...freshEnrollment, overrides: { '1': { subject: '   ' } } },
      step1,
      {},
      [],
      contact,
      sender,
    )
    expect(result.blocked).toEqual(['missing:subject'])
  })

  it('a NULL-subject follow-up does NOT need a subject (threads instead)', () => {
    const result = buildStepEmail(
      threadedEnrollment,
      followupNoSubject,
      {},
      sentLedger,
      contact,
      sender,
    )
    expect(result.blocked).toBeUndefined()
  })
})
