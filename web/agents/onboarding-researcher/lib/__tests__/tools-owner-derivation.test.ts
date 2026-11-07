import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ToolContext } from 'eve/tools'

/**
 * Owner-derivation security tests for the research tools.
 *
 * The invariant under test: every tool derives workspace_id + user_id ONLY from
 * `ctx.session.auth.current` (principalId + attributes.workspaceId), NEVER from
 * model-supplied tool input. We prove this two ways:
 *   1. the workspace_id that reaches the DB equals the PRINCIPAL's, and
 *   2. attacker-controlled ids in the model input do NOT change what's written.
 *
 * We mock the shared service client so we can capture every insert/update.
 */

// ── Recording fake supabase service client ────────────────────────────────
interface Recorded {
  table: string
  op: 'insert' | 'update' | 'upsert' | 'select'
  payload?: Record<string, unknown>
  filters: Record<string, unknown>
}

let recorded: Recorded[]
// Programmable responses keyed by table+op for reads.
let readResponses: Record<string, { data: unknown; error: unknown }>

function makeQuery(table: string) {
  const filters: Record<string, unknown> = {}
  const q: Record<string, unknown> = {}

  const finalizers = {
    maybeSingle: async () => readResponses[`${table}:select`] ?? { data: null, error: null },
    single: async () =>
      readResponses[`${table}:insert-return`] ?? { data: { id: `${table}-id` }, error: null },
  }

  q.select = () => {
    recorded.push({ table, op: 'select', filters })
    return q
  }
  q.eq = (col: string, val: unknown) => {
    filters[col] = val
    return q
  }
  q.in = (col: string, val: unknown) => {
    filters[col] = val
    return q
  }
  q.limit = () => q
  q.maybeSingle = finalizers.maybeSingle
  // List terminal: a select chain awaited directly (no .maybeSingle()), as the
  // seeded-actions probe in finish_research does. Keyed `${table}:list`.
  q.then = (resolve: (v: unknown) => unknown) =>
    resolve(readResponses[`${table}:list`] ?? { data: [], error: null })
  q.insert = (payload: Record<string, unknown>) => {
    recorded.push({ table, op: 'insert', payload, filters })
    return {
      select: () => ({ single: finalizers.single }),
    }
  }
  q.update = (payload: Record<string, unknown>) => {
    recorded.push({ table, op: 'update', payload, filters })
    // Chainable filter builder that terminates in either a bare await (legacy
    // callers) or a `.select()` that returns the affected rows (the CAS path in
    // mergeResearchProgress). Every `.eq()`/`.is()` records its filter and stays
    // chainable regardless of how many are applied.
    const filterBuilder: Record<string, unknown> = {
      eq: (col: string, val: unknown) => {
        filters[col] = val
        return filterBuilder
      },
      is: (col: string, val: unknown) => {
        filters[col] = val
        return filterBuilder
      },
      select: async () => ({ data: [{ user_id: filters.user_id }], error: null }),
      then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
    }
    return filterBuilder
  }
  q.upsert = (payload: Record<string, unknown>) => {
    recorded.push({ table, op: 'upsert', payload, filters })
    return Promise.resolve({ error: null })
  }
  return q
}

const fakeService = {
  from: (table: string) => makeQuery(table),
}

// finish_research's ledger hand-off (Sequence row 6) — the only app-client
// call these tests stub; the enrichment tools keep the real client + a fetch stub.
const researchSettle = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../app-client.js', async () => ({
  ...(await vi.importActual<typeof import('../app-client')>('../app-client')),
  postInternalResearchSettle: researchSettle,
}))

vi.mock('../tool-context.js', async () => {
  const actual = await vi.importActual<typeof import('../tool-context')>(
    '../tool-context'
  )
  return {
    ...actual,
    serviceClient: () => fakeService,
  }
})

import enrichCompany from '../../tools/enrich_company'
import enrichMe from '../../tools/enrich_me'
import { __resetEnrichCallCap } from '../enrich-call-cap'
import saveResearchClaims from '../../tools/save_research_claims'
import finishResearch from '../../tools/finish_research'

