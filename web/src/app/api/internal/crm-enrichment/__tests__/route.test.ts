/**
 * Route tests for POST /api/internal/crm-enrichment — the onboarding agent's
 * enrichment trust boundary.
 *
 * Load-bearing invariants:
 *   1. AUTH: 401 without the shared secret, and with a wrong one.
 *   2. TENANCY: 403 when the (userId, workspaceId) pair has no member row, or
 *      its member row has no research run in progress for the session the body
 *      names (`running` with that session, or the kickoff's fresh `starting`
 *      claim before the id lands) — the body's ids are claims, never authority.
 *   3. COMPANY: the row is ensured, the caller's self-contact is linked, and
 *      enrichCompany runs against the PRINCIPAL workspace.
 *   4. SELF-CONTACT: enrichContact is called with `allowSelf: true` — without
 *      it the pipeline's own guard skips the row as a member self-contact and
 *      the whole onboarding feature silently no-ops.
 *   5. A personal (consumer webmail) domain is refused up front.
 *
 * `@/lib/crm/enrichment` is mocked WHOLESALE: this route's job is auth,
 * tenancy, orchestration and response shape — the pipeline itself is covered by
 * src/lib/crm/__tests__/enrichment.test.ts, and mocking it keeps these tests
 * independent of that file's state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const SECRET = 'test-internal-secret-crm-enrich-0'

// ── Table-backed service-client fake ────────────────────────────────────────
interface Recorded {
  table: string
  op: 'select' | 'insert' | 'update'
  payload?: Record<string, unknown>
  filters: Record<string, unknown>
}

let recorded: Recorded[] = []
/** Per-table read results, keyed `${table}:select` (maybeSingle terminal). */
let reads: Record<string, { data: unknown; error: unknown }> = {}

function makeChain(table: string) {
  const filters: Record<string, unknown> = {}
  const c: Record<string, unknown> = {}
  c.select = () => {
    recorded.push({ table, op: 'select', filters })
    return c
  }
  c.eq = (col: string, val: unknown) => {
    filters[col] = val
    return c
  }
  c.limit = () => c
  c.maybeSingle = async () => reads[`${table}:select`] ?? { data: null, error: null }
  c.update = (payload: Record<string, unknown>) => {
    recorded.push({ table, op: 'update', payload, filters })
    const b: Record<string, unknown> = {
      eq: (col: string, val: unknown) => {
        filters[col] = val
        return b
      },
      then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
    }
    return b
  }
  return c
}

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({ from: (t: string) => makeChain(t) }),
}))

// ── Enrichment pipeline mock ────────────────────────────────────────────────
const enrichCompany = vi.fn(async () => ({ status: 'enriched', applied: ['industry'] }))
const enrichContact = vi.fn(async () => ({ status: 'enriched', applied: ['job_title'] }))
const ensureCompanyForDomain = vi.fn(async () => 'company-1')

vi.mock('@/lib/crm/enrichment', () => ({
  enrichCompany: (...a: unknown[]) => enrichCompany(...(a as [])),
  enrichContact: (...a: unknown[]) => enrichContact(...(a as [])),
  ensureCompanyForDomain: (...a: unknown[]) => ensureCompanyForDomain(...(a as [])),
  // The real pure helpers are trivial and load-bearing for the 400 path, so
  // reimplement just enough here rather than importing the module under test.
  normalizeDomain: (raw: string | null) =>
    raw ? raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '') : null,
  companyDomainFromEmail: (email: string) => {
    const d = email.slice(email.lastIndexOf('@') + 1)
    const personal = new Set(['gmail.com', 'outlook.com', 'yahoo.com', 'icloud.com'])
    return personal.has(d) ? null : d
  },
}))

import { POST } from '@/app/api/internal/crm-enrichment/route'
import { AGENT_RUN_SECRET_HEADER } from '@/lib/agent-run/agent-run-token'

const WS = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const SESSION = 'wrun_research_1'

function req(body: unknown, secret: string | null = SECRET) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (secret != null) headers[AGENT_RUN_SECRET_HEADER] = secret
  return new Request('http://localhost/api/internal/crm-enrichment', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  recorded = []
  reads = {}
  enrichCompany.mockClear()
  enrichContact.mockClear()
  ensureCompanyForDomain.mockClear()
  vi.stubEnv('AGENT_RUN_INTERNAL_SECRET', SECRET)
})

/** An ISO time `ms` ago (negative: ahead). */
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

