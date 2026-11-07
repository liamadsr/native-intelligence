/**
 * `resolveSourceCompany` — §4's four-step order, each step in isolation.
 *
 * The order is the whole point of this function. Matching on the email domain
 * alone mis-seeds real workspaces, and a WRONG source company silently
 * mis-seeds every ICP in the workspace, so the disagreement cases (flag vs
 * self-contact, self-contact vs email domain) are tested explicitly rather
 * than assumed.
 */
import { describe, it, expect } from 'vitest'
import { establishSourceCompany, resolveSourceCompany, suggestedDomainFor } from '../source-company'
import { makeFakeSupabase, hasWorkspaceFilter, type Captured } from './fake-supabase'

const WS = 'ws-1'
const USER = 'user-1'

const FLAGGED = { id: 'co-flag', workspace_id: WS, name: 'Flagged Co', domain: 'flag.com' }
const LINKED = { id: 'co-self', workspace_id: WS, name: 'Self Co', domain: 'self.com' }
const BY_DOMAIN = { id: 'co-mail', workspace_id: WS, name: 'Acme Corp', domain: 'acme-corp.com' }

/** Which company read a query is: the flag lookup, an id lookup, or a domain
 *  lookup. Mirrors the three `loadCompany` call sites. */
function companyLookupKind(q: Captured): 'flag' | 'id' | 'domain' | null {
  for (const f of q.filters) {
    if (f.method !== 'eq') continue
    const [col] = f.args
    if (col === 'is_workspace_company') return 'flag'
    if (col === 'id') return 'id'
    if (col === 'domain') return 'domain'
  }
  return null
}

interface WorldOpts {
  flagged?: boolean
  memberId?: string | null
  selfContactCompanyId?: string | null
  domainCompany?: boolean
}

function world(opts: WorldOpts) {
  return makeFakeSupabase((q) => {
    if (q.table === 'company') {
      const kind = companyLookupKind(q)
      if (kind === 'flag') return { data: opts.flagged ? FLAGGED : null }
      if (kind === 'id') return { data: opts.selfContactCompanyId ? LINKED : null }
      if (kind === 'domain') return { data: opts.domainCompany ? BY_DOMAIN : null }
      return { data: null }
    }
    if (q.table === 'member') {
      return { data: opts.memberId === null ? null : { id: opts.memberId ?? 'member-1' } }
    }
    if (q.table === 'contact') {
      return { data: { company_id: opts.selfContactCompanyId ?? null } }
    }
    return { data: null }
  })
}