// ── ctx builders ───────────────────────────────────────────────────────────
function ctxWith(
  principal:
    | { principalId: string; workspaceId: string; principalType?: string }
    | null
): ToolContext {
  const current =
    principal === null
      ? null
      : {
          authenticator: 'app',
          principalId: principal.principalId,
          principalType: principal.principalType ?? 'user',
          attributes: { workspaceId: principal.workspaceId },
        }
  return {
    session: {
      id: 'sess',
      auth: { current, initiator: current },
      turn: {} as never,
    },
  } as unknown as ToolContext
}

beforeEach(() => {
  recorded = []
  readResponses = {}
  researchSettle.mockReset()
  researchSettle.mockResolvedValue(undefined)
})

const PRINCIPAL = { principalId: 'real-user', workspaceId: 'real-ws' }

/**
 * The enrichment tools do not write via the service client — they POST to the
 * Next app's internal /api/internal/crm-enrichment route, which does the writes.
 * The owner-derivation invariant is therefore asserted on the WIRE: the
 * workspaceId/userId in the request body must be the PRINCIPAL's, and nothing
 * the model puts in the input may change them.
 */
describe('enrich_company / enrich_me — owner derivation reaches the route', () => {
  let sentBodies: Array<Record<string, unknown>>

  beforeEach(() => {
    sentBodies = []
    __resetEnrichCallCap()
    vi.stubEnv('AGENT_RUN_INTERNAL_SECRET', 'test-secret')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        sentBodies.push(JSON.parse(init.body))
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              companyId: 'company-1',
              contactId: 'contact-1',
              outcome: { status: 'enriched', applied: ['industry'] },
              company: { name: 'Acme', domain: 'acme.com' },
              contact: { full_name: 'Jane Doe', job_title: 'Head of Ops' },
              enrichment: {
                fields: { industry: { value: 'Software', confidence: 'high', source_url: 'https://acme.com' } },
                summary: 'Acme makes things.',
                sources: [{ url: 'https://acme.com' }],
                applied_fields: ['industry'],
              },
            }),
        }
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('enrich_company sends the PRINCIPAL tenancy, ignoring attacker ids in input', async () => {
    const res = await enrichCompany.execute!(
      // The schema accepts no workspace/user field at all; passing them anyway
      // proves extra keys are dropped rather than smuggled onto the wire.
      { domain: 'ACME.com', name: 'Acme', workspaceId: 'attacker-ws', userId: 'attacker-user' } as never,
      ctxWith(PRINCIPAL),
    )

    expect((res as { success: boolean }).success).toBe(true)
    expect(sentBodies).toHaveLength(1)
    expect(sentBodies[0]).toEqual({
      workspaceId: 'real-ws',
      userId: 'real-user',
      // the session's own id, which the route checks against the member's running research
      sessionId: 'sess',
      target: { kind: 'company', domain: 'acme.com', name: 'Acme' },
    })
    // and the card came back shaped for the model
    expect(res).toEqual(
      expect.objectContaining({
        companyId: 'company-1',
        found: true,
        summary: 'Acme makes things.',
        appliedColumns: ['industry'],
      }),
    )
  })

  it('enrich_me sends the PRINCIPAL tenancy and takes no subject from input', async () => {
    const res = await enrichMe.execute!(
      { workspaceId: 'attacker-ws', email: 'someone-else@evil.com' } as never,
      ctxWith(PRINCIPAL),
    )

    expect((res as { success: boolean }).success).toBe(true)
    expect(sentBodies[0]).toEqual({
      workspaceId: 'real-ws',
      userId: 'real-user',
      // the session's own id, which the route checks against the member's running research
      sessionId: 'sess',
      target: { kind: 'self_contact' },
    })
    expect(res).toEqual(
      expect.objectContaining({ contactId: 'contact-1', fullName: 'Jane Doe', jobTitle: 'Head of Ops' }),
    )
  })

  it('a 403 from the route (no research run in progress) spends none of the enrich budget; other failures do', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ error: 'No research run in progress for this session' }) }))
    vi.stubGlobal('fetch', fetchMock)
    for (let i = 0; i < 3; i++) {
      expect(await enrichCompany.execute!({ domain: 'acme.com' } as never, ctxWith(PRINCIPAL))).toMatchObject({ success: false })
      expect(await enrichMe.execute!({} as never, ctxWith(PRINCIPAL))).toMatchObject({ success: false })
    }
    // Every refused call reached the route: none was counted against the cap of 2 per kind.
    expect(fetchMock).toHaveBeenCalledTimes(6)

    // A failure past the binding (the search itself erred) still counts.
    fetchMock.mockImplementation(async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ error: 'exa down' }) }))
    for (let i = 0; i < 3; i++) await enrichCompany.execute!({ domain: 'acme.com' } as never, ctxWith(PRINCIPAL))
    expect(fetchMock).toHaveBeenCalledTimes(8)
  })

  it('both reject cleanly (no fetch) when the session has no workspace', async () => {
    const noWs = ctxWith({ principalId: 'u', workspaceId: '' })
    const a = await enrichCompany.execute!({ domain: 'acme.com' }, noWs)
    const b = await enrichMe.execute!({}, noWs)
    expect(a).toEqual(
      expect.objectContaining({ success: false, error: expect.stringMatching(/workspace/i) }),
    )
    expect((b as { success: boolean }).success).toBe(false)
    expect(sentBodies).toHaveLength(0)
  })

  it('rejects cleanly when the caller is not a user principal (localDev path)', async () => {
    const res = await enrichCompany.execute!(
      { domain: 'acme.com' },
      ctxWith({ principalId: 'local', workspaceId: 'x', principalType: 'runtime' }),
    )
    expect((res as { success: boolean }).success).toBe(false)
    expect(sentBodies).toHaveLength(0)
  })

  it('a route failure is RETURNED, never thrown (the turn must survive)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, text: async () => '{"error":"boom"}' })),
    )
    const res = await enrichCompany.execute!({ domain: 'acme.com' }, ctxWith(PRINCIPAL))
    expect(res).toEqual(
      expect.objectContaining({ success: false, error: expect.stringMatching(/boom/) }),
    )
  })
})