/** The member's research state; running SESSION unless said otherwise. */
function seedMember(research: Record<string, unknown> | null = { sessionId: SESSION, status: 'running' }) {
  reads['member:select'] = { data: { id: 'member-1', onboarding_progress: research ? { research } : null }, error: null }
}

describe('POST /api/internal/crm-enrichment — auth', () => {
  it('401s without the internal secret', async () => {
    const res = await POST(req({ workspaceId: WS, userId: USER, sessionId: SESSION, target: { kind: 'self_contact' } }, null))
    expect(res.status).toBe(401)
    expect(enrichContact).not.toHaveBeenCalled()
  })

  it('401s with the wrong internal secret', async () => {
    const res = await POST(
      req({ workspaceId: WS, userId: USER, sessionId: SESSION, target: { kind: 'self_contact' } }, 'nope-nope-nope-nope'),
    )
    expect(res.status).toBe(401)
    expect(enrichContact).not.toHaveBeenCalled()
  })
})

describe('POST /api/internal/crm-enrichment — tenancy', () => {
  it('403s when the user is not a member of the workspace', async () => {
    // no member:select seeded → maybeSingle returns null
    const res = await POST(req({ workspaceId: WS, userId: USER, sessionId: SESSION, target: { kind: 'self_contact' } }))
    expect(res.status).toBe(403)
    expect(enrichContact).not.toHaveBeenCalled()
  })

  it('400s on a malformed body', async () => {
    seedMember()
    const res = await POST(req({ workspaceId: 'not-a-uuid', userId: USER, sessionId: SESSION, target: { kind: 'self_contact' } }))
    expect(res.status).toBe(400)
  })

  it('400s a body that names no research session', async () => {
    seedMember()
    const res = await POST(req({ workspaceId: WS, userId: USER, target: { kind: 'self_contact' } }))
    expect(res.status).toBe(400)
    expect(enrichContact).not.toHaveBeenCalled()
  })

  it.each([
    ['another session', { sessionId: 'wrun_someone_else', status: 'running' }],
    ['a finished run', { sessionId: SESSION, status: 'done' }],
    ['a skipped run', { sessionId: SESSION, status: 'skipped' }],
    ['a run that failed to start', { status: 'error', startedAt: ago(1_000) }],
    ['a stale claim (the kickoff died)', { status: 'starting', startedAt: ago(10 * 60_000) }],
    ['a claim with no start time', { status: 'starting' }],
    ['a claim that already names another session', { status: 'starting', sessionId: 'wrun_someone_else', startedAt: ago(1_000) }],
    ['no research at all', null],
  ])('403s for %s, and enriches nothing', async (_label, research) => {
    seedMember(research)
    for (const target of [{ kind: 'self_contact' }, { kind: 'company', domain: 'acme.com' }]) {
      const res = await POST(req({ workspaceId: WS, userId: USER, sessionId: SESSION, target }))
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ error: 'No research run in progress for this session' })
    }
    expect(ensureCompanyForDomain).not.toHaveBeenCalled()
    expect(enrichCompany).not.toHaveBeenCalled()
    expect(enrichContact).not.toHaveBeenCalled()
  })

  it('accepts the kickoff’s fresh `starting` claim before the session id lands (the run’s first step can beat the record)', async () => {
    for (const startedAt of [ago(0), ago(9 * 60_000), ago(-30_000)]) {
      seedMember({ status: 'starting', startedAt, claimNonce: 'nonce-1' })
      reads['contact:select'] = { data: { id: 'contact-1', full_name: 'Jane Doe', metadata: null }, error: null }
      const res = await POST(req({ workspaceId: WS, userId: USER, sessionId: SESSION, target: { kind: 'self_contact' } }))
      expect(res.status).toBe(200)
    }
    expect(enrichContact).toHaveBeenCalledTimes(3)
  })

  it('looks the member up by the body’s workspace and user', async () => {
    seedMember()
    await POST(req({ workspaceId: WS, userId: USER, sessionId: SESSION, target: { kind: 'self_contact' } }))
    const lookup = recorded.find((r) => r.table === 'member' && r.op === 'select')
    expect(lookup?.filters).toMatchObject({ workspace_id: WS, user_id: USER })
  })
})

