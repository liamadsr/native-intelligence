import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Tests for src/lib/crm/enrichment.ts.
 *
 * The load-bearing contract is the Exa-card → write-back mapping, so that gets
 * the coverage: fill-empty (a populated column is NEVER overwritten), the
 * confidence gate (only high/medium reach a column), the employee_count_range
 * enum mapping, metadata merging that preserves sibling keys, and the guard
 * matrix that decides a contact isn't worth searching for.
 *
 * There is NO model in the pipeline any more — one Exa Deep Search per entity
 * does the searching AND the schema-shaped extraction, and its `grounding`
 * carries the per-field confidence the write-back gates on. So the harness is
 * a stubbed global `fetch` returning canned Exa bodies rather than a mocked
 * `ai` module; these tests never make a network call and never need a real key
 * (there is no .env.local in a worktree, hence the stubbed EXA_API_KEY).
 */

const serviceClientMock = vi.fn()
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => serviceClientMock(),
}))

// The free tier (src/lib/web-research/plan-deep-search.ts): everyone here is
// off the plan unless a test says otherwise, and a plan search is the
// web-research agent's answer.
vi.mock('server-only', () => ({}))
const chatgptPlanFor = vi.fn(async (_userId: string, _opts?: unknown) => false)
vi.mock('@/lib/chatgpt/plan-route', () => ({ chatgptPlanFor: (u: string, o?: unknown) => chatgptPlanFor(u, o) }))
const runUtilityTask = vi.fn()
vi.mock('@/lib/eve/utility/run-utility', () => ({ runUtilityTask: (...a: unknown[]) => runUtilityTask(...a) }))
vi.mock('@/lib/ai/auth', () => ({ logUsage: vi.fn(async () => ({})) }))

import {
  applySummaryToNotes,
  columnCandidates,
  companyDomainFromEmail,
  contactSkipReason,
  enrichCompany,
  enrichContact,
  hasLinkedInProfile,
  hasPermanentFailure,
  isBillingError,
  isPermanentModelError,
  isTimeoutError,
  isPlaceholderName,
  mergeEnrichmentMetadata,
  normalizeDomain,
  normalizeEmployeeRange,
  previousNotesSummary,
  serializeFields,
  ENRICHMENT_ENGINE,
  ENRICHMENT_VERSION,
  EXA_OUT_OF_CREDITS_MESSAGE,
  type EnrichmentBlob,
  resolveLinkedInShortLink,
} from '@/lib/crm/enrichment'

// ---------------------------------------------------------------------------
// Pure: domain helpers
// ---------------------------------------------------------------------------

describe('companyDomainFromEmail', () => {
  it('extracts a business domain', () => {
    expect(companyDomainFromEmail('jane@acme.com')).toBe('acme.com')
    expect(companyDomainFromEmail('Jane.Doe@Sub.Acme.CO.UK')).toBe('sub.acme.co.uk')
  })
  it('drops free-mail domains — they carry no company signal', () => {
    expect(companyDomainFromEmail('jane@gmail.com')).toBeNull()
    expect(companyDomainFromEmail('jane@outlook.com')).toBeNull()
    expect(companyDomainFromEmail('jane@proton.me')).toBeNull()
  })
  it('returns null for absent or malformed input', () => {
    expect(companyDomainFromEmail(null)).toBeNull()
    expect(companyDomainFromEmail('')).toBeNull()
    expect(companyDomainFromEmail('not-an-email')).toBeNull()
    expect(companyDomainFromEmail('jane@localhost')).toBeNull()
  })
})