describe('resolveSourceCompany', () => {
  it('step 1: returns the is_workspace_company row and stops there', async () => {
    const { client, queries } = world({ flagged: true, selfContactCompanyId: 'co-self', domainCompany: true })
    const result = await resolveSourceCompany(client, {
      workspaceId: WS,
      userId: USER,
      userEmail: 'ada@acme-corp.com',
    })
    expect(result).toEqual({ company: FLAGGED, resolved_by: 'is_workspace_company' })
    // Nothing after step 1 ran — no member lookup, no second company read.
    expect(queries.filter((q) => q.table === 'member')).toHaveLength(0)
    expect(queries.filter((q) => q.table === 'company')).toHaveLength(1)
  })

  it("step 2: falls to the caller's self-contact company when the flag is unset", async () => {
    const { client } = world({ selfContactCompanyId: 'co-self', domainCompany: true })
    const result = await resolveSourceCompany(client, {
      workspaceId: WS,
      userId: USER,
      userEmail: 'ada@acme-corp.com',
    })
    expect(result).toEqual({ company: LINKED, resolved_by: 'self_contact' })
  })

  it("step 2's self-contact read MIRRORS 248's backfill LATERAL, filter for filter", async () => {
    // 248 picks the self-contact with `ct.company_id IS NOT NULL AND
    // ct.merged_into_contact_id IS NULL ORDER BY ct.created_at, ct.id`. If this
    // read is looser, a member whose self-contact was merged away (or who has a
    // second, company-less one) resolves to null here and falls through to the
    // email-domain step — disagreeing with the flag the backfill already set.
    const { client, queries } = world({ selfContactCompanyId: 'co-self' })
    await resolveSourceCompany(client, { workspaceId: WS, userId: USER })
    const read = queries.find((q) => q.table === 'contact')!
    expect(hasWorkspaceFilter(read, WS)).toBe(true)
    const eqs = read.filters.filter((f) => f.method === 'eq').map((f) => f.args)
    expect(eqs).toContainEqual(['member_id', 'member-1'])
    expect(read.filters).toContainEqual({ method: 'not', args: ['company_id', 'is', null] })
    expect(read.filters).toContainEqual({ method: 'is', args: ['merged_into_contact_id', null] })
    const orders = read.filters.filter((f) => f.method === 'order').map((f) => f.args[0])
    expect(orders).toEqual(['created_at', 'id'])
  })

  it('the flag WINS over a disagreeing self-contact — the ordering bug the backfill exists to avoid', async () => {
    const { client } = world({ flagged: true, selfContactCompanyId: 'co-self' })
    const result = await resolveSourceCompany(client, { workspaceId: WS, userId: USER })
    expect(result.company).toBe(FLAGGED)
  })

  it('the self-contact WINS over a disagreeing email domain', async () => {
    const { client } = world({ selfContactCompanyId: 'co-self', domainCompany: true })
    const result = await resolveSourceCompany(client, {
      workspaceId: WS,
      userId: USER,
      userEmail: 'ada@acme-corp.com',
    })
    expect(result.company).toBe(LINKED)
    expect(result.resolved_by).toBe('self_contact')
  })

  it('step 3: falls to the email-domain company when there is no self-contact link', async () => {
    const { client } = world({ selfContactCompanyId: null, domainCompany: true })
    const result = await resolveSourceCompany(client, {
      workspaceId: WS,
      userId: USER,
      userEmail: 'ada@acme-corp.com',
    })
    expect(result).toEqual({ company: BY_DOMAIN, resolved_by: 'email_domain' })
  })

  it('a personal email domain never reaches step 3 — gmail.com is not a company', async () => {
    const { client, queries } = world({ selfContactCompanyId: null, domainCompany: true })
    const result = await resolveSourceCompany(client, {
      workspaceId: WS,
      userId: USER,
      userEmail: 'ada@gmail.com',
    })
    expect(result).toEqual({ company: null, resolved_by: 'none' })
    expect(queries.filter((q) => q.table === 'company' && companyLookupKind(q) === 'domain')).toHaveLength(0)
  })

  it('step 4: nothing resolves', async () => {
    const { client } = world({ selfContactCompanyId: null })
    const result = await resolveSourceCompany(client, {
      workspaceId: WS,
      userId: USER,
      userEmail: 'ada@acme-corp.com',
    })
    expect(result).toEqual({ company: null, resolved_by: 'none' })
  })

  it('reads the email from the session when the caller passes none', async () => {
    const base = world({ selfContactCompanyId: null, domainCompany: true })
    const { client } = makeFakeSupabase(
      (q) => {
        if (q.table === 'company') {
          return { data: companyLookupKind(q) === 'domain' ? BY_DOMAIN : null }
        }
        if (q.table === 'member') return { data: { id: 'member-1' } }
        if (q.table === 'contact') return { data: { company_id: null } }
        return { data: null }
      },
      { user: { id: USER, email: 'ada@acme-corp.com' } },
    )
    void base
    const result = await resolveSourceCompany(client, { workspaceId: WS, userId: USER })
    expect(result.resolved_by).toBe('email_domain')
  })

  it('a member-lookup error degrades to the next step rather than throwing', async () => {
    const { client } = makeFakeSupabase((q) => {
      if (q.table === 'member') return { data: null, error: { message: 'boom' } }
      if (q.table === 'company') {
        return { data: companyLookupKind(q) === 'domain' ? BY_DOMAIN : null }
      }
      return { data: null }
    })
    const result = await resolveSourceCompany(client, {
      workspaceId: WS,
      userId: USER,
      userEmail: 'ada@acme-corp.com',
    })
    expect(result.resolved_by).toBe('email_domain')
  })

  it('every query carries an explicit workspace_id filter', async () => {
    const { client, queries } = world({ selfContactCompanyId: 'co-self' })
    await resolveSourceCompany(client, { workspaceId: WS, userId: USER, userEmail: 'ada@acme-corp.com' })
    expect(queries.length).toBeGreaterThan(0)
    for (const q of queries) {
      expect(hasWorkspaceFilter(q, WS)).toBe(true)
    }
  })
})

/**
 * `establishSourceCompany` — §4 step 4, the half that did not exist.
 *
 * The production bug this closes: a business-email signup whose workspace had
 * zero company rows saw "We don't know your company yet" and a button that
 * returned 200 with a null source. Step 4 was documented and unimplemented.
 *
 * The invariant the tests are built around is the FLAG ORDER. Migration 248's
 * partial unique index allows exactly one `is_workspace_company` row per
 * workspace, so a set-before-clear (or a clear that also cleared the target)
 * breaks the "Not your company?" re-point — the one path that exists to fix a
 * wrong source company, which otherwise mis-seeds every ICP in the workspace.
 */