describe('save_research_claims — owner derivation', () => {
  it('writes claims scoped to the PRINCIPAL workspace + member, not input', async () => {
    readResponses['member:select'] = { data: { id: 'member-1' }, error: null }
    readResponses['claim:insert-return'] = { data: { id: 'claim-1', text: 't' }, error: null }

    const res = await saveResearchClaims.execute!(
      {
        claims: [
          { text: 'Vercel builds developer tools', type: 'fact', source_url: 'https://vercel.com', excerpt: 'x' },
        ],
      },
      ctxWith(PRINCIPAL)
    )

    expect((res as { success: boolean }).success).toBe(true)
    // claim is now written via upsert(onConflict:'id', ignoreDuplicates) for
    // replay safety, not a bare insert.
    const claimInsert = recorded.find((r) => r.table === 'claim' && r.op === 'upsert')
    expect(claimInsert?.payload?.workspace_id).toBe('real-ws')
    expect(claimInsert?.payload?.confirmation).toBe('suggested')
    expect(claimInsert?.payload?.created_by).toBe('member-1')
    // member was resolved from principal, not input
    const memberSelect = recorded.find((r) => r.table === 'member' && r.op === 'select')
    expect(memberSelect?.filters.workspace_id).toBe('real-ws')
    expect(memberSelect?.filters.user_id).toBe('real-user')
    // provenance was written as external_url with the source uri
    const src = recorded.find((r) => r.table === 'claim_source' && r.op === 'upsert')
    expect(src?.payload?.source_type).toBe('external_url')
    expect(src?.payload?.source_uri).toBe('https://vercel.com')
  })

  it('rejects cleanly (no write) with no workspace', async () => {
    const res = await saveResearchClaims.execute!(
      { claims: [{ text: 'x', type: 'inference', source_url: 'https://y' }] },
      ctxWith({ principalId: 'u', workspaceId: '' })
    )
    expect((res as { success: boolean }).success).toBe(false)
    expect(recorded.filter((r) => r.op === 'insert' || r.op === 'upsert')).toHaveLength(0)
  })
})