describe('POST /api/internal/crm-enrichment — company', () => {
  it('ensures the company, links the self-contact, and enriches it', async () => {
    seedMember()
    // one `reads` slot per table: member, then contact (self, unlinked), then company.
    reads['contact:select'] = { data: { id: 'contact-1', company_id: null }, error: null }
    reads['company:select'] = {
      data: {
        id: 'company-1',
        name: 'Acme',
        domain: 'acme.com',
        industry: 'Software',
        description: 'They make things.',
        website: 'https://acme.com',
        employee_count_range: '51-200',
        annual_revenue_range: null,
        city: 'Austin',
        state: 'TX',
        country: 'US',
        metadata: { enrichment: { status: 'enriched', fields: { industry: { value: 'Software' } } } },
      },
      error: null,
    }

    const res = await POST(
      req({ workspaceId: WS, userId: USER, sessionId: SESSION, target: { kind: 'company', domain: 'ACME.com', name: 'Acme' } }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(ensureCompanyForDomain).toHaveBeenCalledWith(
      expect.anything(),
      { workspaceId: WS, domain: 'acme.com', name: 'Acme' },
    )
    expect(enrichCompany).toHaveBeenCalledWith({ companyId: 'company-1', workspaceId: WS, userId: USER })

    // the self-contact was linked, scoped to the principal workspace
    const link = recorded.find((r) => r.table === 'contact' && r.op === 'update')
    expect(link?.payload?.company_id).toBe('company-1')
    expect(link?.filters.workspace_id).toBe(WS)

    expect(body).toMatchObject({
      companyId: 'company-1',
      domain: 'acme.com',
      contactLinked: true,
      outcome: { status: 'enriched' },
      company: { name: 'Acme', industry: 'Software', city: 'Austin' },
      enrichment: { status: 'enriched' },
    })
  })

  it('400s on a personal (consumer webmail) domain', async () => {
    seedMember()
    const res = await POST(
      req({ workspaceId: WS, userId: USER, sessionId: SESSION, target: { kind: 'company', domain: 'gmail.com' } }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'personal_domain' })
    expect(ensureCompanyForDomain).not.toHaveBeenCalled()
    expect(enrichCompany).not.toHaveBeenCalled()
  })

  it('does not overwrite an existing company link on the self-contact', async () => {
    seedMember()
    reads['contact:select'] = { data: { id: 'contact-1', company_id: 'other-co' }, error: null }
    reads['company:select'] = { data: { id: 'company-1', name: 'Acme', metadata: null }, error: null }

    const res = await POST(
      req({ workspaceId: WS, userId: USER, sessionId: SESSION, target: { kind: 'company', domain: 'acme.com' } }),
    )
    const body = await res.json()
    expect(body.contactLinked).toBe(false)
    expect(recorded.find((r) => r.table === 'contact' && r.op === 'update')).toBeUndefined()
    // still enriched — the link is a nicety, the enrichment is the point
    expect(enrichCompany).toHaveBeenCalled()
  })
})

describe('POST /api/internal/crm-enrichment — self_contact', () => {
  it('enriches the member self-contact with allowSelf: true', async () => {
    seedMember()
    reads['contact:select'] = {
      data: {
        id: 'contact-1',
        full_name: 'Jane Doe',
        email: 'jane@acme.com',
        job_title: 'Head of Ops',
        department: 'Operations',
        linkedin_url: 'https://linkedin.com/in/jane',
        company_id: 'company-1',
        notes: 'Runs ops at Acme.',
        metadata: { enrichment: { status: 'enriched', summary: 'Head of Ops at Acme.' } },
      },
      error: null,
    }

    const res = await POST(req({ workspaceId: WS, userId: USER, sessionId: SESSION, target: { kind: 'self_contact' } }))
    expect(res.status).toBe(200)

    // The whole point: without allowSelf the pipeline skips member self-contacts.
    expect(enrichContact).toHaveBeenCalledWith({
      contactId: 'contact-1',
      workspaceId: WS,
      userId: USER,
      allowSelf: true,
    })

    const body = await res.json()
    expect(body).toMatchObject({
      contactId: 'contact-1',
      outcome: { status: 'enriched' },
      contact: { full_name: 'Jane Doe', job_title: 'Head of Ops' },
      enrichment: { summary: 'Head of Ops at Acme.' },
    })
  })

  it('404s when the member has no self-contact', async () => {
    seedMember()
    // contact:select unseeded → null
    const res = await POST(req({ workspaceId: WS, userId: USER, sessionId: SESSION, target: { kind: 'self_contact' } }))
    expect(res.status).toBe(404)
    expect(enrichContact).not.toHaveBeenCalled()
  })
})