describe('establishSourceCompany', () => {
  const NEW_ID = 'co-new'

  interface EstablishOpts {
    /** An existing company row already carrying the domain. */
    existingCompanyId?: string | null
    memberId?: string | null
    /** The caller's self-contact, or null when they have none. */
    selfContact?: { id: string; company_id: string | null } | null
    /** Make the flag-clear update fail. */
    clearError?: boolean
  }

  function establishWorld(opts: EstablishOpts = {}) {
    return makeFakeSupabase((q) => {
      if (q.table === 'company') {
        if (q.op === 'insert') return { data: { id: NEW_ID } }
        if (q.op === 'update') {
          const clearing = q.filters.some((f) => f.method === 'neq')
          if (clearing && opts.clearError) return { data: null, error: { message: 'boom' } }
          return { data: null }
        }
        return { data: opts.existingCompanyId ? { id: opts.existingCompanyId } : null }
      }
      if (q.table === 'member') {
        return { data: opts.memberId === null ? null : { id: opts.memberId ?? 'member-1' } }
      }
      if (q.table === 'contact') {
        if (q.op === 'update') return { data: null }
        return { data: opts.selfContact === undefined ? { id: 'ct-1', company_id: null } : opts.selfContact }
      }
      return { data: null }
    })
  }

  it('creates the company, flags it, and links a company-less self-contact', async () => {
    const { client, queries } = establishWorld()
    const result = await establishSourceCompany(client, {
      workspaceId: WS,
      userId: USER,
      domain: 'dial8.ai',
    })
    expect(result).toEqual({
      ok: true,
      companyId: NEW_ID,
      domain: 'dial8.ai',
      created: true,
      contactLinked: true,
    })

    // Created through ensureCompanyForDomain's insert, with the domain as the
    // NOT NULL name fallback — byte for byte what the onboarding internal
    // route produces for the same signup.
    const insert = queries.find((q) => q.table === 'company' && q.op === 'insert')!
    expect(insert.payload).toEqual({ workspace_id: WS, domain: 'dial8.ai', name: 'dial8.ai' })

    // The self-contact link carries `company_id` and nothing that would clobber
    // other fields.
    const link = queries.find((q) => q.table === 'contact' && q.op === 'update')!
    expect(link.payload).toMatchObject({ company_id: NEW_ID })
    expect(link.filters).toContainEqual({ method: 'eq', args: ['id', 'ct-1'] })
    expect(hasWorkspaceFilter(link, WS)).toBe(true)
  })

  it('normalizes the domain before anything touches the database', async () => {
    const { client, queries } = establishWorld()
    const result = await establishSourceCompany(client, {
      workspaceId: WS,
      userId: USER,
      domain: 'HTTPS://WWW.Dial8.ai/pricing?x=1',
    })
    expect(result).toMatchObject({ ok: true, domain: 'dial8.ai' })
    const insert = queries.find((q) => q.table === 'company' && q.op === 'insert')!
    expect((insert.payload as { domain: string }).domain).toBe('dial8.ai')
  })

  it('CLEARS the old flag before setting the new one, excluding the target row', async () => {
    // 248's partial unique index allows one flagged row per workspace. Setting
    // first collides with the row being re-pointed away from; clearing without
    // the `neq` would clear the row we are about to flag when it is already
    // the flagged one, leaving the workspace with none.
    const { client, queries } = establishWorld({ existingCompanyId: NEW_ID })
    await establishSourceCompany(client, { workspaceId: WS, userId: USER, domain: 'dial8.ai' })

    const updates = queries.filter((q) => q.table === 'company' && q.op === 'update')
    expect(updates).toHaveLength(2)

    const [clear, set] = updates
    expect(clear.payload).toEqual({ is_workspace_company: false })
    expect(clear.filters).toContainEqual({ method: 'eq', args: ['is_workspace_company', true] })
    expect(clear.filters).toContainEqual({ method: 'neq', args: ['id', NEW_ID] })
    expect(hasWorkspaceFilter(clear, WS)).toBe(true)

    expect(set.payload).toEqual({ is_workspace_company: true })
    expect(set.filters).toContainEqual({ method: 'eq', args: ['id', NEW_ID] })
    expect(hasWorkspaceFilter(set, WS)).toBe(true)
  })

  it('adopts an existing row for the domain rather than creating a second one', async () => {
    const { client, queries } = establishWorld({ existingCompanyId: 'co-existing' })
    const result = await establishSourceCompany(client, {
      workspaceId: WS,
      userId: USER,
      domain: 'dial8.ai',
    })
    expect(result).toMatchObject({ ok: true, companyId: 'co-existing', created: false })
    expect(queries.filter((q) => q.table === 'company' && q.op === 'insert')).toHaveLength(0)
  })

  it('never overwrites a self-contact that already has a company', async () => {
    // Mirrors /api/internal/crm-enrichment's handleCompany exactly: an existing
    // link is the user's own truth.
    const { client, queries } = establishWorld({
      selfContact: { id: 'ct-1', company_id: 'co-other' },
    })
    const result = await establishSourceCompany(client, {
      workspaceId: WS,
      userId: USER,
      domain: 'dial8.ai',
    })
    expect(result).toMatchObject({ ok: true, contactLinked: false })
    expect(queries.filter((q) => q.table === 'contact' && q.op === 'update')).toHaveLength(0)
  })

  it('still establishes the company when the caller has no self-contact', async () => {
    const { client } = establishWorld({ selfContact: null })
    const result = await establishSourceCompany(client, {
      workspaceId: WS,
      userId: USER,
      domain: 'dial8.ai',
    })
    expect(result).toMatchObject({ ok: true, companyId: NEW_ID, contactLinked: false })
  })

  it('refuses a webmail domain — gmail.com is nobody company', async () => {
    const { client, queries } = establishWorld()
    const result = await establishSourceCompany(client, {
      workspaceId: WS,
      userId: USER,
      domain: 'gmail.com',
    })
    expect(result).toEqual({
      ok: false,
      code: 'PERSONAL_DOMAIN',
      error: 'That is a personal email provider, not a company website',
    })
    // Refused BEFORE any write.
    expect(queries).toHaveLength(0)
  })

  it('refuses an unparseable domain', async () => {
    const { client, queries } = establishWorld()
    const result = await establishSourceCompany(client, {
      workspaceId: WS,
      userId: USER,
      domain: 'not a domain',
    })
    expect(result).toMatchObject({ ok: false, code: 'INVALID_DOMAIN' })
    expect(queries).toHaveLength(0)
  })

  it('reports CREATE_FAILED rather than pretending it established anything', async () => {
    const { client } = makeFakeSupabase((q) => {
      if (q.table === 'company' && q.op === 'insert') {
        return { data: null, error: { message: 'constraint' } }
      }
      return { data: null }
    })
    const result = await establishSourceCompany(client, {
      workspaceId: WS,
      userId: USER,
      domain: 'dial8.ai',
    })
    expect(result).toMatchObject({ ok: false, code: 'CREATE_FAILED' })
  })

  it('a failed flag-clear does not abort the establish', async () => {
    // The company row and the self-contact link are the durable half; a flag
    // that did not move is recoverable on the next press, and failing the whole
    // call would put the user back at "the button does nothing".
    const { client } = establishWorld({ clearError: true })
    const result = await establishSourceCompany(client, {
      workspaceId: WS,
      userId: USER,
      domain: 'dial8.ai',
    })
    expect(result).toMatchObject({ ok: true, companyId: NEW_ID })
  })

  it('every query carries an explicit workspace_id filter', async () => {
    const { client, queries } = establishWorld()
    await establishSourceCompany(client, { workspaceId: WS, userId: USER, domain: 'dial8.ai' })
    expect(queries.length).toBeGreaterThan(0)
    for (const q of queries) {
      if (q.op === 'insert') {
        expect((q.payload as { workspace_id: string }).workspace_id).toBe(WS)
        continue
      }
      expect(hasWorkspaceFilter(q, WS)).toBe(true)
    }
  })
})

describe('suggestedDomainFor', () => {
  it('returns the company domain of a business address', () => {
    expect(suggestedDomainFor('liam@dial8.ai')).toBe('dial8.ai')
  })

  it('returns null for consumer webmail — the case where we must ASK', () => {
    expect(suggestedDomainFor('me.personal@gmail.com')).toBeNull()
  })

  it('returns null for a missing or malformed address', () => {
    expect(suggestedDomainFor(null)).toBeNull()
    expect(suggestedDomainFor(undefined)).toBeNull()
    expect(suggestedDomainFor('nope')).toBeNull()
  })
})