describe('normalizeDomain', () => {
  it('strips scheme, www, path and case', () => {
    expect(normalizeDomain('https://www.Acme.com/about?x=1#y')).toBe('acme.com')
    expect(normalizeDomain('  ACME.COM.  ')).toBe('acme.com')
  })
  it('rejects non-domains', () => {
    expect(normalizeDomain(null)).toBeNull()
    expect(normalizeDomain('acme')).toBeNull()
    expect(normalizeDomain('two words.com')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Pure: employee-range mapping
// ---------------------------------------------------------------------------

describe('normalizeEmployeeRange', () => {
  it('passes through the six exact buckets', () => {
    for (const b of ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+']) {
      expect(normalizeEmployeeRange(b)).toBe(b)
    }
  })
  it('buckets a bare headcount on its low end', () => {
    expect(normalizeEmployeeRange('7')).toBe('1-10')
    expect(normalizeEmployeeRange('42')).toBe('11-50')
    expect(normalizeEmployeeRange('150')).toBe('51-200')
    expect(normalizeEmployeeRange('2,500')).toBe('1000+')
  })
  it('maps an off-enum range onto the bucket its low end belongs to', () => {
    expect(normalizeEmployeeRange('200-500')).toBe('51-200')
    expect(normalizeEmployeeRange('5000-10000')).toBe('1000+')
    expect(normalizeEmployeeRange('approximately 250 employees')).toBe('201-500')
  })
  it('returns null for unusable input so the field is omitted', () => {
    expect(normalizeEmployeeRange(null)).toBeNull()
    expect(normalizeEmployeeRange('')).toBeNull()
    expect(normalizeEmployeeRange('lots of people')).toBeNull()
    expect(normalizeEmployeeRange('0')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Pure: confidence gate
// ---------------------------------------------------------------------------

describe('columnCandidates', () => {
  const at = (v: string, confidence: 'high' | 'medium' | 'low') => ({
    value: v,
    source_url: 'https://x',
    source_title: null,
    confidence,
  })
  const hi = (v: string) => at(v, 'high')
  const mid = (v: string) => at(v, 'medium')
  const lo = (v: string) => at(v, 'low')

  it('admits high and medium confidence', () => {
    expect(columnCandidates({ job_title: hi('CTO'), department: mid('Eng') })).toEqual({
      job_title: 'CTO',
      department: 'Eng',
    })
  })
  it('excludes low confidence from column writes', () => {
    expect(columnCandidates({ job_title: lo('Maybe CTO') })).toEqual({})
  })
  it('drops absent and blank values', () => {
    expect(columnCandidates({ a: null, b: undefined, c: hi('   ') })).toEqual({})
  })
  it('trims surviving values', () => {
    expect(columnCandidates({ job_title: hi('  CTO  ') })).toEqual({ job_title: 'CTO' })
  })
})

// ---------------------------------------------------------------------------
// Pure: metadata merge
// ---------------------------------------------------------------------------

describe('mergeEnrichmentMetadata', () => {
  const blob: EnrichmentBlob = {
    version: 1,
    status: 'enriched',
    enriched_at: '2026-01-01T00:00:00.000Z',
    model: ENRICHMENT_ENGINE,
    fields: {},
    applied_fields: [],
    sources: [],
    summary: null,
    search_cost_dollars: null,
  }

  it('preserves sibling metadata keys', () => {
    const out = mergeEnrichmentMetadata(
      { company_autolinked: true, hubspot_push_error: 'x' },
      blob,
    )
    expect(out.company_autolinked).toBe(true)
    expect(out.hubspot_push_error).toBe('x')
    expect(out.enrichment).toBe(blob)
  })

  it('replaces a previous enrichment blob wholesale', () => {
    const out = mergeEnrichmentMetadata({ enrichment: { status: 'failed' } }, blob)
    expect(out.enrichment).toBe(blob)
  })

  it('handles null / non-object metadata', () => {
    expect(mergeEnrichmentMetadata(null, blob).enrichment).toBe(blob)
    expect(mergeEnrichmentMetadata('junk', blob).enrichment).toBe(blob)
    expect(mergeEnrichmentMetadata([1, 2], blob).enrichment).toBe(blob)
  })

  it('does not mutate the caller"s metadata object', () => {
    const existing = { company_autolinked: true }
    mergeEnrichmentMetadata(existing, blob)
    expect(existing).toEqual({ company_autolinked: true })
  })
})

describe('serializeFields', () => {
  it('keeps full field triples and drops summary/sources/nulls', () => {
    const out = serializeFields({
      job_title: { value: 'CTO', source_url: 'https://x', confidence: 'high' },
      department: null,
      summary: 'ignored here',
      sources: [{ url: 'https://x' }],
    })
    expect(out).toEqual({
      job_title: { value: 'CTO', source_url: 'https://x', confidence: 'high' },
    })
  })
})

describe('hasPermanentFailure', () => {
  it('detects the marker', () => {
    expect(hasPermanentFailure({ enrichment: { permanent: true } })).toBe(true)
  })
  it('is false for everything else', () => {
    expect(hasPermanentFailure(null)).toBe(false)
    expect(hasPermanentFailure({})).toBe(false)
    expect(hasPermanentFailure({ enrichment: {} })).toBe(false)
    expect(hasPermanentFailure({ enrichment: { permanent: false } })).toBe(false)
    expect(hasPermanentFailure('junk')).toBe(false)
  })
})

describe('isPlaceholderName', () => {
  it('treats an empty or whitespace name as a placeholder', () => {
    expect(isPlaceholderName('', 'a@b.com')).toBe(true)
    expect(isPlaceholderName('   ', 'a@b.com')).toBe(true)
    expect(isPlaceholderName(null, 'a@b.com')).toBe(true)
  })
  it('treats the email itself as a placeholder, case- and space-insensitively', () => {
    expect(isPlaceholderName('jmarlow@bright-wave.com', 'jmarlow@bright-wave.com')).toBe(true)
    expect(isPlaceholderName('  JMarlow@Bright-Wave.com ', 'jmarlow@bright-wave.com')).toBe(true)
  })
  it('treats the email local-part as a placeholder', () => {
    expect(isPlaceholderName('jmarlow', 'jmarlow@bright-wave.com')).toBe(true)
    expect(isPlaceholderName('JMARLOW', 'jmarlow@bright-wave.com')).toBe(true)
  })
  it('never flags a real human-entered name', () => {
    expect(isPlaceholderName('Jules Marlow', 'jmarlow@bright-wave.com')).toBe(false)
    expect(isPlaceholderName('Jane Doe', 'jane@acme.com')).toBe(false)
  })
  it('does not treat a name as a placeholder when the email is unusable', () => {
    expect(isPlaceholderName('Jane Doe', null)).toBe(false)
    expect(isPlaceholderName('Jane Doe', '')).toBe(false)
  })
})

describe('previousNotesSummary', () => {
  it('reads the last run’s appended block', () => {
    expect(previousNotesSummary({ enrichment: { notes_summary: 'Old block.' } })).toBe('Old block.')
  })
  it('is null when absent, blank or not an enrichment blob', () => {
    expect(previousNotesSummary(null)).toBeNull()
    expect(previousNotesSummary({})).toBeNull()
    expect(previousNotesSummary({ enrichment: {} })).toBeNull()
    expect(previousNotesSummary({ enrichment: { notes_summary: '  ' } })).toBeNull()
  })
})

describe('applySummaryToNotes', () => {
  const S1 = 'Jane is a Web Strategy Consultant at Bright Wave.'
  const S2 = 'Jane is the CTO of Acme.'

  it('returns null when there is no summary — notes must stay untouched', () => {
    expect(applySummaryToNotes({ notes: 'x', summary: null, previousSummary: null })).toBeNull()
    expect(applySummaryToNotes({ notes: 'x', summary: '  ', previousSummary: null })).toBeNull()
  })

  it('becomes the notes when they are empty', () => {
    expect(applySummaryToNotes({ notes: '', summary: S1, previousSummary: null })).toEqual({
      notes: S1,
      notesSummary: S1,
    })
    expect(applySummaryToNotes({ notes: null, summary: S1, previousSummary: null })).toEqual({
      notes: S1,
      notesSummary: S1,
    })
  })

  it('appends after a blank line, preserving existing notes verbatim', () => {
    const existing = 'Met at the conference.\nWants a demo in Q3.'
    expect(
      applySummaryToNotes({ notes: existing, summary: S1, previousSummary: null }),
    ).toEqual({ notes: `${existing}\n\n${S1}`, notesSummary: S1 })
  })

  it('re-enrich REPLACES the previous block instead of stacking a duplicate', () => {
    const notes = `Met at the conference.\n\n${S1}`
    expect(applySummaryToNotes({ notes, summary: S2, previousSummary: S1 })).toEqual({
      notes: `Met at the conference.\n\n${S2}`,
      notesSummary: S2,
    })
  })

  it('replaces in place, keeping the user’s text on both sides', () => {
    const notes = `Before.\n\n${S1}\n\nAfter.`
    const out = applySummaryToNotes({ notes, summary: S2, previousSummary: S1 })
    expect(out?.notes).toBe(`Before.\n\n${S2}\n\nAfter.`)
  })

  it('falls back to append when the user edited or deleted the previous block', () => {
    const deleted = applySummaryToNotes({
      notes: 'Met at the conference.',
      summary: S2,
      previousSummary: S1,
    })!
    expect(deleted.notes).toBe(`Met at the conference.\n\n${S2}`)
  })
})

// ---------------------------------------------------------------------------
// Pure: failure classification
// ---------------------------------------------------------------------------

describe('isPermanentModelError', () => {
  it('treats most 4xx as permanent but retries 408/425/429', () => {
    expect(isPermanentModelError(Object.assign(new Error('x'), { status: 400 }))).toBe(true)
    expect(isPermanentModelError(Object.assign(new Error('x'), { status: 401 }))).toBe(true)
    expect(isPermanentModelError(Object.assign(new Error('x'), { status: 429 }))).toBe(false)
    expect(isPermanentModelError(Object.assign(new Error('x'), { status: 425 }))).toBe(false)
    expect(isPermanentModelError(Object.assign(new Error('x'), { status: 408 }))).toBe(false)
  })
  it('treats 5xx and unknown errors as transient', () => {
    expect(isPermanentModelError(Object.assign(new Error('x'), { status: 503 }))).toBe(false)
    expect(isPermanentModelError(new Error('socket hang up'))).toBe(false)
  })

  // The prod incident: the gateway ran out of credit, every run 4xx'd, and 137
  // contacts + 28 companies were stamped permanent — blocking even a manual
  // re-enrich. Billing exhaustion heals on top-up, so it must stay transient.
  it('treats an out-of-credit failure as TRANSIENT despite its 4xx status', () => {
    expect(
      isPermanentModelError(Object.assign(new Error('Payment Required'), { status: 402 })),
    ).toBe(false)
  })
  it('treats a credit-balance message with no status as transient', () => {
    expect(
      isPermanentModelError(
        new Error(
          'A positive credit balance is required for all requests. ' +
            'Please add credits to your account.',
        ),
      ),
    ).toBe(false)
  })
})

describe('isBillingError', () => {
  it('matches a raw 402 statusCode', () => {
    expect(isBillingError(Object.assign(new Error('nope'), { statusCode: 402 }))).toBe(true)
  })
  it('matches a 402 exposed as `status` instead', () => {
    expect(isBillingError(Object.assign(new Error('nope'), { status: 402 }))).toBe(true)
  })
  it('matches a 402 buried in a wrapper error cause', () => {
    const inner = Object.assign(new Error('Payment Required'), { statusCode: 402 })
    const wrapper = Object.assign(new Error('failed after 3 attempts'), { lastError: inner })
    expect(isBillingError(wrapper)).toBe(true)
  })
  it('matches the credit-balance message when no status survived', () => {
    expect(
      isBillingError(new Error('A positive credit balance is required for all requests')),
    ).toBe(true)
  })
  it('matches the credit-balance phrase case-insensitively and when nested', () => {
    const wrapper = new Error('call failed')
    ;(wrapper as unknown as { cause: unknown }).cause = new Error(
      'Provider returned: A POSITIVE CREDIT BALANCE IS REQUIRED',
    )
    expect(isBillingError(wrapper)).toBe(true)
  })
  it('does NOT match a plain validation error', () => {
    expect(isBillingError(Object.assign(new Error('invalid schema'), { statusCode: 400 }))).toBe(
      false,
    )
    expect(isBillingError(new Error('socket hang up'))).toBe(false)
    expect(isBillingError(null)).toBe(false)
  })
})

// The prod incident this fix targets: with no abortSignal, a hung search ran
// until Vercel killed /api/inngest at maxDuration=300 (9 × 504 in an hour).
// Nothing written, Inngest retried, each retry re-billed. The timeout turns
// that into a fast abort — which is only useful if the abort is classified
// TRANSIENT, so the row stays retryable.
describe('isTimeoutError', () => {
  it('matches the DOMException AbortSignal.timeout() actually throws', () => {
    expect(isTimeoutError(new DOMException('The operation was aborted.', 'TimeoutError'))).toBe(true)
  })
  it('matches a plain AbortError', () => {
    expect(
      isTimeoutError(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })),
    ).toBe(true)
  })
  it('matches an abort nested under `cause`', () => {
    const wrapper = new Error('fetch failed')
    ;(wrapper as unknown as { cause: unknown }).cause = new DOMException(
      'The operation was aborted.',
      'TimeoutError',
    )
    expect(isTimeoutError(wrapper)).toBe(true)
  })
  it('falls back to the message when a wrapper flattened the cause', () => {
    expect(isTimeoutError(new Error('Exa error: signal timed out'))).toBe(true)
  })
  it('does NOT match unrelated failures', () => {
    expect(isTimeoutError(new Error('socket hang up'))).toBe(false)
    expect(isTimeoutError(Object.assign(new Error('invalid'), { status: 400 }))).toBe(false)
    expect(isTimeoutError(null)).toBe(false)
  })
})

describe('isPermanentModelError — timeouts', () => {
  it('treats a raw timeout abort as TRANSIENT', () => {
    expect(isPermanentModelError(new DOMException('aborted', 'TimeoutError'))).toBe(false)
    expect(isPermanentModelError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(
      false,
    )
  })
  it('keeps an abort transient even when a 4xx rides along on the wrapper', () => {
    // A wrapper can carry both a 400 and the real abort cause. The abort must
    // win, or the timeout fix would permanently poison the row.
    const wrapper = Object.assign(new Error('request failed'), {
      status: 400,
      cause: new DOMException('The operation was aborted.', 'TimeoutError'),
    })
    expect(isPermanentModelError(wrapper)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Pure: contact skip guard
// ---------------------------------------------------------------------------

describe('contactSkipReason', () => {
  it('skips a workspace member self-contact', () => {
    expect(contactSkipReason({ member_id: 'm1', email: 'a@b.com' })).toBe(
      'workspace_member_self_contact',
    )
  })
  it('allowSelf lifts EXACTLY the self-contact guard', () => {
    expect(contactSkipReason({ member_id: 'm1', email: 'a@b.com' }, { allowSelf: true })).toBeNull()
    // …and nothing else: the other hard skips still apply to a member row.
    expect(
      contactSkipReason(
        { member_id: 'm1', merged_into_contact_id: 't1', email: 'a@b.com' },
        { allowSelf: true },
      ),
    ).toBe('merged_tombstone')
    expect(
      contactSkipReason(
        { member_id: 'm1', email: 'a@b.com', metadata: { enrichment: { permanent: true } } },
        { allowSelf: true },
      ),
    ).toBe('permanent_failure')
    // A member row with no identity signal at all is still not searchable.
    expect(contactSkipReason({ member_id: 'm1' }, { allowSelf: true })).toBe(
      'insufficient_identity_signal',
    )
  })
  it('skips a merge tombstone', () => {
    expect(contactSkipReason({ merged_into_contact_id: 'c9', email: 'a@b.com' })).toBe(
      'merged_tombstone',
    )
  })
  it('skips a permanently-failed row', () => {
    expect(
      contactSkipReason({ email: 'a@b.com', metadata: { enrichment: { permanent: true } } }),
    ).toBe('permanent_failure')
  })
  it('skips a bare name with no context at all', () => {
    expect(contactSkipReason({ full_name: 'Jane Doe' })).toBe('insufficient_identity_signal')
  })
  it('proceeds on an email alone', () => {
    expect(contactSkipReason({ email: 'jane@acme.com' })).toBeNull()
  })
  it('proceeds on name + company signal without an email', () => {
    expect(contactSkipReason({ full_name: 'Jane Doe', company_id: 'co1' })).toBeNull()
    expect(
      contactSkipReason({ full_name: 'Jane Doe', company: { name: 'Acme' } }),
    ).toBeNull()
    expect(
      contactSkipReason({ full_name: 'Jane Doe', company: { domain: 'acme.com' } }),
    ).toBeNull()
  })
  it('proceeds on name + a non-trivial job_title with no structured company', () => {
    expect(
      contactSkipReason({ full_name: 'Jane Doe', job_title: 'EVP or CFO, Brex' }),
    ).toBeNull()
  })
  it('proceeds on name + non-trivial notes with no structured company', () => {
    expect(
      contactSkipReason({ full_name: 'Jane Doe', notes: 'Operator Collective LP' }),
    ).toBeNull()
  })
  it('still skips when job_title and notes are whitespace or too short', () => {
    expect(contactSkipReason({ full_name: 'Jane Doe', job_title: '  ', notes: 'x' })).toBe(
      'insufficient_identity_signal',
    )
  })
  it('still skips text signal when there is no name to attach it to', () => {
    expect(contactSkipReason({ job_title: 'CTO at Acme' })).toBe('insufficient_identity_signal')
  })

  /*
   * Grant Ellery: name + linkedin.com/in/grantellery, nothing else. Every
   * Enrich click returned in seconds having searched nothing, because this
   * guard did not count the one identifier the rest of the pipeline trusts
   * most. A profile URL names exactly one human — the same standing as an
   * email.
   */
  it('proceeds on a LinkedIn profile, with or without anything else', () => {
    expect(
      contactSkipReason({
        full_name: 'Grant Ellery',
        linkedin_url: 'https://www.linkedin.com/in/grantellery/',
      }),
    ).toBeNull()
    // The profile alone carries the identity; a name is not required.
    expect(contactSkipReason({ linkedin_url: 'linkedin.com/in/grantellery' })).toBeNull()
    // A lnkd.in short link always redirects to a profile.
    expect(contactSkipReason({ linkedin_url: 'https://lnkd.in/xQ7kV2pL' })).toBeNull()
  })

  it('does not accept a company page or a stray link as a person', () => {
    expect(
      contactSkipReason({
        full_name: 'Jane Doe',
        linkedin_url: 'https://www.linkedin.com/company/acme',
      }),
    ).toBe('insufficient_identity_signal')
    expect(
      contactSkipReason({ full_name: 'Jane Doe', linkedin_url: 'https://acme.com/team' }),
    ).toBe('insufficient_identity_signal')
    expect(contactSkipReason({ full_name: 'Jane Doe', linkedin_url: '   ' })).toBe(
      'insufficient_identity_signal',
    )
  })

  it('a LinkedIn profile does not lift the hard skips', () => {
    const profile = 'https://www.linkedin.com/in/grantellery/'
    expect(contactSkipReason({ member_id: 'm1', linkedin_url: profile })).toBe(
      'workspace_member_self_contact',
    )
    expect(contactSkipReason({ merged_into_contact_id: 'c9', linkedin_url: profile })).toBe(
      'merged_tombstone',
    )
  })
})

describe('hasLinkedInProfile', () => {
  it('accepts a personal profile in any of the shapes the CRM stores', () => {
    for (const url of [
      'https://www.linkedin.com/in/grantellery/',
      'http://linkedin.com/in/grantellery',
      'linkedin.com/in/grant-ellery-31f0c2a9b',
      'https://uk.linkedin.com/in/someone?originalSubdomain=uk',
      'https://lnkd.in/xQ7kV2pL',
    ]) {
      expect(hasLinkedInProfile(url), url).toBe(true)
    }
  })

  it('rejects everything that does not name one person', () => {
    for (const url of [
      null,
      undefined,
      '',
      '   ',
      'https://www.linkedin.com',
      'https://www.linkedin.com/company/stage-2-capital',
      'https://twitter.com/grantellery',
      'not a url at all',
    ]) {
      expect(hasLinkedInProfile(url), String(url)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Integration: enrichContact / enrichCompany write-back
// ---------------------------------------------------------------------------

/**
 * Minimal service-client double: serves one row per table for the initial
 * SELECT and records the UPDATE patch so the fill-empty contract can be
 * asserted directly on what would hit the database.
 */
function makeSupabase(opts: {
  contact?: Record<string, unknown> | null
  company?: Record<string, unknown> | null
  /** Row returned by the (workspace_id, domain) company lookup. */
  companyByDomain?: Record<string, unknown> | null
  insertedCompanyId?: string
  /**
   * Metadata the row reads back with on the RE-READ the terminal write does —
   * the second `contact` SELECT, or the LAST `company` SELECT of the company
   * flow. Models a concurrent writer (`fireIcpCard`) having merged into
   * `metadata.enrichment` while the 60-180s search was in flight. Absent means
   * "nothing changed": the same row comes back every time.
   */
  metadataAfterSearch?: unknown
}) {
  const updates: Array<{ table: string; patch: Record<string, unknown> }> = []
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = []
  // The contact path queries `company` a second time (ensureCompanyForDomain);
  // the first `company` SELECT in the company path is the entity load.
  let companySelects = 0
  let contactSelects = 0

  function builder(table: string) {
    let mode: 'select' | 'insert' | 'update' = 'select'
    let patch: Record<string, unknown> = {}
    let row: Record<string, unknown> = {}

    const withFreshMetadata = (data: Record<string, unknown> | null | undefined) =>
      data && 'metadataAfterSearch' in opts
        ? { ...data, metadata: opts.metadataAfterSearch }
        : (data ?? null)

    const resolveSelect = () => {
      if (table === 'contact') {
        contactSelects++
        // The first read is the entity load; every later one is the pre-write
        // re-read of `metadata`.
        return contactSelects === 1
          ? { data: opts.contact ?? null, error: null }
          : { data: withFreshMetadata(opts.contact), error: null }
      }
      companySelects++
      // In the contact flow there is no company entity load, so every company
      // SELECT is the domain lookup — except the pre-write metadata re-read,
      // which targets `contact`, not `company`.
      if (opts.contact) return { data: opts.companyByDomain ?? null, error: null }
      if (companySelects === 1) return { data: opts.company ?? null, error: null }
      // The company flow's only other SELECT is the pre-write metadata re-read.
      return { data: withFreshMetadata(opts.company), error: null }
    }

    const settle = () => {
      if (mode === 'update') {
        updates.push({ table, patch })
        return { data: null, error: null }
      }
      if (mode === 'insert') {
        inserts.push({ table, row })
        return { data: { id: opts.insertedCompanyId ?? 'new-co' }, error: null }
      }
      return resolveSelect()
    }

    const api: Record<string, unknown> = {
      select: () => api,
      eq: () => api,
      is: () => api,
      not: () => api,
      update: (p: Record<string, unknown>) => {
        mode = 'update'
        patch = p
        return api
      },
      insert: (r: Record<string, unknown>) => {
        mode = 'insert'
        row = r
        return api
      },
      maybeSingle: async () => settle(),
      single: async () => settle(),
      then: (resolve: (r: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
    }
    return api
  }

  return { client: { from: (t: string) => builder(t) }, updates, inserts }
}

const fetchMock = vi.fn()

/** A canned Exa Deep Search response body, in the wire shape. */
function exaResponse(opts: {
  content?: Record<string, unknown> | null
  grounding?: Array<{ field: string; urls?: string[]; confidence: 'low' | 'medium' | 'high' }>
  results?: Array<{ url: string; title?: string | null; publishedDate?: string | null }>
  cost?: number
  /** Title on every grounding citation. The relevance gate reads it, so a page
   *  titled "Acme - Crunchbase Company Profile" anchors an aggregator source. */
  title?: string | null
}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      requestId: 'req_test',
      output: {
        content: opts.content ?? {},
        grounding: (opts.grounding ?? []).map((g) => ({
          field: g.field,
          citations: (g.urls ?? ['https://src']).map((url) => ({
            url,
            title: opts.title === undefined ? 'T' : opts.title,
          })),
          confidence: g.confidence,
        })),
      },
      results: opts.results ?? [{ url: 'https://src', title: 'T', publishedDate: null }],
      costDollars: { total: opts.cost ?? 0.0125 },
    }),
    text: async () => '',
  } as unknown as Response
}

/**
 * Queue an Exa answer where every listed key is grounded at `confidence`.
 * Naming the same keys twice (content + grounding) is what the real API does,
 * so the helper derives the grounding from the content instead.
 */
function mockExa(
  content: Record<string, unknown>,
  confidence: 'low' | 'medium' | 'high' = 'high',
  extra: Parameters<typeof exaResponse>[0] = {},
) {
  fetchMock.mockResolvedValue(
    exaResponse({
      content,
      grounding: Object.keys(content).map((field) => ({ field, confidence })),
      ...extra,
    }),
  )
}

/**
 * Answer the two cards of one entity with DIFFERENT payloads, in call order.
 * `mockExa` gives every card the same body, which is fine for most assertions
 * but cannot show that the merge actually unions two cards.
 */
function mockExaCards(
  ...cards: Array<{
    content: Record<string, unknown>
    confidence?: 'low' | 'medium' | 'high'
    cost?: number
    /** Citation title / URLs for every field — what the identity gates judge. */
    title?: string | null
    urls?: string[]
  }>
) {
  for (const card of cards) {
    fetchMock.mockResolvedValueOnce(
      exaResponse({
        content: card.content,
        grounding: Object.keys(card.content).map((field) => ({
          field,
          confidence: card.confidence ?? 'high',
          urls: card.urls,
        })),
        cost: card.cost,
        title: card.title,
      }),
    )
  }
}

/** Queue a rejected Exa call (network error, abort, or a thrown wrapper). */
function mockExaThrows(err: unknown) {
  fetchMock.mockRejectedValue(err)
}

/** Queue a non-2xx Exa response, which becomes an ExaRequestError. */
function mockExaStatus(status: number, body = 'nope') {
  fetchMock.mockResolvedValue({
    ok: false,
    status,
    json: async () => null,
    text: async () => body,
  } as unknown as Response)
}

beforeEach(() => {
  fetchMock.mockReset()
  serviceClientMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('EXA_API_KEY', 'k')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

/** A company with a domain, for the failure-path cases beside the contact ones. */
const baseCompanyForCredits = {
  id: 'co1',
  workspace_id: 'w1',
  name: 'Acme',
  domain: 'acme.com',
  website: null,
  industry: null,
  description: null,
  employee_count_range: null,
  annual_revenue_range: null,
  city: null,
  state: null,
  country: null,
  address: null,
  phone: null,
  contact_email: null,
  metadata: {},
}

describe('enrichContact write-back', () => {
  const baseContact = {
    id: 'c1',
    workspace_id: 'w1',
    full_name: 'Jane Doe',
    email: 'jane@acme.com',
    job_title: null,
    department: null,
    linkedin_url: null,
    notes: null,
    company_id: 'co1',
    member_id: null,
    merged_into_contact_id: null,
    metadata: {},
    company: { name: 'Acme', domain: 'acme.com' },
  }

  it("runs every card on the person's own ChatGPT plan, never Exa, and fills columns from it at no cost", async () => {
    const s = makeSupabase({ contact: baseContact })
    serviceClientMock.mockReturnValue(s.client)
    chatgptPlanFor.mockResolvedValueOnce(true)
    runUtilityTask.mockResolvedValue({
      text: '', model: 'chatgpt-plan/gpt-6-luna', usage: { inputTokens: 1, outputTokens: 1 },
      object: {
        content: { jobTitle: 'Chief Technology Officer', department: 'Engineering' },
        grounding: [
          { field: 'jobTitle', citations: [{ url: 'https://acme.com/team', title: 'Team | Acme' }], confidence: 'high' },
          { field: 'department', citations: [{ url: 'https://acme.com/team', title: 'Team | Acme' }], confidence: 'high' },
        ],
        sources: [{ url: 'https://acme.com/team', title: 'Team | Acme' }],
      },
    })

    const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'free-user' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(chatgptPlanFor).toHaveBeenCalledWith('free-user', { attempts: 2, failClosed: true })
    // Both open-web cards and the own-domain card, each on the plan.
    expect(runUtilityTask).toHaveBeenCalledTimes(3)
    for (const [call] of runUtilityTask.mock.calls) {
      expect(call).toMatchObject({ kind: 'plan_web_search', chatgptPlan: true, userId: 'free-user', workspaceId: 'w1' })
      expect((call as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal)
    }
    expect(JSON.parse((runUtilityTask.mock.calls[2][0] as { message: string }).message).onlySites).toEqual(['acme.com'])
    expect(out.status).toBe('enriched')
    expect(out.applied.sort()).toEqual(['department', 'job_title'])
    expect(s.updates[0].patch.job_title).toBe('Chief Technology Officer')
    runUtilityTask.mockReset()
  })

  it("never runs a person on Exa when their plan can't be read: the row fails transiently", async () => {
    const s = makeSupabase({ contact: baseContact })
    serviceClientMock.mockReturnValue(s.client)
    chatgptPlanFor.mockRejectedValueOnce(new Error('ChatGPT plan check failed: boom'))
    await expect(enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })).rejects.toThrow(/plan check failed/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fills empty columns and never overwrites populated ones', async () => {
    const s = makeSupabase({ contact: { ...baseContact, job_title: 'Existing Title' } })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({
      jobTitle: 'Chief Technology Officer',
      department: 'Engineering',
      linkedinUrl: 'https://linkedin.com/in/janedoe',
    })

    const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

    expect(out.status).toBe('enriched')
    // job_title was already populated → excluded. The other two were empty.
    expect(out.applied.sort()).toEqual(['department', 'linkedin_url'])
    const patch = s.updates[0].patch
    expect(patch.job_title).toBeUndefined()
    expect(patch.department).toBe('Engineering')
    expect(patch.linkedin_url).toBe('https://linkedin.com/in/janedoe')
    expect(patch.enrichment_status).toBe('enriched')
    expect(patch.enriched_at).toBeTruthy()
  })

  /*
   * Guards the prod-hang fix AND the 10-property cap: BOTH cards go out (Exa
   * 400s a schema over 10 properties, which is why one entity is two calls),
   * each carrying its own hard abort deadline so the step can never run past
   * the Inngest route's maxDuration=300.
   */
  it('sends both people cards plus an own-domain CORE card, each bounded', async () => {
    const s = makeSupabase({ contact: baseContact })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({ department: 'Engineering' })

    await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const bodies: Record<string, unknown>[] = []
    for (const call of fetchMock.mock.calls) {
      const [url, init] = call as [string, RequestInit]
      expect(url).toBe('https://api.exa.ai/search')
      expect((init.headers as Record<string, string>)['x-api-key']).toBe('k')
      expect(init.signal).toBeInstanceOf(AbortSignal)
      const body = JSON.parse(init.body as string)
      expect(body.type).toBe('deep')
      expect(body.contents).toEqual({ maxAgeHours: 24 })
      bodies.push(body)
    }

    // Every card must fit under Exa's cap, or the whole entity 400s.
    for (const body of bodies) {
      const schema = body.outputSchema as { properties: Record<string, unknown> }
      expect(Object.keys(schema.properties).length).toBeLessThanOrEqual(10)
    }
    // Open web: two DIFFERENT people cards, not the same one twice.
    expect(bodies[0].category).toBe('people')
    expect(bodies[1].category).toBe('people')
    expect(bodies[0].outputSchema).not.toEqual(bodies[1].outputSchema)
    // Own domain: the CORE card again, no category, pinned to the employer.
    expect(bodies[2].category).toBeUndefined()
    expect(bodies[2].includeDomains).toEqual(['acme.com'])
    expect(bodies[2].outputSchema).toEqual(bodies[0].outputSchema)
    // All anchored on the same query, so the merge is about one person.
    expect(bodies[0].query).toBe(bodies[1].query)
    expect(bodies[2].query).toBe(bodies[0].query)
  })

  it('skips the own-domain card when the contact has no company domain', async () => {
    const s = makeSupabase({
      contact: { ...baseContact, email: 'jane@gmail.com', company: { name: 'Acme', domain: null } },
    })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({ department: 'Engineering' }, 'high', { title: 'Jane Doe - CTO - Acme | LinkedIn' })

    await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('anchors the query on the known name, employer and domain', async () => {
    const s = makeSupabase({
      contact: { ...baseContact, job_title: 'CTO' },
    })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({ department: 'Engineering' })

    await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.query).toContain('Jane Doe')
    expect(body.query).toContain('Acme')
    expect(body.query).toContain('acme.com')
    expect(body.query).toContain('CTO')
    // The narrower variations run alongside, quoted so a namesake can't drift.
    expect(body.additionalQueries).toContain('"Jane Doe" acme.com')
  })

  it('uses the email address as the query anchor when the name is a placeholder', async () => {
    const s = makeSupabase({
      contact: { ...baseContact, full_name: 'jane@acme.com', company_id: null, company: null },
      companyByDomain: null,
    })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({ fullName: 'Jane Doe' })

    await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.query).toContain('jane@acme.com')
    // The email domain still anchors the search even with no company row.
    expect(body.query).toContain('acme.com')
  })

  it('keeps low-confidence values out of columns but inside the blob', async () => {
    const s = makeSupabase({ contact: baseContact })
    serviceClientMock.mockReturnValue(s.client)
    fetchMock.mockResolvedValue(
      exaResponse({
        content: { jobTitle: 'Possibly VP', department: 'Sales' },
        grounding: [
          { field: 'jobTitle', confidence: 'low' },
          { field: 'department', confidence: 'high' },
        ],
      }),
    )

    const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

    expect(out.applied).toEqual(['department'])
    const patch = s.updates[0].patch
    expect(patch.job_title).toBeUndefined()
    const blob = (patch.metadata as Record<string, unknown>).enrichment as EnrichmentBlob
    expect(blob.fields.job_title).toMatchObject({
      value: 'Possibly VP',
      source_url: 'https://src',
      source_title: 'T',
      confidence: 'low',
    })
    expect(blob.applied_fields).toEqual(['department'])
  })

  it('records the full blob: version, engine, cost, sources, summary', async () => {
    const s = makeSupabase({ contact: baseContact })
    serviceClientMock.mockReturnValue(s.client)
    fetchMock.mockResolvedValue(
      exaResponse({
        content: { jobTitle: 'CTO', summary: 'Jane is the CTO of Acme.' },
        grounding: [
          { field: 'jobTitle', confidence: 'high' },
          { field: 'summary', confidence: 'high' },
        ],
        results: [{ url: 'https://src', title: 'T', publishedDate: '2026-01-01' }],
        cost: 0.0125,
      }),
    )

    await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

    const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
      .enrichment as EnrichmentBlob
    expect(blob.version).toBe(ENRICHMENT_VERSION)
    expect(blob.status).toBe('enriched')
    expect(blob.model).toBe('exa/deep-search')
    // Both cards billed 0.0125, and the blob records what the ENTITY cost.
    expect(blob.search_cost_dollars).toBeCloseTo(0.0375)
    expect(blob.summary).toBe('Jane is the CTO of Acme.')
    expect(blob.sources).toEqual([
      { url: 'https://src', title: 'T', published_date: '2026-01-01' },
    ])
    // The summary has its own slot — it must not be duplicated into `fields`.
    expect(blob.fields.summary).toBeUndefined()
  })

  it('keeps the column-less rich fields (seniority, background, socials) in the blob', async () => {
    const s = makeSupabase({ contact: baseContact })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({
      seniority: 'C-level',
      previousRoles: 'VP Eng at Beta',
      education: 'MIT, BSc CS',
      expertise: 'Distributed systems',
      notableWork: 'Authored the Foo protocol',
      twitterUrl: 'https://x.com/jane',
      githubUrl: 'https://github.com/jane',
      location: 'San Francisco',
    })

    const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

    // None of these has a column, so nothing is applied…
    expect(out.applied).toEqual([])
    const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
      .enrichment as EnrichmentBlob
    // …but all of them are captured for the UI.
    for (const key of [
      'seniority', 'previous_roles', 'education', 'expertise',
      'notable_work', 'twitter_url', 'github_url', 'location',
    ]) {
      expect(blob.fields[key], key).toBeTruthy()
    }
  })

  it('preserves sibling metadata keys on write-back', async () => {
    const s = makeSupabase({
      contact: { ...baseContact, metadata: { company_autolinked: true } },
    })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({ jobTitle: 'CTO' })

    await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

    const metadata = s.updates[0].patch.metadata as Record<string, unknown>
    expect(metadata.company_autolinked).toBe(true)
    expect(metadata.enrichment).toBeTruthy()
  })

  it('creates a company from a discovered domain when the contact has none, without setting company_id', async () => {
    const s = makeSupabase({
      contact: { ...baseContact, company_id: null, company: null },
      companyByDomain: null,
      insertedCompanyId: 'co-new',
    })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({ companyName: 'Acme Corporation', companyDomain: 'https://www.acme.com/' })

    const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

    expect(out.createdCompanyId).toBe('co-new')
    expect(s.inserts).toHaveLength(1)
    expect(s.inserts[0].row).toMatchObject({
      workspace_id: 'w1',
      domain: 'acme.com',
      name: 'Acme Corporation',
    })
    // The mig-232 autolink trigger owns the attachment — writing company_id
    // here would race it and bypass its freemail/member rules.
    expect(s.updates[0].patch.company_id).toBeUndefined()
  })

  /*
   * …but the trigger links by EMAIL DOMAIN, and a contact with no email — the
   * LinkedIn-only rows the guard now searches on — would never be adopted by
   * the company just created for them. Grant Ellery came back as Co-Founder of
   * Stage 2 Capital with the company row created and his card still empty.
   */
  it('links the company itself when there is no email for the trigger to match', async () => {
    const s = makeSupabase({
      contact: {
        ...baseContact,
        email: null,
        linkedin_url: 'https://www.linkedin.com/in/grantellery/',
        company_id: null,
        company: null,
      },
      companyByDomain: null,
      insertedCompanyId: 'co-stage2',
    })
    serviceClientMock.mockReturnValue(s.client)
    // Two cards, no own-domain card: there is no employer domain to anchor
    // one to yet. Both are cited to his own profile, which with no employer
    // known is the only thing the person gate can anchor on.
    const profile = ['https://www.linkedin.com/in/grantellery']
    mockExaCards(
      { content: { companyName: 'Stage 2 Capital', companyDomain: 'stage2.capital' }, urls: profile },
      { content: { expertise: 'Sales strategy' }, urls: profile },
    )

    const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

    expect(out.createdCompanyId).toBe('co-stage2')
    expect(s.updates[0].patch.company_id).toBe('co-stage2')
    // Derived, and stamped as such — migration 232's invariant.
    expect(
      (s.updates[0].patch.metadata as Record<string, unknown>).company_autolinked,
    ).toBe(true)
  })

  it('does not create a company when the contact already has one', async () => {
    const s = makeSupabase({ contact: baseContact, companyByDomain: null })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({ companyDomain: 'acme.com' })

    await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })
    expect(s.inserts).toHaveLength(0)
  })

  it('reuses an existing company row for the discovered domain', async () => {
    const s = makeSupabase({
      contact: { ...baseContact, company_id: null, company: null },
      companyByDomain: { id: 'co-existing' },
    })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({ companyDomain: 'acme.com' })

    const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })
    expect(out.createdCompanyId).toBe('co-existing')
    expect(s.inserts).toHaveLength(0)
  })

  it('skips a member self-contact and never searches', async () => {
    const s = makeSupabase({ contact: { ...baseContact, member_id: 'm1' } })
    serviceClientMock.mockReturnValue(s.client)

    const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

    expect(out).toMatchObject({ status: 'skipped', reason: 'workspace_member_self_contact' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(s.updates[0].patch.enrichment_status).toBe('skipped')
  })

  it('allowSelf enriches a member self-contact instead of skipping it', async () => {
    const s = makeSupabase({ contact: { ...baseContact, member_id: 'm1' } })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({ jobTitle: 'Founder' })

    const out = await enrichContact({
      contactId: 'c1',
      workspaceId: 'w1',
      userId: 'u1',
      allowSelf: true,
    })

    expect(out.status).toBe('enriched')
    expect(out.applied).toEqual(['job_title'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('refuses to retry a permanently-failed contact and leaves its row untouched', async () => {
    const s = makeSupabase({
      contact: { ...baseContact, metadata: { enrichment: { permanent: true } } },
    })
    serviceClientMock.mockReturnValue(s.client)

    const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

    expect(out).toMatchObject({ status: 'skipped', reason: 'permanent_failure' })
    expect(fetchMock).not.toHaveBeenCalled()
    // Re-stamping would reset the marker's own timestamp on every sweep.
    expect(s.updates).toHaveLength(0)
  })

  it('marks failed (not enriched) when Exa returns nothing at all', async () => {
    const s = makeSupabase({ contact: baseContact })
    serviceClientMock.mockReturnValue(s.client)
    fetchMock.mockResolvedValue(exaResponse({ content: {}, results: [] }))

    const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

    expect(out).toMatchObject({ status: 'failed', error: 'no_search_results' })
    // Terminal, so the sweep doesn't re-pick the row every 30 minutes.
    expect(s.updates[0].patch.enrichment_status).toBe('failed')
  })

  // The namesake guard: an unsure card about someone at a DIFFERENT employer
  // is a stranger, and writing a stranger's title into the CRM is worse than
  // writing nothing. It still lands as an 'enriched' blob with empty fields —
  // the existing empty-enrichment UI path — so the row is terminal.
  it('writes an EMPTY enrichment when an unsure card contradicts the known employer', async () => {
    const s = makeSupabase({ contact: baseContact })
    serviceClientMock.mockReturnValue(s.client)
    fetchMock.mockResolvedValue(
      exaResponse({
        content: {
          fullName: 'Jane Doe',
          jobTitle: 'Barista',
          companyName: 'Coffee House',
          companyDomain: 'coffeehouse.io',
        },
        grounding: [
          { field: 'fullName', confidence: 'low' },
          { field: 'jobTitle', confidence: 'low' },
          { field: 'companyName', confidence: 'low' },
          { field: 'companyDomain', confidence: 'low' },
        ],
      }),
    )

    const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

    expect(out).toEqual({ status: 'enriched', applied: [] })
    const patch = s.updates[0].patch
    expect(patch.job_title).toBeUndefined()
    const blob = (patch.metadata as Record<string, unknown>).enrichment as EnrichmentBlob
    expect(blob.fields).toEqual({})
    // The sources still land, so a human can see what was (wrongly) found.
    expect(blob.sources.length).toBeGreaterThan(0)
  })

  it('keeps an unsure card that AGREES with the known employer', async () => {
    const s = makeSupabase({ contact: baseContact })
    serviceClientMock.mockReturnValue(s.client)
    fetchMock.mockResolvedValue(
      exaResponse({
        content: { jobTitle: 'CTO', companyDomain: 'acme.com' },
        grounding: [
          { field: 'jobTitle', confidence: 'low' },
          { field: 'companyDomain', confidence: 'low' },
        ],
      }),
    )

    const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

    expect(out.status).toBe('enriched')
    const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
      .enrichment as EnrichmentBlob
    expect(blob.fields.job_title).toBeTruthy()
  })

  it('keeps a confident card even when the employer moved on', async () => {
    const s = makeSupabase({ contact: baseContact })
    serviceClientMock.mockReturnValue(s.client)
    fetchMock.mockResolvedValue(
      exaResponse({
        content: { jobTitle: 'CTO', companyDomain: 'newco.com' },
        grounding: [
          { field: 'jobTitle', confidence: 'high' },
          { field: 'companyDomain', confidence: 'high' },
        ],
      }),
    )

    const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })
    expect(out.applied).toEqual(['job_title'])
  })

  it('records a PERMANENT Exa rejection without rethrowing', async () => {
    const s = makeSupabase({ contact: baseContact })
    serviceClientMock.mockReturnValue(s.client)
    mockExaStatus(400, 'bad request')

    const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

    expect(out.status).toBe('failed')
    const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
      .enrichment as EnrichmentBlob
    expect(blob.permanent).toBe(true)
    expect(blob.error).toContain('400')
  })

  // PROD, Sep 16 to Oct 25: Exa's 402 was rethrown, so every refused run was
  // retried by Inngest and re-asked Exa in seconds. Out of credits is the
  // account, not the row: recorded, returned, never retried, never permanent.
  it('returns an out-of-credit failure without rethrowing, with a message saying what to do', async () => {
    const s = makeSupabase({ contact: baseContact })
    serviceClientMock.mockReturnValue(s.client)
    mockExaStatus(402, '{"error":"You have exceeded your credits limit. Please top up to keep using Exa"}')

    const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

    expect(out).toEqual({ status: 'failed', applied: [], error: EXA_OUT_OF_CREDITS_MESSAGE })
    const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
      .enrichment as EnrichmentBlob
    expect(blob.status).toBe('failed')
    expect(blob.error).toBe(EXA_OUT_OF_CREDITS_MESSAGE)
    expect(blob.permanent).toBeUndefined()
  })

  it('returns an out-of-credit company failure the same way', async () => {
    const s = makeSupabase({ company: baseCompanyForCredits })
    serviceClientMock.mockReturnValue(s.client)
    mockExaStatus(402, 'payment required')

    const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

    expect(out.status).toBe('failed')
    expect(out.error).toBe(EXA_OUT_OF_CREDITS_MESSAGE)
    const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
      .enrichment as EnrichmentBlob
    expect(blob.permanent).toBeUndefined()
  })

  it('rethrows a rate-limit failure so Inngest retries', async () => {
    const s = makeSupabase({ contact: baseContact })
    serviceClientMock.mockReturnValue(s.client)
    mockExaStatus(429, 'slow down')

    await expect(
      enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' }),
    ).rejects.toThrow()

    const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
      .enrichment as EnrichmentBlob
    expect(blob.permanent).toBeUndefined()
  })

  it('rethrows a transient 5xx so Inngest retries', async () => {
    const s = makeSupabase({ contact: baseContact })
    serviceClientMock.mockReturnValue(s.client)
    mockExaStatus(503, 'unavailable')

    await expect(
      enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' }),
    ).rejects.toThrow()
    expect(s.updates[0].patch.enrichment_status).toBe('failed')
  })

  it('treats a missing EXA_API_KEY as TRANSIENT and rethrows', async () => {
    const s = makeSupabase({ contact: baseContact })
    serviceClientMock.mockReturnValue(s.client)
    vi.stubEnv('EXA_API_KEY', '')

    await expect(
      enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' }),
    ).rejects.toThrow(/EXA_API_KEY/)

    // No fetch was made, and the row must stay retryable — a missing env var
    // heals on the next deploy, and marking rows permanent would need a
    // migration to undo.
    expect(fetchMock).not.toHaveBeenCalled()
    const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
      .enrichment as EnrichmentBlob
    expect(blob.permanent).toBeUndefined()
    expect(blob.error).toContain('EXA_API_KEY is not configured')
  })

  it('records a timeout as a named stage and budget, not "The operation was aborted"', async () => {
    const s = makeSupabase({ contact: baseContact })
    serviceClientMock.mockReturnValue(s.client)
    mockExaThrows(new DOMException('The operation was aborted.', 'TimeoutError'))

    await expect(
      enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' }),
    ).rejects.toThrow()

    const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
      .enrichment as EnrichmentBlob
    expect(blob.error).toBe('search stage timed out after 60000ms (upstream returned nothing)')
    expect(blob.permanent).toBeUndefined()
  })

  it('keeps the raw message for a failure that is not a timeout', async () => {
    const s = makeSupabase({ contact: baseContact })
    serviceClientMock.mockReturnValue(s.client)
    mockExaThrows(new Error('socket hang up'))

    await expect(
      enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' }),
    ).rejects.toThrow()

    const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
      .enrichment as EnrichmentBlob
    expect(blob.error).toBe('socket hang up')
  })

  /* enrichContact has the SAME shape as enrichCompany: load, search for
   * 60-180s, write a blob merged onto "the previous one". The re-read before
   * the terminal write is what keeps that merge additive when something else
   * touched `metadata.enrichment` meanwhile. */
  describe('a concurrent blob write during the search survives', () => {
    it('keeps fields merged into metadata.enrichment between load and write', async () => {
      const s = makeSupabase({
        contact: {
          ...baseContact,
          metadata: { enrichment: { fields: { seniority: { value: 'VP', confidence: 'high' } } } },
        },
        metadataAfterSearch: {
          hubspot_push_error: 'nope',
          enrichment: {
            fields: {
              seniority: { value: 'VP', confidence: 'high' },
              interests: { value: 'Sailing', confidence: 'high' },
            },
          },
        },
      })
      serviceClientMock.mockReturnValue(s.client)
      mockExa({ department: 'Engineering' })

      const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })
      expect(out.status).toBe('enriched')

      const metadata = s.updates[0].patch.metadata as Record<string, unknown>
      const fields = (metadata.enrichment as EnrichmentBlob).fields as Record<
        string,
        { value: string }
      >
      expect(fields.interests.value).toBe('Sailing')
      expect(fields.seniority.value).toBe('VP')
      expect(fields.department.value).toBe('Engineering')
      expect(metadata.hubspot_push_error).toBe('nope')
    })
  })

  // A failed run used to record $0 whatever its answered cards billed, so the
  // CRM's spend totals undercounted every failure. It records what it spent.
  describe('what a failed run cost', () => {
    it('records the cost of the cards that answered before one failed, and adds it to the total', async () => {
      const s = makeSupabase({
        contact: { ...baseContact, metadata: { enrichment: { status: 'enriched', total_cost_dollars: 0.05 } } },
      })
      serviceClientMock.mockReturnValue(s.client)
      fetchMock.mockResolvedValueOnce(exaResponse({ content: { jobTitle: 'CTO' }, cost: 0.011 }))
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => null,
        text: async () => 'unavailable',
      } as unknown as Response)
      fetchMock.mockResolvedValueOnce(exaResponse({ content: { jobTitle: 'CTO' }, cost: 0.013 }))

      await expect(enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })).rejects.toThrow()

      const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
        .enrichment as EnrichmentBlob
      expect(blob.status).toBe('failed')
      // Both answered cards (open-web CORE and the own-domain card), not $0.
      expect(blob.search_cost_dollars).toBeCloseTo(0.024, 6)
      expect(blob.total_cost_dollars).toBeCloseTo(0.074, 6)
    })

    it('waits for every card before writing the failure (none is still in flight)', async () => {
      const s = makeSupabase({ contact: baseContact })
      serviceClientMock.mockReturnValue(s.client)
      let settleSlow: (r: Response) => void = () => {}
      fetchMock.mockRejectedValueOnce(Object.assign(new Error('bad gateway'), { status: 502 }))
      fetchMock.mockResolvedValueOnce(exaResponse({ content: { education: 'MIT' }, cost: 0.02 }))
      fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { settleSlow = r }))

      const run = enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })
      await new Promise((r) => setTimeout(r, 10))
      expect(s.updates).toHaveLength(0)
      settleSlow(exaResponse({ content: {}, cost: 0.005 }))
      await expect(run).rejects.toThrow()

      const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
        .enrichment as EnrichmentBlob
      expect(blob.search_cost_dollars).toBeCloseTo(0.025, 6)
    })

    it('records the company cards that answered before DETAILS failed', async () => {
      const s = makeSupabase({ company: baseCompanyForCredits })
      serviceClientMock.mockReturnValue(s.client)
      // CORE (own domain) answers; DETAILS 503s; CONTACT answers.
      fetchMock.mockResolvedValueOnce(
        exaResponse({ content: { industry: 'Software' }, grounding: [{ field: 'industry', confidence: 'high' }], cost: 0.012 }),
      )
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => null,
        text: async () => 'unavailable',
      } as unknown as Response)
      fetchMock.mockResolvedValueOnce(exaResponse({ content: { phone: '+1 555 0100' }, cost: 0.009 }))

      await expect(enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })).rejects.toThrow()

      const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
        .enrichment as EnrichmentBlob
      expect(blob.status).toBe('failed')
      expect(blob.search_cost_dollars).toBeCloseTo(0.021, 6)
    })

    it('counts an empty own-domain CORE that was replaced by its open-web fallback', async () => {
      const s = makeSupabase({ company: baseCompanyForCredits })
      serviceClientMock.mockReturnValue(s.client)
      fetchMock.mockResolvedValueOnce(exaResponse({ content: {}, grounding: [], cost: 0.004 }))
      fetchMock.mockResolvedValueOnce(
        exaResponse({
          content: { industry: 'Software' },
          grounding: [{ field: 'industry', confidence: 'high', urls: ['https://acme.com/about'] }],
          cost: 0.012,
        }),
      )
      fetchMock.mockResolvedValueOnce(exaResponse({ content: {}, grounding: [], cost: 0.01 }))
      fetchMock.mockResolvedValueOnce(exaResponse({ content: {}, grounding: [], cost: 0.006 }))

      await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

      const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
        .enrichment as EnrichmentBlob
      expect(blob.search_cost_dollars).toBeCloseTo(0.032, 6)
    })
  })

  /*
   * The 10-property cap forces two cards per entity. These lock in that the
   * split is invisible downstream: fields from EITHER card reach columns and
   * the blob, the cost is the entity's total, and a card that fails fails the
   * whole entity rather than silently writing a half-answer into fill-empty
   * columns that then never get a second chance.
   */
  describe('two-card merge', () => {
    it('applies columns from BOTH cards and blobs both cards’ fields', async () => {
      const s = makeSupabase({ contact: baseContact })
      serviceClientMock.mockReturnValue(s.client)
      // Both cards cite Jane's profile at Acme — the gate lets those through.
      mockExaCards(
        { content: { jobTitle: 'CTO', department: 'Engineering' }, title: 'Jane Doe - CTO - Acme | LinkedIn' },
        { content: { previousRoles: 'VP Eng at Beta', education: 'MIT' }, title: 'Jane Doe - CTO - Acme | LinkedIn' },
      )

      const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

      // CORE fed the columns…
      expect(out.applied.sort()).toEqual(['department', 'job_title'])
      const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
        .enrichment as EnrichmentBlob
      // …and BACKGROUND still reached the blob.
      expect(blob.fields.previous_roles).toMatchObject({ value: 'VP Eng at Beta' })
      expect(blob.fields.education).toMatchObject({ value: 'MIT' })
    })

    /*
     * THE DEVIN MARSH INCIDENT. Open-web cards cite a namesake's LinkedIn
     * profile (roles, education) and two colleagues' profiles (title,
     * company); the employer's own team page says he is the CEO. Nothing
     * from a stranger's page may reach a column or Notes; the team page may.
     */
    it('keeps a namesake’s findings out of the columns and Notes, and lets the employer’s own page fill them', async () => {
      const s = makeSupabase({
        contact: {
          ...baseContact,
          full_name: 'Devin Marsh',
          email: 'devin@fieldwing.ag',
          linkedin_url: 'https://www.linkedin.com/in/justdevin/',
          company: { name: 'Fieldwing', domain: 'fieldwing.ag' },
        },
      })
      serviceClientMock.mockReturnValue(s.client)
      mockExaCards(
        {
          content: { jobTitle: 'Senior Counsel', department: 'Legal', summary: 'A lawyer at Halvern.', location: 'Tulsa, Oklahoma' },
          title: 'Devin Marsh',
          urls: ['https://www.linkedin.com/in/devin-marsh-4c7e2d10'],
        },
        {
          content: { previousRoles: 'Associate at Marlowe Pierce (2016–2020)', education: 'J.D. from Lakeshore (2012–2016)' },
          title: 'Devin Marsh',
          urls: ['https://www.linkedin.com/in/devin-marsh-4c7e2d10'],
        },
        {
          content: { jobTitle: 'CEO', summary: 'Devin Marsh is the CEO of Fieldwing.' },
          title: 'Our Team - Fieldwing',
          urls: ['https://fieldwing.ag/company/'],
        },
      )

      const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

      expect(out.status).toBe('enriched')
      // The team page fills the title; the lawyer's department never lands.
      expect(out.applied).toEqual(['job_title'])
      const patch = s.updates[0].patch
      expect(patch.job_title).toBe('CEO')
      expect(patch.department).toBeUndefined()
      // Notes carry the team page's bio, not the lawyer's.
      expect(patch.notes).toBe('Devin Marsh is the CEO of Fieldwing.')
      const blob = (patch.metadata as Record<string, unknown>).enrichment as EnrichmentBlob
      const fields = blob.fields as Record<string, { value: string; confidence: string }>
      // The lawyer's facts stay visible — as low, i.e. Unverified.
      expect(fields.previous_roles).toMatchObject({ confidence: 'low' })
      expect(fields.education).toMatchObject({ confidence: 'low' })
      expect(fields.location).toMatchObject({ value: 'Tulsa, Oklahoma', confidence: 'low' })
      expect(fields.job_title).toMatchObject({ value: 'CEO', confidence: 'high' })
      expect(blob.summary).toBe('Devin Marsh is the CEO of Fieldwing.')
    })

    it('writes nothing to Notes when the only summary came from an unrelated page', async () => {
      const s = makeSupabase({ contact: { ...baseContact, notes: 'Met at the expo.' } })
      serviceClientMock.mockReturnValue(s.client)
      mockExaCards(
        { content: { summary: 'Someone else entirely.' }, title: 'Jane Doe', urls: ['https://www.linkedin.com/in/jane-doe-000'] },
        { content: {} },
      )
      // The own-domain card fails outright — the run must survive that too.
      fetchMock.mockRejectedValueOnce(new Error('socket hang up'))

      const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

      expect(out.status).toBe('enriched')
      const patch = s.updates[0].patch
      expect(patch.notes).toBeUndefined()
      const blob = (patch.metadata as Record<string, unknown>).enrichment as EnrichmentBlob
      expect(blob.summary).toBeNull()
      // The summary is never a blob field — it lives in blob.summary only.
      expect(blob.fields).not.toHaveProperty('summary')
    })

    it('quotes the contact’s LinkedIn profile in every query', async () => {
      const s = makeSupabase({ contact: { ...baseContact, linkedin_url: 'https://www.linkedin.com/in/janedoe/' } })
      serviceClientMock.mockReturnValue(s.client)
      mockExa({ department: 'Engineering' })

      await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

      for (const call of fetchMock.mock.calls) {
        const body = JSON.parse((call[1] as RequestInit).body as string) as { query: string }
        expect(body.query).toContain('LinkedIn: linkedin.com/in/janedoe')
      }
    })

    it('sums the cost of both cards into the blob', async () => {
      const s = makeSupabase({ contact: baseContact })
      serviceClientMock.mockReturnValue(s.client)
      mockExaCards(
        { content: { jobTitle: 'CTO' }, cost: 0.01 },
        { content: { education: 'MIT' }, cost: 0.02 },
      )

      await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

      const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
        .enrichment as EnrichmentBlob
      expect(blob.search_cost_dollars).toBeCloseTo(0.03)
    })

    it('fails the whole entity when ONE card fails, classified as usual', async () => {
      const s = makeSupabase({ contact: baseContact })
      serviceClientMock.mockReturnValue(s.client)
      // First card answers, second 5xx's.
      fetchMock.mockResolvedValueOnce(
        exaResponse({
          content: { jobTitle: 'CTO' },
          grounding: [{ field: 'jobTitle', confidence: 'high' }],
        }),
      )
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => null,
        text: async () => 'unavailable',
      } as unknown as Response)

      // Transient, so it rethrows for Inngest exactly as a single-call failure did.
      await expect(
        enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' }),
      ).rejects.toThrow()

      // No half-answer was written: the columns are untouched.
      const patch = s.updates[0].patch
      expect(patch.job_title).toBeUndefined()
      expect(patch.enrichment_status).toBe('failed')
      const blob = (patch.metadata as Record<string, unknown>).enrichment as EnrichmentBlob
      expect(blob.permanent).toBeUndefined()
      // …but the card that answered is still paid for, and recorded.
      expect(blob.search_cost_dollars).toBeCloseTo(0.0125, 6)
    })

    it('marks a permanently-rejected card permanent for the entity', async () => {
      const s = makeSupabase({ contact: baseContact })
      serviceClientMock.mockReturnValue(s.client)
      fetchMock.mockResolvedValueOnce(
        exaResponse({
          content: { jobTitle: 'CTO' },
          grounding: [{ field: 'jobTitle', confidence: 'high' }],
        }),
      )
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => null,
        text: async () => 'bad schema',
      } as unknown as Response)

      const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

      expect(out.status).toBe('failed')
      const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
        .enrichment as EnrichmentBlob
      expect(blob.permanent).toBe(true)
    })
  })

  describe('data quality', () => {
    it('never writes an Exa placeholder into a contact column', async () => {
      const s = makeSupabase({ contact: baseContact })
      serviceClientMock.mockReturnValue(s.client)
      fetchMock.mockResolvedValue(
        exaResponse({
          content: { jobTitle: 'Not publicly disclosed', department: 'Engineering' },
          grounding: [
            { field: 'jobTitle', confidence: 'medium' },
            { field: 'department', confidence: 'high' },
          ],
        }),
      )

      const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

      expect(out.applied).toEqual(['department'])
      const patch = s.updates[0].patch
      expect(patch.job_title).toBeUndefined()
      const blob = (patch.metadata as Record<string, unknown>).enrichment as EnrichmentBlob
      expect(blob.fields.job_title).toBeUndefined()
    })

    it('does NOT demote look-alike domains for people', async () => {
      // A person's citations legitimately span employers, press and profiles,
      // so there is no "the domain must match" invariant to enforce.
      const s = makeSupabase({ contact: baseContact })
      serviceClientMock.mockReturnValue(s.client)
      fetchMock.mockResolvedValue(
        exaResponse({
          content: { jobTitle: 'CTO' },
          grounding: [
            { field: 'jobTitle', urls: ['https://acmecorp.io/team'], confidence: 'high' },
          ],
        }),
      )

      const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })
      expect(out.applied).toEqual(['job_title'])
    })
  })

  describe('full_name', () => {
    it('replaces an email-as-name with the discovered real name', async () => {
      const s = makeSupabase({
        contact: { ...baseContact, full_name: 'jane@acme.com' },
      })
      serviceClientMock.mockReturnValue(s.client)
      mockExa({ fullName: 'Jane Doe' })

      const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

      expect(out.applied).toContain('full_name')
      expect(s.updates[0].patch.full_name).toBe('Jane Doe')
    })

    it('replaces a local-part-as-name too', async () => {
      const s = makeSupabase({ contact: { ...baseContact, full_name: 'jane' } })
      serviceClientMock.mockReturnValue(s.client)
      mockExa({ fullName: 'Jane Doe' })

      await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })
      expect(s.updates[0].patch.full_name).toBe('Jane Doe')
    })

    it('fills an empty name', async () => {
      const s = makeSupabase({ contact: { ...baseContact, full_name: null } })
      serviceClientMock.mockReturnValue(s.client)
      mockExa({ fullName: 'Jane Doe' })

      await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })
      expect(s.updates[0].patch.full_name).toBe('Jane Doe')
    })

    it('NEVER overwrites a real human-entered name', async () => {
      const s = makeSupabase({ contact: { ...baseContact, full_name: 'Jane Q. Doe' } })
      serviceClientMock.mockReturnValue(s.client)
      mockExa({ fullName: 'Janet Doe' })

      const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

      expect(out.applied).not.toContain('full_name')
      expect(s.updates[0].patch.full_name).toBeUndefined()
    })

    it('never applies a low-confidence name, even over a placeholder', async () => {
      const s = makeSupabase({ contact: { ...baseContact, full_name: 'jane@acme.com' } })
      serviceClientMock.mockReturnValue(s.client)
      mockExa({ fullName: 'Jane Doe' }, 'low')

      const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

      expect(out.applied).not.toContain('full_name')
      expect(s.updates[0].patch.full_name).toBeUndefined()
    })

    it('records the extracted name in the blob whether or not it was applied', async () => {
      const s = makeSupabase({ contact: { ...baseContact, full_name: 'Jane Q. Doe' } })
      serviceClientMock.mockReturnValue(s.client)
      mockExa({ fullName: 'Janet Doe' })

      await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

      const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
        .enrichment as EnrichmentBlob
      expect(blob.fields.full_name).toMatchObject({ value: 'Janet Doe' })
    })

    it('leaves first_name/last_name alone', async () => {
      const s = makeSupabase({ contact: { ...baseContact, full_name: 'jane@acme.com' } })
      serviceClientMock.mockReturnValue(s.client)
      mockExa({ fullName: 'Jane Doe' })

      await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

      expect(s.updates[0].patch.first_name).toBeUndefined()
      expect(s.updates[0].patch.last_name).toBeUndefined()
    })
  })

  // ── Summary → contact.notes ───────────────────────────────
  // The bio paragraph is written into the contact's Notes rather than only
  // living in the sidebar blob. Unlike the columns this is not fill-empty:
  // existing notes are preserved, and a re-run swaps its own previous block.
  describe('summary → notes', () => {
    const SUMMARY = 'Jane Doe is the CTO of Acme, where she leads engineering.'

    it('writes the summary into empty notes', async () => {
      const s = makeSupabase({ contact: { ...baseContact, notes: null } })
      serviceClientMock.mockReturnValue(s.client)
      mockExa({ summary: SUMMARY })

      await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

      const patch = s.updates[0].patch
      expect(patch.notes).toBe(SUMMARY)
      const blob = (patch.metadata as Record<string, unknown>).enrichment as EnrichmentBlob
      expect(blob.notes_summary).toBe(SUMMARY)
    })

    it('appends after existing notes without modifying them', async () => {
      const existing = 'Met at the conference.\nWants a demo in Q3.'
      const s = makeSupabase({ contact: { ...baseContact, notes: existing } })
      serviceClientMock.mockReturnValue(s.client)
      mockExa({ summary: SUMMARY })

      await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

      expect(s.updates[0].patch.notes).toBe(`${existing}\n\n${SUMMARY}`)
    })

    it('re-enrich replaces the previous block rather than duplicating it', async () => {
      const existing = 'Met at the conference.'
      const OLD = 'Jane Doe is a Web Strategy Consultant at Bright Wave.'
      const s = makeSupabase({
        contact: {
          ...baseContact,
          notes: `${existing}\n\n${OLD}`,
          metadata: { enrichment: { notes_summary: OLD } },
        },
      })
      serviceClientMock.mockReturnValue(s.client)
      mockExa({ summary: SUMMARY })

      await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

      const notes = s.updates[0].patch.notes as string
      expect(notes).toBe(`${existing}\n\n${SUMMARY}`)
      expect(notes).not.toContain(OLD)
    })

    it('appends when the user has edited the previously-appended block', async () => {
      const OLD = 'Jane Doe is a Web Strategy Consultant at Bright Wave.'
      const edited = 'Jane Doe is a Web Strategy Consultant at Bright Wave (left in 2025).'
      const s = makeSupabase({
        contact: {
          ...baseContact,
          notes: edited,
          metadata: { enrichment: { notes_summary: OLD } },
        },
      })
      serviceClientMock.mockReturnValue(s.client)
      mockExa({ summary: SUMMARY })

      await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

      // The user's edit is never touched — the new block lands after it.
      expect(s.updates[0].patch.notes).toBe(`${edited}\n\n${SUMMARY}`)
    })

    it('leaves notes untouched when the run produced no summary', async () => {
      const s = makeSupabase({ contact: { ...baseContact, notes: 'Hand-written.' } })
      serviceClientMock.mockReturnValue(s.client)
      mockExa({ jobTitle: 'CTO' })

      const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

      expect(out.status).toBe('enriched')
      const patch = s.updates[0].patch
      expect(patch.notes).toBeUndefined()
      const blob = (patch.metadata as Record<string, unknown>).enrichment as EnrichmentBlob
      expect(blob.notes_summary).toBeUndefined()
    })

    it('keeps the previous anchor when an enriched run writes no new notes', async () => {
      const OLD = 'Jane Doe is a Web Strategy Consultant at Bright Wave.'
      const s = makeSupabase({
        contact: { ...baseContact, notes: OLD, metadata: { enrichment: { notes_summary: OLD } } },
      })
      serviceClientMock.mockReturnValue(s.client)
      mockExa({ jobTitle: 'CTO' })

      const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

      expect(out.status).toBe('enriched')
      const blob = (s.updates[0].patch.metadata as Record<string, unknown>).enrichment as EnrichmentBlob
      // Without it, the next run with a summary would append a second bio.
      expect(blob.notes_summary).toBe(OLD)
    })

    it('keeps notes out of applied_fields — it is not a fill-empty column', async () => {
      const s = makeSupabase({ contact: { ...baseContact, notes: null } })
      serviceClientMock.mockReturnValue(s.client)
      mockExa({ summary: SUMMARY, department: 'Engineering' })

      const out = await enrichContact({ contactId: 'c1', workspaceId: 'w1', userId: 'u1' })

      expect(out.applied).toEqual(['department'])
      const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
        .enrichment as EnrichmentBlob
      expect(blob.applied_fields).toEqual(['department'])
    })
  })
})