describe('finish_research — owner derivation', () => {
  it('persists research state scoped to the PRINCIPAL user + workspace', async () => {
    // finish_research uses mergeResearchProgress → member select + update.
    readResponses['member:select'] = {
      data: {
        onboarding_progress: { research: { sessionId: 's1', startedAt: 'T0' } },
        updated_at: 'v0',
      },
      error: null,
    }
    const res = await finishResearch.execute!(
      { status: 'done', brief: "Here's what I learned", companyFound: true },
      ctxWith(PRINCIPAL)
    )
    expect((res as { success: boolean; persisted: boolean }).persisted).toBe(true)

    const memberSelect = recorded.find((r) => r.table === 'member' && r.op === 'select')
    expect(memberSelect?.filters.user_id).toBe('real-user')
    expect(memberSelect?.filters.workspace_id).toBe('real-ws')

    const memberUpdate = recorded.find((r) => r.table === 'member' && r.op === 'update')
    const written = memberUpdate?.payload?.onboarding_progress as {
      research: Record<string, unknown>
    }
    // deep-merge preserved sessionId/startedAt and added the finish fields
    expect(written.research).toEqual(
      expect.objectContaining({
        sessionId: 's1',
        startedAt: 'T0',
        status: 'done',
        brief: "Here's what I learned",
        companyFound: true,
      }),
    )
    // The Activity row is settled by THIS session's id, from the state just
    // persisted — never before it.
    expect(researchSettle).toHaveBeenCalledTimes(1)
    expect(researchSettle).toHaveBeenCalledWith('sess')
  })

  it('a failed ledger settle is non-fatal: the research is still persisted', async () => {
    readResponses['member:select'] = {
      data: { onboarding_progress: { research: { sessionId: 's1' } }, updated_at: 'v0' },
      error: null,
    }
    researchSettle.mockRejectedValueOnce(new Error('app down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await finishResearch.execute!(
      { status: 'done', brief: 'b', companyFound: true },
      ctxWith(PRINCIPAL)
    )
    expect(res).toEqual(expect.objectContaining({ success: true, persisted: true }))
    expect(warn).toHaveBeenCalledWith('finish_research: ledger settle failed (non-fatal):', expect.any(Error))
    warn.mockRestore()
  })

  it('falls back to the model-passed seededSummary when the DB probe finds no starter project', async () => {
    // projects:select left unset → probe finds nothing → model input stands.
    readResponses['member:select'] = {
      data: {
        onboarding_progress: { research: { sessionId: 's1', startedAt: 'T0' } },
        updated_at: 'v0',
      },
      error: null,
    }
    const res = await finishResearch.execute!(
      {
        status: 'done',
        brief: 'Set you up',
        companyFound: true,
        seededSummary: { projectName: 'Launch the beta', actionCount: 3, workspaceRenamed: 'Vercel' },
      },
      ctxWith(PRINCIPAL),
    )
    expect((res as { persisted: boolean }).persisted).toBe(true)

    const memberUpdate = recorded.find((r) => r.table === 'member' && r.op === 'update')
    const written = memberUpdate?.payload?.onboarding_progress as {
      research: Record<string, unknown>
    }
    expect(written.research.seededSummary).toEqual({
      projectName: 'Launch the beta',
      actionCount: 3,
      workspaceRenamed: 'Vercel',
    })
  })

  it('derives seededSummary from the DB when the model omits it (seeded light run)', async () => {
    // The live-verified bug: a personal-email run seeds starter content but
    // calls finish_research without seededSummary. The DB probe must fill it.
    readResponses['member:select'] = {
      data: {
        onboarding_progress: { research: { sessionId: 's1', startedAt: 'T0' } },
        updated_at: 'v0',
      },
      error: null,
    }
    readResponses['projects:select'] = { data: { name: 'App Launch Week' }, error: null }
    readResponses['actions:list'] = {
      data: [{ id: 'a0' }, { id: 'a1' }, { id: 'a2' }],
      error: null,
    }
    await finishResearch.execute!(
      { status: 'skipped', brief: 'Kept it light, set up a board', companyFound: false },
      ctxWith(PRINCIPAL),
    )
    const memberUpdate = recorded.find((r) => r.table === 'member' && r.op === 'update')
    const written = memberUpdate?.payload?.onboarding_progress as {
      research: Record<string, unknown>
    }
    expect(written.research.seededSummary).toEqual({
      projectName: 'App Launch Week',
      actionCount: 3,
    })
    // The probe is scoped to the PRINCIPAL workspace, like every other read.
    const projSelect = recorded.find((r) => r.table === 'projects' && r.op === 'select')
    expect(projSelect?.filters.workspace_id).toBe('real-ws')
    const actionsSelect = recorded.find((r) => r.table === 'actions' && r.op === 'select')
    expect(actionsSelect?.filters.workspace_id).toBe('real-ws')
  })

  it('prefers DB-derived name/count over the model-passed summary, keeping workspaceRenamed', async () => {
    readResponses['member:select'] = {
      data: {
        onboarding_progress: { research: { sessionId: 's1', startedAt: 'T0' } },
        updated_at: 'v0',
      },
      error: null,
    }
    readResponses['projects:select'] = { data: { name: 'Canonical Name' }, error: null }
    readResponses['actions:list'] = { data: [{ id: 'a0' }, { id: 'a1' }], error: null }
    await finishResearch.execute!(
      {
        status: 'done',
        brief: 'x',
        companyFound: true,
        seededSummary: { projectName: 'Model Said This', actionCount: 9, workspaceRenamed: 'Acme' },
      },
      ctxWith(PRINCIPAL),
    )
    const memberUpdate = recorded.find((r) => r.table === 'member' && r.op === 'update')
    const written = memberUpdate?.payload?.onboarding_progress as {
      research: Record<string, unknown>
    }
    expect(written.research.seededSummary).toEqual({
      projectName: 'Canonical Name',
      actionCount: 2,
      workspaceRenamed: 'Acme',
    })
  })

  it('omits seededSummary from the patch when the run did no seeding', async () => {
    readResponses['member:select'] = {
      data: {
        onboarding_progress: { research: { sessionId: 's1', startedAt: 'T0' } },
        updated_at: 'v0',
      },
      error: null,
    }
    await finishResearch.execute!(
      { status: 'skipped', brief: 'Kept it light', companyFound: false },
      ctxWith(PRINCIPAL),
    )
    const memberUpdate = recorded.find((r) => r.table === 'member' && r.op === 'update')
    const written = memberUpdate?.payload?.onboarding_progress as {
      research: Record<string, unknown>
    }
    // No seeding this run → the key is absent (never written as undefined, which
    // would clobber a prior run's summary).
    expect('seededSummary' in written.research).toBe(false)
  })

  it('returns the brief but marks not-persisted when there is no workspace', async () => {
    const res = await finishResearch.execute!(
      { status: 'skipped', brief: 'Kept it light', companyFound: false },
      ctxWith({ principalId: 'u', workspaceId: '' })
    )
    expect(res).toEqual(
      expect.objectContaining({
        success: false,
        persisted: false,
        brief: 'Kept it light',
      }),
    )
    expect(recorded.filter((r) => r.op === 'update')).toHaveLength(0)
    // Nothing persisted, so there is nothing for the ledger to mirror.
    expect(researchSettle).not.toHaveBeenCalled()
  })
})