describe('enrichCompany write-back', () => {
  const baseCompany = {
    id: 'co1',
    workspace_id: 'w1',
    name: 'Acme',
    domain: 'acme.com',
    website: null,
    industry: null,
    description: null,
    employee_count_range: null,
    annual_revenue_range: null,
    city: null,
    state: null,
    country: null,
    address: null,
    phone: null,
    contact_email: null,
    metadata: {},
  }

  it("runs a company's cards on the person's own ChatGPT plan, its CORE card on the company's own site", async () => {
    const s = makeSupabase({ company: baseCompany })
    serviceClientMock.mockReturnValue(s.client)
    chatgptPlanFor.mockResolvedValueOnce(true)
    runUtilityTask.mockResolvedValue({
      text: '', model: 'chatgpt-plan/gpt-6-luna', usage: { inputTokens: 1, outputTokens: 1 },
      object: {
        content: { industry: 'Fintech', description: 'Acme builds payments infrastructure.' },
        grounding: [
          { field: 'industry', citations: [{ url: 'https://acme.com/about', title: 'About Acme' }], confidence: 'high' },
          { field: 'description', citations: [{ url: 'https://acme.com/about', title: 'About Acme' }], confidence: 'high' },
        ],
        sources: [],
      },
    })

    const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'free-user' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(runUtilityTask.mock.calls.length).toBeGreaterThan(0)
    expect(JSON.parse((runUtilityTask.mock.calls[0][0] as { message: string }).message)).toMatchObject({ onlySites: ['acme.com'], subject: 'a company' })
    expect(out.status).toBe('enriched')
    expect(out.applied).toEqual(expect.arrayContaining(['industry', 'description']))
    runUtilityTask.mockReset()
  })

  it('fills empty columns only', async () => {
    const s = makeSupabase({ company: { ...baseCompany, industry: 'Existing Industry' } })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({
      industry: 'Fintech',
      description: 'Acme builds payments infrastructure.',
      website: 'https://acme.com',
      headquartersCity: 'San Francisco',
      headquartersState: 'CA',
      headquartersCountry: 'USA',
    })

    const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

    expect(out.status).toBe('enriched')
    expect(out.applied).not.toContain('industry')
    const patch = s.updates[0].patch
    expect(patch.industry).toBeUndefined()
    expect(patch.description).toBe('Acme builds payments infrastructure.')
    expect(patch.website).toBe('https://acme.com')
    expect(patch.city).toBe('San Francisco')
    expect(patch.state).toBe('CA')
    expect(patch.country).toBe('USA')
  })

  it('never writes notes — `company` has no notes column', async () => {
    const s = makeSupabase({ company: baseCompany })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({ industry: 'Fintech', summary: 'A company overview.' })

    await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

    const patch = s.updates[0].patch
    expect(patch.notes).toBeUndefined()
    const blob = (patch.metadata as Record<string, unknown>).enrichment as EnrichmentBlob
    expect(blob.summary).toBe('A company overview.')
    expect(blob.notes_summary).toBeUndefined()
  })

  /*
   * ADDITIVE RE-RUNS. Refreshing a record must only ever add or update:
   * columns were already fill-empty, but the blob used to be replaced
   * wholesale, so a thinner re-run silently dropped funding, people, news…
   * from the Details tab, and a failed run wiped them entirely.
   */
  /*
   * THE CONCURRENT-WRITER CONTRACT.
   *
   * `enrichCompany` loads the row, spends 60-180s in Exa, then writes. The blob
   * it writes is built by MERGING onto the previous one, and if "the previous
   * one" is the copy loaded before the search, the write is a last-write-wins
   * overwrite of anything that landed in between. Something does land in
   * between: POST /api/account/prospecting/source kicks this enrichment and
   * then fires the ICP card, which merges `target_customer` /
   * `value_proposition` into the SAME blob. On production Dial8's own company
   * row came out with the three CRM cards and no ICP fields at all.
   *
   * So the terminal write re-reads `metadata` first. These tests model that by
   * having the row read back with a DIFFERENT blob than it was loaded with.
   */
  describe('a concurrent blob write during the search survives', () => {
    const loaded = {
      enrichment: {
        version: 1,
        status: 'enriched',
        fields: { industry: { value: 'Fintech', confidence: 'high' } },
        applied_fields: ['industry'],
        sources: [{ url: 'https://acme.com' }],
        total_cost_dollars: 0.02,
      },
    }
    // What the ICP card merged in while the three cards were in flight.
    const afterSearch = {
      company_autolinked: true,
      enrichment: {
        ...loaded.enrichment,
        fields: {
          ...loaded.enrichment.fields,
          target_customer: { value: 'Series A-C sales teams', confidence: 'high' },
          value_proposition: { value: 'Turn every meeting into pipeline', confidence: 'high' },
        },
        sources: [{ url: 'https://acme.com/customers' }, { url: 'https://acme.com' }],
        icp_card_at: '2026-09-04T00:00:00.000Z',
        total_cost_dollars: 0.032,
      },
    }

    it('keeps fields merged into metadata.enrichment between load and write', async () => {
      const s = makeSupabase({
        company: { ...baseCompany, metadata: loaded },
        metadataAfterSearch: afterSearch,
      })
      serviceClientMock.mockReturnValue(s.client)
      mockExa({ description: 'Acme builds payments infrastructure.' })

      const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })
      expect(out.status).toBe('enriched')

      const metadata = s.updates[0].patch.metadata as Record<string, unknown>
      const blob = metadata.enrichment as EnrichmentBlob
      const fields = blob.fields as Record<string, { value: string }>
      // The ICP card's fields — the ones production lost — are still here…
      expect(fields.target_customer.value).toBe('Series A-C sales teams')
      expect(fields.value_proposition.value).toBe('Turn every meeting into pipeline')
      // …alongside this run's own and the ones both blobs already had.
      expect(fields.description.value).toBe('Acme builds payments infrastructure.')
      expect(fields.industry.value).toBe('Fintech')
      // Its citation, its stamp and its spend all carried too.
      expect(blob.sources.map((x) => x.url)).toContain('https://acme.com/customers')
      expect((blob as unknown as Record<string, unknown>).icp_card_at).toBe(
        '2026-09-04T00:00:00.000Z',
      )
      expect(blob.total_cost_dollars).toBeGreaterThanOrEqual(0.032)
      // Sibling metadata keys written meanwhile survive as well.
      expect(metadata.company_autolinked).toBe(true)
    })

    it('carries the concurrent blob onto a FAILED terminal write too', async () => {
      // no_search_results is terminal and rewrites the blob; it must not eat
      // the ICP fields either.
      const s = makeSupabase({
        company: { ...baseCompany, metadata: loaded },
        metadataAfterSearch: afterSearch,
      })
      serviceClientMock.mockReturnValue(s.client)
      mockExa({}, 'high', { results: [] })

      const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })
      expect(out.status).toBe('failed')
      const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
        .enrichment as EnrichmentBlob
      expect((blob.fields as Record<string, { value: string }>).target_customer.value).toBe(
        'Series A-C sales teams',
      )
    })

    it('falls back to the loaded row when the re-read returns nothing', async () => {
      // A re-read that comes back empty must never blank a blob that was there.
      const s = makeSupabase({
        company: { ...baseCompany, metadata: loaded },
        metadataAfterSearch: null,
      })
      serviceClientMock.mockReturnValue(s.client)
      mockExa({ description: 'Acme builds payments infrastructure.' })

      await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })
      const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
        .enrichment as EnrichmentBlob
      const fields = blob.fields as Record<string, { value: string }>
      expect(fields.industry.value).toBe('Fintech')
      expect(fields.description.value).toBe('Acme builds payments infrastructure.')
    })
  })

  describe('re-enrichment keeps everything the row already had', () => {
    const previous = {
      enrichment: {
        version: 2,
        status: 'enriched',
        enriched_at: '2026-08-01T00:00:00.000Z',
        model: 'exa/deep-search',
        fields: {
          industry: { value: 'Fintech', confidence: 'high', source_url: 'https://acme.com', found_at: '2026-08-01T00:00:00.000Z' },
          funding_stage: { value: 'Series B', confidence: 'high', source_url: 'https://crunchbase.com/acme' },
          key_people: { value: 'Jane Doe (CEO)', confidence: 'medium', source_url: 'https://acme.com/team' },
          founded_year: { value: '2015', confidence: 'high', source_url: 'https://acme.com/about' },
        },
        applied_fields: ['industry', 'city'],
        sources: [{ url: 'https://crunchbase.com/acme', title: 'Acme - Crunchbase' }, { url: 'https://acme.com' }],
        summary: 'Acme builds payments infrastructure.',
        search_cost_dollars: 0.036,
      },
      company_autolinked: true,
    }
    const enrichedCompany = { ...baseCompany, industry: 'Fintech', city: 'Boston', metadata: previous }

    function blobOf(s: ReturnType<typeof makeSupabase>) {
      return (s.updates[0].patch.metadata as Record<string, unknown>).enrichment as EnrichmentBlob
    }

    it("carries Prospecting's icp_card_at stamp — it is that card's only spend guard", async () => {
      // The blob is replaced wholesale on every terminal write, and
      // `fireIcpCard` keys idempotence on this timestamp alone. Dropping it
      // would re-bill $0.012 on the next list creation.
      const s = makeSupabase({
        company: {
          ...baseCompany,
          metadata: {
            enrichment: {
              ...previous.enrichment,
              icp_card_at: '2026-09-04T00:00:00.000Z',
            },
          },
        },
      })
      serviceClientMock.mockReturnValue(s.client)
      mockExa({ recentNews: 'Acme raised a Series C.' })

      await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })
      expect(blobOf(s).icp_card_at).toBe('2026-09-04T00:00:00.000Z')
    })

    it('keeps fields the new run did not find and updates the ones it did', async () => {
      const s = makeSupabase({ company: enrichedCompany })
      serviceClientMock.mockReturnValue(s.client)
      // The re-run only comes back with recent news and a newer headcount.
      mockExa({ recentNews: 'Acme raised a Series C.', employeeCount: '201-500' })

      const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

      expect(out.status).toBe('enriched')
      const blob = blobOf(s)
      const fields = blob.fields as Record<string, { value: string; found_at?: string }>
      // Carried over, stamps intact (older entries inherit the run stamp).
      expect(fields.funding_stage.value).toBe('Series B')
      expect(fields.funding_stage.found_at).toBe('2026-08-01T00:00:00.000Z')
      expect(fields.key_people.value).toBe('Jane Doe (CEO)')
      expect(fields.founded_year.value).toBe('2015')
      expect(fields.industry.found_at).toBe('2026-08-01T00:00:00.000Z')
      // New this run, stamped now.
      expect(fields.recent_news.value).toBe('Acme raised a Series C.')
      expect(fields.recent_news.found_at).toBe(blob.enriched_at)
      expect(fields.employee_count.value).toBe('201-500')
      // Applied columns are the union; sources are new-first, de-duplicated.
      expect(blob.applied_fields).toEqual(expect.arrayContaining(['industry', 'city', 'employee_count_range']))
      expect(blob.sources.map((x) => x.url)).toEqual(['https://src', 'https://crunchbase.com/acme', 'https://acme.com'])
      expect(blob.summary).toBe('Acme builds payments infrastructure.')
      expect(blob.total_cost_dollars).toBeCloseTo(0.036 + 0.0125 * 3, 6)
      expect(blob.last_run_at).toBe(blob.enriched_at)
      // Sibling metadata keys survive as before.
      expect((s.updates[0].patch.metadata as Record<string, unknown>).company_autolinked).toBe(true)
    })

    it('does not let a low-confidence find displace a verified value', async () => {
      const s = makeSupabase({ company: enrichedCompany })
      serviceClientMock.mockReturnValue(s.client)
      // The cocktail-bar namesake: founded 1885, low. The 2015 stays.
      mockExa({ foundedYear: '1885', industry: 'Hospitality' }, 'low')

      await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

      const fields = blobOf(s).fields as Record<string, { value: string; confidence: string }>
      expect(fields.founded_year).toMatchObject({ value: '2015', confidence: 'high' })
      expect(fields.industry).toMatchObject({ value: 'Fintech', confidence: 'high' })
    })

    it('lets an equal-or-higher confidence find replace the old value', async () => {
      const s = makeSupabase({ company: enrichedCompany })
      serviceClientMock.mockReturnValue(s.client)
      mockExa({ keyPeople: 'Jane Doe (CEO), Bob Roe (CTO)' }, 'medium')

      await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

      const fields = blobOf(s).fields as Record<string, { value: string }>
      expect(fields.key_people.value).toBe('Jane Doe (CEO), Bob Roe (CTO)')
    })

    it('keeps every earlier finding when the run fails', async () => {
      const s = makeSupabase({ company: enrichedCompany })
      serviceClientMock.mockReturnValue(s.client)
      mockExaStatus(400, 'bad schema')

      const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

      expect(out.status).toBe('failed')
      const blob = blobOf(s)
      expect(blob.status).toBe('failed')
      expect(Object.keys(blob.fields).sort()).toEqual(['founded_year', 'funding_stage', 'industry', 'key_people'])
      expect(blob.sources).toHaveLength(2)
      expect(blob.summary).toBe('Acme builds payments infrastructure.')
      // The findings are still from August; only the run stamp moves.
      expect(blob.enriched_at).toBe('2026-08-01T00:00:00.000Z')
      expect(blob.last_run_at).not.toBe('2026-08-01T00:00:00.000Z')
      expect(s.updates[0].patch.enriched_at).toBe('2026-08-01T00:00:00.000Z')
    })

    it('keeps every earlier finding when the run finds nothing it can trust', async () => {
      const s = makeSupabase({ company: enrichedCompany })
      serviceClientMock.mockReturnValue(s.client)
      // Own-domain CORE empty, everything else low → the namesake guard's
      // empty-enrichment path, which used to write `fields: {}`.
      fetchMock.mockResolvedValueOnce(exaResponse({ content: {}, results: [] }))
      mockExa({ industry: 'Bars' }, 'low')

      const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

      expect(out.status).toBe('enriched')
      expect(out.applied).toEqual([])
      const fields = blobOf(s).fields as Record<string, { value: string }>
      expect(fields.funding_stage.value).toBe('Series B')
      expect(fields.industry.value).toBe('Fintech')
    })
  })

  it('falls back to the description when Exa returned no summary', async () => {
    const s = makeSupabase({ company: baseCompany })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({ description: 'Acme builds payments infrastructure.' })

    await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

    const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
      .enrichment as EnrichmentBlob
    expect(blob.summary).toBe('Acme builds payments infrastructure.')
  })

  /*
   * IDENTITY ANCHORING (the cocktail-bar fix). CORE is restricted to the
   * company's own domain; DETAILS then goes to the open web with a query built
   * from the name CORE resolved.
   */
  it('anchors the CORE card to the company’s OWN domain', async () => {
    const s = makeSupabase({ company: baseCompany })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({ industry: 'Fintech' })

    await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const bodies = fetchMock.mock.calls.map(
      (c) => JSON.parse((c[1] as RequestInit).body as string) as Record<string, unknown>,
    )
    // CORE: own-domain, recipe query unchanged.
    expect(bodies[0].query).toBe('Company profile and information for acme.com')
    expect(bodies[0].includeDomains).toEqual(['acme.com'])
    // DETAILS: open web, funding-shaped query, no domain restriction.
    expect(bodies[1].includeDomains).toBeUndefined()
    expect(bodies[1].query).toContain('funding stage')
    expect(bodies[1].additionalQueries).toEqual([
      '"Acme" acme.com funding investors',
      '"Acme" crunchbase OR linkedin company',
    ])
    // CONTACT: own-domain again — contact details come off the company's own
    // contact page, never the open web.
    expect(bodies[2].includeDomains).toEqual(['acme.com'])
    expect(bodies[2].query).toBe(
      'Contact information for Acme (acme.com): contact email address, phone number, street address, contact page',
    )
    expect(Object.keys((bodies[2].outputSchema as { properties: object }).properties)).toEqual([
      'contactEmail', 'phone', 'streetAddress', 'contactPage',
    ])

    for (const body of bodies) {
      expect(body.category).toBe('company')
      expect(body.type).toBe('deep')
      const schema = body.outputSchema as { properties: Record<string, unknown> }
      expect(Object.keys(schema.properties).length).toBeLessThanOrEqual(10)
      // Never send the filters the company category rejects.
      for (const banned of ['excludeDomains', 'startPublishedDate', 'endPublishedDate']) {
        expect(body).not.toHaveProperty(banned)
      }
    }
    expect(bodies[0].outputSchema).not.toEqual(bodies[1].outputSchema)
  })

  it('builds the DETAILS query from the name CORE resolved, not a placeholder', async () => {
    // The row's name is machine filler; CORE finds the real one.
    const s = makeSupabase({ company: { ...baseCompany, name: 'acme.com' } })
    serviceClientMock.mockReturnValue(s.client)
    mockExaCards(
      { content: { companyName: 'Acme Corporation', industry: 'Fintech' } },
      { content: { fundingStage: 'Series B' } },
    )

    await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

    const details = JSON.parse(
      (fetchMock.mock.calls[1][1] as RequestInit).body as string,
    ) as Record<string, unknown>
    expect(details.query).toContain('Acme Corporation (acme.com)')
    expect(details.additionalQueries).toContain('"Acme Corporation" acme.com funding investors')
  })

  it('falls back to the open web when the company’s own site yields nothing', async () => {
    const s = makeSupabase({ company: baseCompany })
    serviceClientMock.mockReturnValue(s.client)
    // 1) own-domain CORE: empty. 2) open-web CORE. 3) DETAILS.
    fetchMock.mockResolvedValueOnce(exaResponse({ content: {}, results: [] }))
    mockExaCards(
      { content: { industry: 'Fintech' } },
      { content: { fundingStage: 'Series B' } },
    )

    await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

    // own-domain CORE, open-web CORE, DETAILS, CONTACT.
    expect(fetchMock).toHaveBeenCalledTimes(4)
    const bodies = fetchMock.mock.calls.map(
      (c) => JSON.parse((c[1] as RequestInit).body as string) as Record<string, unknown>,
    )
    expect(bodies[0].includeDomains).toEqual(['acme.com'])
    // The retry drops the restriction but keeps the same query.
    expect(bodies[1].includeDomains).toBeUndefined()
    expect(bodies[1].query).toBe('Company profile and information for acme.com')
    expect(bodies[1].outputSchema).toEqual(bodies[0].outputSchema)
  })

  it('runs the open-web CORE directly for a name-only row', async () => {
    const s = makeSupabase({ company: { ...baseCompany, domain: null } })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({ industry: 'Fintech' })

    await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

    // No CONTACT card without a domain: there is nothing to anchor it to.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const bodies = fetchMock.mock.calls.map(
      (c) => JSON.parse((c[1] as RequestInit).body as string) as Record<string, unknown>,
    )
    expect(bodies[0].includeDomains).toBeUndefined()
    expect(bodies[0].query).toBe('Company profile and information for Acme')
    // No domain to parenthesize, and only the one additional query.
    expect(bodies[1].query).toContain('Acme company profile:')
    expect(bodies[1].additionalQueries).toEqual(['"Acme" crunchbase OR linkedin company'])
  })

  /*
   * CONTACT CARD. Email, phone and postal address off the company's own
   * contact page fill the contact_email / phone / address columns; the
   * contact page URL stays blob-only. Each column has a shape gate so Exa's
   * wrapping ("Email: …", "Tel: …") and prose non-answers never get stored.
   */
  it('writes email, phone and address from the CONTACT card, normalised', async () => {
    const s = makeSupabase({ company: baseCompany })
    serviceClientMock.mockReturnValue(s.client)
    mockExaCards(
      { content: { industry: 'Fintech' } },
      { content: { fundingStage: 'Series B' } },
      {
        content: {
          contactEmail: 'Email: Hello@Acme.com (general enquiries)',
          phone: 'Tel: +1 (415) 555-0100',
          streetAddress: '1 Market St, San Francisco, CA 94105, US',
          contactPage: 'https://acme.com/contact',
        },
      },
    )

    const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

    expect(out.status).toBe('enriched')
    const patch = s.updates[0].patch
    expect(patch.contact_email).toBe('hello@acme.com')
    expect(patch.phone).toBe('+1 (415) 555-0100')
    expect(patch.address).toBe('1 Market St, San Francisco, CA 94105, US')
    expect(out.applied.sort()).toEqual(['address', 'contact_email', 'industry', 'phone'])

    const blob = (patch.metadata as Record<string, unknown>).enrichment as EnrichmentBlob
    const fields = blob.fields as Record<string, { value: string }>
    expect(fields.contact_page.value).toBe('https://acme.com/contact')
    // The blob keeps the raw wording; only the column is normalised.
    expect(fields.contact_email.value).toBe('Email: Hello@Acme.com (general enquiries)')
  })

  it('drops contact values that are not an email or a phone number', async () => {
    const s = makeSupabase({ company: baseCompany })
    serviceClientMock.mockReturnValue(s.client)
    mockExaCards(
      { content: { industry: 'Fintech' } },
      { content: {} },
      { content: { contactEmail: 'via the website contact form', phone: 'Not explicitly listed' } },
    )

    const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

    expect(out.status).toBe('enriched')
    expect(out.applied).toEqual(['industry'])
    const patch = s.updates[0].patch
    expect(patch.contact_email).toBeUndefined()
    expect(patch.phone).toBeUndefined()
  })

  it('survives a failed CONTACT card — CORE and DETAILS still land', async () => {
    const s = makeSupabase({ company: baseCompany })
    serviceClientMock.mockReturnValue(s.client)
    mockExaCards({ content: { industry: 'Fintech' } }, { content: { fundingStage: 'Series B' } })
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'))

    const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(out.status).toBe('enriched')
    expect(out.applied).toEqual(['industry'])
    const blob = (s.updates[0].patch.metadata as Record<string, unknown>).enrichment as EnrichmentBlob
    expect((blob.fields as Record<string, unknown>).funding_stage).toBeTruthy()
  })

  it('falls back to the name when the row has no domain', async () => {
    const s = makeSupabase({ company: { ...baseCompany, domain: null } })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({ industry: 'Fintech' })

    await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.query).toBe('Company profile and information for Acme')
  })

  it('maps an off-enum employee count onto a valid bucket', async () => {
    const s = makeSupabase({ company: baseCompany })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({ employeeCount: 'approximately 250 employees' })

    await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })
    expect(s.updates[0].patch.employee_count_range).toBe('201-500')
  })

  it('drops an unmappable employee count rather than writing it', async () => {
    const s = makeSupabase({ company: baseCompany })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({ employeeCount: 'a handful of folks' })

    const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

    expect(out.applied).not.toContain('employee_count_range')
    expect(s.updates[0].patch.employee_count_range).toBeUndefined()
    // The raw value still reaches the blob for a human to read.
    const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
      .enrichment as EnrichmentBlob
    expect(blob.fields.employee_count).toMatchObject({ value: 'a handful of folks' })
  })

  it('records the normalized band in the blob alongside the raw headcount', async () => {
    const s = makeSupabase({ company: { ...baseCompany, employee_count_range: '11-50' } })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({ employeeCount: '250' })

    const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

    // The column was already populated, so nothing was written…
    expect(out.applied).toEqual([])
    // …but the UI can still show the band Exa reported.
    const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
      .enrichment as EnrichmentBlob
    expect(blob.fields.employee_count_range).toMatchObject({ value: '201-500' })
  })

  it('routes the column-less rich fields (funding, stage, people, news) to the blob only', async () => {
    const s = makeSupabase({ company: baseCompany })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({
      latestFunding: 'Series B, $40M, led by Foo Ventures',
      fundingStage: 'Series B',
      totalFundingRaised: '$55M',
      investors: 'Foo Ventures, Bar Capital',
      companyStage: 'Growth',
      ownership: 'VC-backed private',
      foundedYear: '2019',
      keyPeople: 'Jane Doe (CEO), John Roe (CTO)',
      productsAndServices: 'Payments API',
      targetCustomers: 'Mid-market fintechs',
      recentNews: 'Launched Acme Pay in August.',
      linkedinUrl: 'https://linkedin.com/company/acme',
      twitterUrl: 'https://x.com/acme',
    })

    const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

    expect(out.applied).toEqual([])
    const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
      .enrichment as EnrichmentBlob
    for (const key of [
      'latest_funding', 'funding_stage', 'total_funding_raised', 'investors',
      'company_stage', 'ownership', 'founded_year', 'key_people',
      'products_and_services', 'target_customers', 'recent_news',
      'linkedin_url', 'twitter_url',
    ]) {
      expect(blob.fields[key], key).toBeTruthy()
    }
  })

  it('merges the CORE and DETAILS cards into one write', async () => {
    const s = makeSupabase({ company: baseCompany })
    serviceClientMock.mockReturnValue(s.client)
    // CORE comes off the own domain (anchored by construction). DETAILS is
    // open web, so its citations must carry the company name to keep
    // confidence — here a Crunchbase profile page does exactly that.
    fetchMock.mockResolvedValueOnce(
      exaResponse({
        content: { industry: 'Fintech', description: 'Payments infra.' },
        grounding: [
          { field: 'industry', urls: ['https://acme.com'], confidence: 'high' },
          { field: 'description', urls: ['https://acme.com/about'], confidence: 'high' },
        ],
      }),
    )
    fetchMock.mockResolvedValueOnce(
      exaResponse({
        content: { fundingStage: 'Series B', headquartersCity: 'San Francisco' },
        grounding: [
          { field: 'fundingStage', urls: ['https://crunchbase.com/acme'], confidence: 'high' },
          { field: 'headquartersCity', urls: ['https://crunchbase.com/acme'], confidence: 'high' },
        ],
        title: 'Acme - Crunchbase Company Profile',
      }),
    )

    const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

    // Columns come from both cards (city lives on DETAILS).
    expect(out.applied.sort()).toEqual(['city', 'description', 'industry'])
    expect(s.updates[0].patch.city).toBe('San Francisco')
    const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
      .enrichment as EnrichmentBlob
    expect(blob.fields.funding_stage).toMatchObject({ value: 'Series B' })
    // No company `summary` field any more — the blob falls back to description.
    expect(blob.summary).toBe('Payments infra.')
  })

  /*
   * Two data-quality guards, both from the first live DEV run.
   */
  describe('data quality', () => {
    it('never writes an Exa placeholder into a column, even at medium confidence', async () => {
      const s = makeSupabase({ company: baseCompany })
      serviceClientMock.mockReturnValue(s.client)
      fetchMock.mockResolvedValue(
        exaResponse({
          content: {
            annualRevenue: 'Not publicly disclosed',
            employeeCount: 'Not available',
            industry: 'Fintech',
          },
          grounding: [
            { field: 'annualRevenue', confidence: 'medium' },
            { field: 'employeeCount', confidence: 'medium' },
            { field: 'industry', confidence: 'high' },
          ],
        }),
      )

      const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

      // The exact prod bug: annual_revenue_range was written with the string
      // "Not publicly disclosed".
      expect(out.applied).toEqual(['industry'])
      const patch = s.updates[0].patch
      expect(patch.annual_revenue_range).toBeUndefined()
      expect(patch.employee_count_range).toBeUndefined()
      // An absence is not a fact, so it is not in the blob either.
      const blob = (patch.metadata as Record<string, unknown>).enrichment as EnrichmentBlob
      expect(blob.fields.annual_revenue).toBeUndefined()
      expect(blob.fields.employee_count).toBeUndefined()
      expect(blob.fields.industry).toBeTruthy()
    })

    it('demotes a look-alike-domain citation so it cannot fill a column', async () => {
      const s = makeSupabase({ company: { ...baseCompany, name: 'Dial8', domain: 'dial8.ai' } })
      serviceClientMock.mockReturnValue(s.client)
      fetchMock.mockResolvedValue(
        exaResponse({
          content: {
            productsAndServices: 'Dialzy Studio, DIALZY XL',
            industry: 'AI meeting capture',
          },
          grounding: [
            // The observed failure: a DIFFERENT company, cited at HIGH.
            { field: 'productsAndServices', urls: ['https://dialzy.ai/products'], confidence: 'high' },
            { field: 'industry', urls: ['https://dial8.ai/about'], confidence: 'high' },
          ],
        }),
      )

      const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

      // Only the field cited to the company's OWN site reached a column.
      expect(out.applied).toEqual(['industry'])
      const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
        .enrichment as EnrichmentBlob
      // Demoted, not dropped — visible to a human, with its real source.
      expect(blob.fields.products_and_services).toMatchObject({
        value: 'Dialzy Studio, DIALZY XL',
        source_url: 'https://dialzy.ai/products',
        source_title: 'T',
        confidence: 'low',
      })
      expect(blob.fields.industry).toMatchObject({ confidence: 'high' })
    })

    it('demotes a look-alike description so it cannot overwrite an empty column', async () => {
      const s = makeSupabase({ company: { ...baseCompany, name: 'Dial8', domain: 'dial8.ai' } })
      serviceClientMock.mockReturnValue(s.client)
      fetchMock.mockResolvedValue(
        exaResponse({
          content: { description: 'DIAL is an enterprise AI gateway.' },
          grounding: [{ field: 'description', urls: ['https://dialova.ca'], confidence: 'high' }],
        }),
      )

      const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

      expect(out.applied).toEqual([])
      expect(s.updates[0].patch.description).toBeUndefined()
    })

    /*
     * THE COCKTAIL BAR. The live dial8.ai run that produced "dial8 is a
     * cocktail bar at Number Nine, Hotel Varenne" — industry Hospitality at
     * HIGH confidence, cited to hotelvarenne.com. Two of four runs did this.
     * Nothing here can be tied to dial8.ai, so the correct outcome is an
     * EMPTY enrichment, not another business's card.
     */
    it('writes an EMPTY enrichment rather than storing a different business', async () => {
      const s = makeSupabase({
        company: { ...baseCompany, name: 'Dial8', domain: 'dial8.ai' },
      })
      serviceClientMock.mockReturnValue(s.client)

      // 1) own-domain CORE finds nothing (the real run's site was unindexed).
      fetchMock.mockResolvedValueOnce(exaResponse({ content: {}, results: [] }))
      // 2) open-web CORE returns the BAR, confidently, cited to the hotel.
      fetchMock.mockResolvedValueOnce(
        exaResponse({
          content: {
            industry: 'Hospitality',
            description: 'dial8 is a cocktail bar at Number Nine, Hotel Varenne.',
            companyName: 'dial8',
          },
          grounding: [
            { field: 'industry', urls: ['https://hotelvarenne.com/dial8'], confidence: 'high' },
            { field: 'description', urls: ['https://hotelvarenne.com/dial8'], confidence: 'high' },
            { field: 'companyName', urls: ['https://hotelvarenne.com/dial8'], confidence: 'high' },
          ],
          title: 'Hotel Varenne',
          results: [{ url: 'https://hotelvarenne.com/dial8', title: 'Hotel Varenne' }],
        }),
      )
      // 3) DETAILS pulls in the look-alike family.
      fetchMock.mockResolvedValueOnce(
        exaResponse({
          content: { productsAndServices: 'Dialzy Studio, DIALZY XL' },
          grounding: [
            { field: 'productsAndServices', urls: ['https://dialzy.ai'], confidence: 'high' },
          ],
          title: 'DIALZY',
          results: [{ url: 'https://dialzy.ai', title: 'DIALZY' }],
        }),
      )

      const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

      // Terminal and successful — but ZERO columns written.
      expect(out).toEqual({ status: 'enriched', applied: [] })
      const patch = s.updates[0].patch
      expect(patch.industry).toBeUndefined()
      expect(patch.description).toBeUndefined()
      expect(patch.name).toBeUndefined()
      expect(patch.enrichment_status).toBe('enriched')

      const blob = (patch.metadata as Record<string, unknown>).enrichment as EnrichmentBlob
      // No fields and no summary: the UI renders the empty-enrichment path.
      expect(blob.fields).toEqual({})
      expect(blob.summary).toBeNull()
      expect(blob.applied_fields).toEqual([])
      // The sources ARE kept, so a human can see what was found and judge.
      expect(blob.sources.map((x) => x.url)).toEqual([
        'https://hotelvarenne.com/dial8',
        'https://dialzy.ai',
      ])
      // Cost covers every call Exa answered: the discarded own-domain CORE
      // (empty, replaced by its open-web fallback) bills like the two that
      // were merged, so it counts too.
      expect(blob.search_cost_dollars).toBeCloseTo(0.0375)
    })

    it('an own-domain CORE is trusted WITHOUT the relevance gate', async () => {
      // A company's own pages are often untitled or titled just "About", which
      // the title test would reject — but includeDomains already proved they
      // are the right company, so the gate must not run over them.
      const s = makeSupabase({
        company: { ...baseCompany, name: 'Dial8', domain: 'dial8.ai' },
      })
      serviceClientMock.mockReturnValue(s.client)
      fetchMock.mockResolvedValueOnce(
        exaResponse({
          content: { industry: 'AI meeting capture', description: 'Meeting capture and CRM.' },
          grounding: [
            { field: 'industry', urls: ['https://dial8.ai/about'], confidence: 'high' },
            { field: 'description', urls: ['https://dial8.ai/'], confidence: 'high' },
          ],
          title: 'About',
        }),
      )
      mockExaCards({ content: {} })

      const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

      expect(out.applied.sort()).toEqual(['description', 'industry'])
    })

    it('keeps an open-web field whose citation TITLE carries the company name', async () => {
      const s = makeSupabase({
        company: { ...baseCompany, name: 'Dial8', domain: 'dial8.ai' },
      })
      serviceClientMock.mockReturnValue(s.client)
      fetchMock.mockResolvedValueOnce(exaResponse({ content: {}, results: [] }))
      fetchMock.mockResolvedValueOnce(
        exaResponse({
          content: { industry: 'AI meeting capture' },
          grounding: [
            {
              field: 'industry',
              urls: ['https://www.crunchbase.com/organization/dial8'],
              confidence: 'high',
            },
          ],
          title: 'Dial8 - Crunchbase Company Profile',
        }),
      )
      mockExaCards({ content: {} })

      const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })
      expect(out.applied).toEqual(['industry'])
    })

    it('leaves a Crunchbase-cited field alone', async () => {
      const s = makeSupabase({ company: { ...baseCompany, name: 'Dial8', domain: 'dial8.ai' } })
      serviceClientMock.mockReturnValue(s.client)
      fetchMock.mockResolvedValue(
        exaResponse({
          content: { industry: 'Fintech' },
          grounding: [
            {
              field: 'industry',
              urls: ['https://www.crunchbase.com/organization/dial8'],
              confidence: 'high',
            },
          ],
        }),
      )

      const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })
      expect(out.applied).toEqual(['industry'])
    })
  })

  it('replaces a placeholder company name (the domain) with the real one', async () => {
    const s = makeSupabase({ company: { ...baseCompany, name: 'acme.com' } })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({ companyName: 'Acme Corporation' })

    const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

    expect(out.applied).toContain('name')
    expect(s.updates[0].patch.name).toBe('Acme Corporation')
  })

  it('NEVER overwrites a real company name', async () => {
    const s = makeSupabase({ company: baseCompany })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({ companyName: 'Acme Corporation' })

    const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

    expect(out.applied).not.toContain('name')
    expect(s.updates[0].patch.name).toBeUndefined()
  })

  it('never applies a low-confidence name, even over a placeholder', async () => {
    const s = makeSupabase({ company: { ...baseCompany, name: 'acme.com' } })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({ companyName: 'Acme Corporation' }, 'low')

    const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })
    expect(out.applied).not.toContain('name')
  })

  it('skips a company with neither name nor domain', async () => {
    const s = makeSupabase({ company: { ...baseCompany, name: null, domain: null } })
    serviceClientMock.mockReturnValue(s.client)

    const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

    expect(out).toMatchObject({ status: 'skipped', reason: 'insufficient_identity_signal' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(s.updates[0].patch.enrichment_status).toBe('skipped')
  })

  it('refuses a permanently-failed company', async () => {
    const s = makeSupabase({
      company: { ...baseCompany, metadata: { enrichment: { permanent: true } } },
    })
    serviceClientMock.mockReturnValue(s.client)

    const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

    expect(out).toMatchObject({ status: 'skipped', reason: 'permanent_failure' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(s.updates).toHaveLength(0)
  })

  it('marks failed when Exa returns nothing at all', async () => {
    const s = makeSupabase({ company: baseCompany })
    serviceClientMock.mockReturnValue(s.client)
    fetchMock.mockResolvedValue(exaResponse({ content: {}, results: [] }))

    const out = await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

    expect(out).toMatchObject({ status: 'failed', error: 'no_search_results' })
    expect(s.updates[0].patch.enrichment_status).toBe('failed')
  })

  it('names the search stage and its budget on a company timeout', async () => {
    const s = makeSupabase({ company: baseCompany })
    serviceClientMock.mockReturnValue(s.client)
    mockExaThrows(new DOMException('The operation was aborted.', 'TimeoutError'))

    await expect(
      enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' }),
    ).rejects.toThrow()

    const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
      .enrichment as EnrichmentBlob
    expect(blob.error).toBe('search stage timed out after 60000ms (upstream returned nothing)')
    expect(blob.permanent).toBeUndefined()
  })

  it('records the engine on the blob, not a model slug', async () => {
    const s = makeSupabase({ company: baseCompany })
    serviceClientMock.mockReturnValue(s.client)
    mockExa({ industry: 'Fintech' })

    await enrichCompany({ companyId: 'co1', workspaceId: 'w1', userId: 'u1' })

    const blob = (s.updates[0].patch.metadata as Record<string, unknown>)
      .enrichment as EnrichmentBlob
    expect(blob.model).toBe(ENRICHMENT_ENGINE)
    expect(blob.model).toBe('exa/deep-search')
  })
})


describe('resolveLinkedInShortLink', () => {
  it('passes a full profile URL (or nothing) straight through without fetching', async () => {
    const f = vi.fn()
    expect(await resolveLinkedInShortLink('https://www.linkedin.com/in/justdevin/', f)).toBe('https://www.linkedin.com/in/justdevin/')
    expect(await resolveLinkedInShortLink('   ', f)).toBeNull()
    expect(await resolveLinkedInShortLink(null, f)).toBeNull()
    expect(await resolveLinkedInShortLink('not a url', f)).toBe('not a url')
    expect(f).not.toHaveBeenCalled()
  })

  it('follows a lnkd.in redirect to the profile', async () => {
    const f = vi.fn(async () => ({ url: 'https://www.linkedin.com/in/justdevin/' }) as Response)
    expect(await resolveLinkedInShortLink('https://lnkd.in/xQ7kV2pL', f)).toBe('https://www.linkedin.com/in/justdevin/')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('unwraps LinkedIn’s authwall bounce', async () => {
    const f = vi.fn(async () => ({
      url: 'https://www.linkedin.com/authwall?trk=x&sessionRedirect=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fjustdevin%2F',
    }) as Response)
    expect(await resolveLinkedInShortLink('https://lnkd.in/xQ7kV2pL', f)).toBe('https://www.linkedin.com/in/justdevin/')
  })

  it('returns the short link itself when resolution fails', async () => {
    const f = vi.fn(async () => { throw new Error('ECONNRESET') })
    expect(await resolveLinkedInShortLink('https://lnkd.in/xQ7kV2pL', f)).toBe('https://lnkd.in/xQ7kV2pL')
  })
})
