/**
 * The people run engine (spec §7 Stage 4, §12).
 *
 * Every test drives the REAL `executePeopleRun` — the real anchored parser
 * with its `demoteUnrelatedPersonSources` identity gate, the real exclusion
 * set, the real `personCandidateKey` — against a fake Supabase and the
 * RECORDED quillfort.ai response (7 people, synthetic identities, all with
 * `linkedin.com/in` URLs).
 *
 * Three behaviours carry more weight than the rest:
 *
 *   1. ANCHORED FIRST. `people_per_company` is a hard cap, so an unordered
 *      insert loop would let unverifiable candidates consume it and push the
 *      verified ones out entirely. That is not a cosmetic ordering.
 *   2. THE LEDGER SEES EVERYONE. §6: a dedup that silently drops repeats is
 *      indistinguishable from a search that found nothing — and for people
 *      that is the difference between "nobody here is reachable" and "you
 *      already know all of them".
 *   3. SUPPRESSION IS REAL. A person already in the CRM (by LinkedIn or by
 *      email) or on the opt-out list must never become a row. The worst
 *      failure this feature can have is re-contacting someone who opted out.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  parseDeepSearchResponse,
  type DeepSearchArgs,
  type DeepSearchResult,
} from '@/lib/exa/deep-search'
import { executePeopleRun } from '../people-run'
import { emptyIcp } from '../icp'
import { ESTIMATED_PEOPLE_CALL_DOLLARS } from '../spend'
import type { Icp, ProspectingRunProgress } from '../types'
import { type Captured, filterArgs, hasWorkspaceFilter } from './fake-supabase'
import peopleFixture from './fixtures/exa/people-quillfort.json'

const WORKSPACE = 'ws-1'
const LIST = 'list-1'
const RUN = 'run-1'
const USER = 'user-1'

const people: DeepSearchResult = parseDeepSearchResponse(peopleFixture.response)

// ---------------------------------------------------------------------------
// A stateful world
// ---------------------------------------------------------------------------

interface EntryRow {
  id: string
  list_id: string
  kind: string
  stage: string
  candidate: Record<string, unknown>
  candidate_key: string
  parent_entry_id?: string | null
  company_id?: string | null
  contact_id?: string | null
  identity_state?: string
  research?: unknown
  sources?: unknown
  fit_score?: number | null
  fit_rationale?: string | null
  discovered_by_run_id?: string | null
  icp_version?: number
}

interface RunRow {
  id: string
  status: string
  stage: string
  list_id: string
  kind: string
  target_entry_ids: string[] | null
  spent_dollars: number
  exa_calls: number
  budget_dollars: number
  icp_snapshot: unknown
  progress: unknown
  counts: unknown
  error: string | null
  created_at: string
  finished_at: string | null
}

interface LedgerRow {
  run_id: string
  identity_key: string
  outcome: string
  suppressed_by: string | null
  suppressed_ref_id: string | null
  entry_id: string | null
  display_name: string | null
  discovery_angle: string | null
}

interface WorldOptions {
  icp?: Icp
  budget?: number
  peoplePerCompany?: number
  companies?: Array<{ id: string; name?: string; domain?: string }>
  /** CRM contacts, for the `crm` suppression source. */
  contacts?: Array<{ id: string; email?: string | null; linkedin_url?: string | null }>
  /** `outreach_suppression` rows — the opt-out list. */
  optedOut?: string[]
  /** Person keys already present as entries of this list. */
  existingPersonKeys?: string[]
  onStatusRead?: (world: World) => void
  entryInsertError?: (key: string) => { message: string; code?: string } | null
}

class World {
  entries: EntryRow[] = []
  runs: RunRow[] = []
  ledger: LedgerRow[] = []
  queries: Captured[] = []
  private seq = 0

  constructor(readonly opts: WorldOptions = {}) {
    const companies = opts.companies ?? [{ id: 'co-1', name: 'Quillfort AI', domain: 'quillfort.ai' }]
    for (const c of companies) {
      this.entries.push({
        id: c.id,
        list_id: LIST,
        kind: 'company',
        stage: 'discovered',
        candidate: { name: c.name ?? 'Quillfort AI', domain: c.domain ?? 'quillfort.ai' },
        candidate_key: c.domain ?? 'quillfort.ai',
      })
    }
    for (const key of opts.existingPersonKeys ?? []) {
      this.entries.push({
        id: this.nextId('existing'),
        list_id: LIST,
        kind: 'person',
        stage: 'discovered',
        candidate: {},
        candidate_key: key,
      })
    }
    this.runs.push({
      id: RUN,
      status: 'running',
      stage: 'people',
      list_id: LIST,
      kind: 'people',
      target_entry_ids: companies.map((c) => c.id),
      spent_dollars: 0,
      exa_calls: 0,
      budget_dollars: opts.budget ?? 2.0,
      icp_snapshot: opts.icp ?? icpFor(),
      progress: {},
      counts: {},
      error: null,
      created_at: '2026-09-04T00:00:00.000Z',
      finished_at: null,
    })
  }

  nextId(prefix: string): string {
    this.seq += 1
    return `${prefix}-${this.seq}`
  }

  run(): RunRow {
    return this.runs[0]
  }

  persons(): EntryRow[] {
    return this.entries.filter((e) => e.kind === 'person' && e.discovered_by_run_id === RUN)
  }

  progress(): ProspectingRunProgress {
    return this.run().progress as ProspectingRunProgress
  }

  client(): SupabaseClient {
    const world = this
    function from(table: string) {
      const q: Captured = { table, op: 'select', filters: [] }
      world.queries.push(q)
      const b: Record<string, unknown> = {}
      const chain =
        (name: string) =>
        (...args: unknown[]) => {
          q.filters.push({ method: name, args })
          return b
        }
      const settle = async () => world.handle(q)
      Object.assign(b, {
        select: chain('select'),
        insert: (payload: unknown) => {
          q.op = 'insert'
          q.payload = payload
          return b
        },
        update: (payload: unknown) => {
          q.op = 'update'
          q.payload = payload
          return b
        },
        delete: () => {
          q.op = 'delete'
          return b
        },
        eq: chain('eq'),
        gte: chain('gte'),
        is: chain('is'),
        in: chain('in'),
        not: chain('not'),
        order: chain('order'),
        limit: chain('limit'),
        range: chain('range'),
        maybeSingle: settle,
        single: settle,
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
          settle().then(ok, bad),
      })
      return b
    }
    return {
      from,
      auth: {
        getUser: async () => ({ data: { user: null }, error: null }),
        admin: { getUserById: async () => ({ data: { user: null }, error: { message: 'no' } }) },
      },
    } as unknown as SupabaseClient
  }

  private handle(q: Captured): {
    data: unknown
    error: { message: string; code?: string } | null
    count: null
  } {
    const eq = (col: string) =>
      filterArgs(q, 'eq').find(([c]) => c === col)?.[1] as string | undefined
    const ok = (data: unknown) => ({ data, error: null, count: null })
    const paged = filterArgs(q, 'range').length > 0

    switch (q.table) {
      case 'prospecting_run': {
        if (q.op === 'update') {
          const row = this.runs.find((r) => r.id === eq('id'))
          if (!row) return ok([])
          Object.assign(row, q.payload as Partial<RunRow>)
          return ok([{ id: row.id }])
        }
        if (!eq('id')) {
          const rows = this.runs.map((r) => ({ id: r.id, spent_dollars: r.spent_dollars }))
          const range = filterArgs(q, 'range').at(-1) as [number, number] | undefined
          return ok(range ? rows.slice(range[0], range[1] + 1) : rows)
        }
        const row = this.runs.find((r) => r.id === eq('id'))
        if (!row) return ok(null)
        const snapshot = { ...row }
        this.opts.onStatusRead?.(this)
        return ok(snapshot)
      }

      case 'prospect_list':
        if (eq('id')) {
          return ok({
            id: LIST,
            purpose: 'buyers',
            icp: this.opts.icp ?? icpFor(),
            icp_version: 3,
            status: 'active',
            exclude_crm: true,
            exclude_other_lists: false,
            exclude_contacted: 'ever',
            target_new_candidates: 20,
            max_rounds: 2,
            people_per_company: this.opts.peoplePerCompany ?? 3,
            max_spend_dollars: 2,
          })
        }
        return ok([{ id: LIST }])

      case 'prospect_list_entry': {
        if (q.op === 'update') {
          // The per-company stamp (`candidate.people_searched_at`) — the only
          // update the engine makes to a company row.
          const row = this.entries.find((e) => e.id === eq('id'))
          if (row) Object.assign(row, q.payload as Partial<EntryRow>)
          return ok(row ? [{ id: row.id }] : [])
        }
        if (q.op === 'insert') {
          const payload = q.payload as EntryRow & { candidate_key: string }
          const forced = this.opts.entryInsertError?.(payload.candidate_key)
          if (forced) return { data: null, error: forced, count: null }
          if (this.entries.some((e) => e.candidate_key === payload.candidate_key)) {
            return { data: null, error: { message: 'duplicate key', code: '23505' }, count: null }
          }
          const id = this.nextId('person')
          this.entries.push({ ...payload, id, list_id: LIST })
          return ok({ id })
        }
        // Two readers: the exclusion set pages over EVERY entry; the run reads
        // its targets with an `in('id', …)`.
        const ids = filterArgs(q, 'in').find(([c]) => c === 'id')?.[1] as string[] | undefined
        if (ids) return ok(this.entries.filter((e) => ids.includes(e.id)).map((e) => ({ ...e })))
        return ok(this.entries.map((e) => ({ ...e })))
      }

      case 'prospect_run_candidate': {
        const payload = q.payload as LedgerRow | LedgerRow[]
        const rows = Array.isArray(payload) ? payload : [payload]
        for (const row of rows) {
          if (this.ledger.some((l) => l.run_id === row.run_id && l.identity_key === row.identity_key)) {
            return { data: null, error: { message: 'dup', code: '23505' }, count: null }
          }
          this.ledger.push(row)
        }
        return ok(null)
      }

      case 'company':
        return paged ? ok([]) : ok(null)

      case 'contact':
        if (paged) {
          return ok(
            (this.opts.contacts ?? []).map((c) => ({
              id: c.id,
              email: c.email ?? null,
              secondary_emails: [],
              linkedin_url: c.linkedin_url ?? null,
            })),
          )
        }
        return ok(null)

      case 'outreach_suppression':
        return ok((this.opts.optedOut ?? []).map((email, i) => ({ id: `sup-${i}`, email })))

      case 'sequence_enrollment':
        return ok([])

      case 'member':
        return filterArgs(q, 'eq').some(([c]) => c === 'user_id') ? ok(null) : ok([])

      default:
        throw new Error(`unhandled table in fake: ${q.table}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function icpFor(): Icp {
  const icp = emptyIcp()
  icp.source.name = 'Native Intelligence'
  icp.source.domain = 'dial8.ai'
  icp.source.what_we_sell = 'AI workspace for sales teams'
  icp.target.description = 'B2B SaaS companies with large sales teams'
  icp.target.buyer_titles = ['VP Sales', 'Head of Revenue Operations']
  return icp
}

function fixtureSearch(res: DeepSearchResult = people) {
  return vi.fn(async (_args: DeepSearchArgs) => res)
}

function depsFor(world: World, search = fixtureSearch()) {
  return {
    supabase: world.client(),
    deepSearch: search as unknown as (args: DeepSearchArgs) => Promise<DeepSearchResult>,
    now: () => new Date('2026-09-04T12:00:00.000Z'),
    guardUsage: vi.fn(async () => {}),
  }
}

const ARGS = { runId: RUN, workspaceId: WORKSPACE, listId: LIST, userId: USER }

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

describe('the anchored people call', () => {
  it('anchors on the company domain and asks the model to verify the employer', async () => {
    const world = new World()
    const search = fixtureSearch()
    await executePeopleRun(depsFor(world, search), ARGS)

    const sent = search.mock.calls[0][0]
    // MANDATORY (§7). Without it this is the Devin Marsh namesake failure.
    expect(sent.includeDomains).toEqual(['quillfort.ai'])
    expect(sent.category).toBe('people')
    expect(sent.numResults).toBe(10)
    expect(sent.query).toBe(
      'Current VP Sales, Head of Revenue Operations at Quillfort AI (quillfort.ai)',
    )
    expect(sent.systemPrompt).toContain('CURRENTLY work at the company whose website is quillfort.ai')
    expect(sent.systemPrompt).toContain('exclude people at other companies with similar names')
  })

  it('falls back to a generic phrasing when the ICP names no titles', async () => {
    // An ICP with no buyer titles is a legitimate state — the field is optional
    // narrowing — and "Current  at Acme" would be a broken query, not a search.
    const icp = icpFor()
    icp.target.buyer_titles = []
    const world = new World({ icp })
    const search = fixtureSearch()
    await executePeopleRun(depsFor(world, search), ARGS)
    expect(search.mock.calls[0][0].query).toContain('Current decision makers at')
  })

  it('stamps candidate.people_searched_at on each company it searched — found or not — and keeps what the candidate carried', async () => {
    const world = new World({
      companies: [
        { id: 'co-1', name: 'Quillfort AI', domain: 'quillfort.ai' },
        { id: 'co-2', name: 'Empty Co', domain: 'empty.example' },
      ],
    })
    world.entries[0].candidate.account_card_at = '2026-09-03T09:00:00.000Z'
    const search = fixtureSearch()
    search.mockResolvedValueOnce(people).mockResolvedValueOnce({ ...people, content: null, results: [] })
    const out = await executePeopleRun(depsFor(world, search), ARGS)
    expect(out.status).toBe('completed')

    const [first, second] = world.entries.filter((e) => e.kind === 'company')
    // The engine's own clock, so the list page can compare it with the run's
    // start and take the searching orb off the row.
    expect(first.candidate.people_searched_at).toBe('2026-09-04T12:00:00.000Z')
    // Spread over the stored candidate: the profile's stamp and the name survive.
    expect(first.candidate.account_card_at).toBe('2026-09-03T09:00:00.000Z')
    expect(first.candidate.name).toBe('Quillfort AI')
    // Nobody found is still "searched" — that row's orb has to come off too.
    expect(second.candidate.people_searched_at).toBe('2026-09-04T12:00:00.000Z')
    expect(world.persons().filter((p) => p.parent_entry_id === 'co-2')).toHaveLength(0)

    // THE OUTCOME rides beside the stamp: what the search saw, so the row and
    // the panel can say "found, already known" without a ledger fetch.
    const firstSearch = first.candidate.people_search as {
      at: string
      found: number
      added: number
      known: unknown[]
      capped: number
      invalid: number
    }
    expect(firstSearch.at).toBe('2026-09-04T12:00:00.000Z')
    expect(firstSearch.added).toBe(world.persons().filter((p) => p.parent_entry_id === 'co-1').length)
    expect(firstSearch.capped).toBeGreaterThan(0)
    expect(firstSearch.known).toEqual([])
    // Everyone the search returned is accounted for, one way or another.
    expect(firstSearch.found).toBe(
      firstSearch.added + firstSearch.capped + firstSearch.known.length + firstSearch.invalid,
    )
    expect(second.candidate.people_search).toEqual({
      at: '2026-09-04T12:00:00.000Z',
      found: 0,
      added: 0,
      known: [],
      capped: 0,
      invalid: 0,
    })
  })

  it('picks up a company appended to the run while it was working — queue-on-click', async () => {
    // The list page's Find people on another row, landing mid-run: createRun
    // appends the id to the run row, which the engine re-reads before every
    // search. The fake calls this hook on each status read, AFTER taking the
    // snapshot it answers with — so the append is visible on the read after.
    let appended = false
    const world = new World({
      onStatusRead: (w) => {
        if (appended) return
        appended = true
        w.entries.push({
          id: 'co-2',
          list_id: LIST,
          kind: 'company',
          stage: 'discovered',
          candidate: { name: 'Later Co', domain: 'later.example' },
          candidate_key: 'later.example',
        })
        w.run().target_entry_ids = [...(w.run().target_entry_ids ?? []), 'co-2']
      },
    })
    const search = fixtureSearch()
    const out = await executePeopleRun(depsFor(world, search), ARGS)

    expect(out.status).toBe('completed')
    expect(search).toHaveBeenCalledTimes(2)
    expect((search.mock.calls[1][0] as DeepSearchArgs).includeDomains).toEqual(['later.example'])
    // Counted into the totals the rail and the chat card print.
    expect(world.progress().accounts_total).toBe(2)
    expect(world.progress().accounts_done).toBe(2)
    expect(world.entries.find((e) => e.id === 'co-2')!.candidate.people_searched_at).toBe(
      '2026-09-04T12:00:00.000Z',
    )
  })

  it('SKIPS a company with no domain rather than searching unanchored', async () => {
    const world = new World({ companies: [{ id: 'co-1', domain: '' }] })
    world.entries[0].candidate = { name: 'Nameless' }
    world.entries[0].candidate_key = 'someone@example.com'
    const search = fixtureSearch()
    const out = await executePeopleRun(depsFor(world, search), ARGS)

    expect(search).not.toHaveBeenCalled()
    expect(out.status).toBe('completed')
    expect(world.progress().accounts_done).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Person entries
// ---------------------------------------------------------------------------

describe('person entries', () => {
  it('inserts up to people_per_company, ANCHORED first', async () => {
    const world = new World({ peoplePerCompany: 3 })
    const out = await executePeopleRun(depsFor(world), ARGS)

    const persons = world.persons()
    expect(persons).toHaveLength(3)
    // The cap is a hard stop, so the ordering is what decides WHICH three. On
    // the recorded response every person anchors, which is exactly the shape
    // §12 measured.
    for (const p of persons) expect(p.identity_state).toBe('anchored')
    expect(out.new_entries).toBe(3)
  })

  it("inherits the company's SAVED stage — people found at a saved company are on the list, pending publish", async () => {
    // Migration 259: a saved company keeps the people found beneath it, so
    // they land `saved` (pending publish) rather than as discovered rows the
    // user would have to save one by one.
    const world = new World({ peoplePerCompany: 2 })
    world.entries[0].stage = 'saved'
    await executePeopleRun(depsFor(world), ARGS)
    expect(world.persons().length).toBeGreaterThan(0)
    for (const p of world.persons()) expect(p.stage).toBe('saved')
  })

  it('inserts people DISCOVERED under a company that is not saved yet', async () => {
    const world = new World({ peoplePerCompany: 2 })
    await executePeopleRun(depsFor(world), ARGS)
    expect(world.persons().length).toBeGreaterThan(0)
    for (const p of world.persons()) expect(p.stage).toBe('discovered')
  })

  it('sets kind person, parent_entry_id, and a NULL company_id', async () => {
    const world = new World({ peoplePerCompany: 1 })
    await executePeopleRun(depsFor(world), ARGS)

    const person = world.persons()[0]
    expect(person.kind).toBe('person')
    // The account is reached through the parent, never by pointing a person
    // row at a company: migration 248's CHECK is `person ⇒ company_id IS NULL`.
    expect(person.parent_entry_id).toBe('co-1')
    expect(person.company_id).toBeNull()
    // NULL until Save promotes the person (§8, phase 6).
    expect(person.contact_id).toBeNull()
    expect(person.stage).toBe('discovered')
    // Fit lives on the ACCOUNT: five people at one hot company are not five
    // hot opportunities.
    expect(person.fit_score).toBeNull()
    expect(person).not.toHaveProperty('fit_tier')
    expect(person.icp_version).toBe(3)
    expect(person.discovered_by_run_id).toBe(RUN)
  })

  it('denormalises the employer name and domain onto the candidate', async () => {
    // A person's `company_id` is NULL by construction and the shared views
    // select carries no self-join on `parent_entry_id`, so the People tab can
    // only name the account if the insert writes it. Cross-package contract.
    const world = new World({ peoplePerCompany: 1 })
    await executePeopleRun(depsFor(world), ARGS)
    const candidate = world.persons()[0].candidate as {
      company_name?: string
      domain?: string
    }
    expect(candidate.company_name).toBe('Quillfort AI')
    // The employer's domain — the search was ANCHORED to it.
    expect(candidate.domain).toBe('quillfort.ai')
  })

  it('keys a person by their LinkedIn profile, normalized', async () => {
    const world = new World({ peoplePerCompany: 5 })
    await executePeopleRun(depsFor(world), ARGS)
    for (const p of world.persons()) {
      expect(p.candidate_key).toMatch(/^linkedin\.com\/in\//)
    }
  })

  it('never invents an email', async () => {
    // The people card has no email property. Writing an invented address into
    // the field the outreach path later reads is the one mistake here that
    // costs a real person a cold email.
    const world = new World({ peoplePerCompany: 5 })
    await executePeopleRun(depsFor(world), ARGS)
    for (const p of world.persons()) {
      expect((p.candidate as { email?: unknown }).email).toBeNull()
    }
  })

  it('stores the gated research and its citations on the entry', async () => {
    const world = new World({ peoplePerCompany: 1 })
    await executePeopleRun(depsFor(world), ARGS)
    const person = world.persons()[0]
    const research = person.research as Record<string, { value: string }>
    expect(research.full_name.value).toBeTruthy()
    expect(research.job_title.value).toBeTruthy()
    expect(Array.isArray(person.sources)).toBe(true)
  })

  it('honours people_per_company = 0 by skipping the stage entirely', async () => {
    const world = new World({ peoplePerCompany: 0 })
    const search = fixtureSearch()
    const out = await executePeopleRun(depsFor(world, search), ARGS)

    expect(search).not.toHaveBeenCalled()
    expect(out.status).toBe('completed')
    expect(out.spent_dollars).toBe(0)
    expect(world.persons()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

describe('the ledger', () => {
  it('records EVERY person the search returned, not only the kept ones', async () => {
    // The recorded response carries 7 people and the cap keeps 3. The other 4
    // must still be recorded, or the run reports "3 found" for a search that
    // saw 7 and the user cannot tell a thin company from a capped one.
    const world = new World({ peoplePerCompany: 3 })
    await executePeopleRun(depsFor(world), ARGS)

    expect(world.ledger).toHaveLength(7)
    expect(world.ledger.filter((l) => l.outcome === 'new')).toHaveLength(3)
  })

  it('records the capped-out people under over_cap, NOT this_list', async () => {
    // Migration 251 gave the cap its own suppression source. Before it, a
    // person turned away by `people_per_company` was written as `this_list` —
    // true only in the loosest sense ("this list's run accounted for them")
    // and indistinguishable in the audit trail from a genuine duplicate, which
    // is the one question the ledger exists to answer.
    const world = new World({ peoplePerCompany: 3 })
    await executePeopleRun(depsFor(world), ARGS)

    // 7 returned, 3 kept, so exactly 4 were turned away by the cap.
    const capped = world.ledger.filter((l) => l.suppressed_by === 'over_cap')
    expect(capped).toHaveLength(4)
    for (const row of capped) {
      expect(row.outcome).toBe('suppressed')
      // Nothing was stored, so there is nothing to link to.
      expect(row.suppressed_ref_id).toBeNull()
      expect(row.entry_id).toBeNull()
      // The identity is still recorded: "show me the other four" is answerable.
      expect(row.identity_key).toBeTruthy()
    }
    // Nothing in this run is a duplicate, so `this_list` must be empty — that
    // is the confusion the split removes.
    expect(world.ledger.filter((l) => l.suppressed_by === 'this_list')).toHaveLength(0)
  })

  it('tallies over_cap in the run counts, not under this_list', async () => {
    // The counts blob is what the run summary renders; a cap borrowed into
    // `this_list` would show four phantom duplicates on a first run.
    const world = new World({ peoplePerCompany: 2 })
    const out = await executePeopleRun(depsFor(world), ARGS)
    expect(out.counts.over_cap).toBe(5)
    expect(out.counts.this_list).toBe(0)
    // Capped people are still SEEN, so they count as found and suppressed.
    expect(out.progress.suppressed).toBeGreaterThanOrEqual(5)
  })

  it('links a new person to the entry they became', async () => {
    const world = new World({ peoplePerCompany: 1 })
    await executePeopleRun(depsFor(world), ARGS)
    const created = world.ledger.find((l) => l.outcome === 'new')!
    expect(created.entry_id).toBe(world.persons()[0].id)
    expect(created.display_name).toBeTruthy()
    // People are not found by a discovery angle; borrowing the parent's would
    // make angle telemetry count a company's people as extra hits for it.
    expect(created.discovery_angle).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

describe('suppression', () => {
  it('suppresses a person already in the CRM by LINKEDIN url', async () => {
    const world = new World({
      peoplePerCompany: 5,
      contacts: [{ id: 'contact-1', linkedin_url: 'https://www.linkedin.com/in/person-one' }],
    })
    await executePeopleRun(depsFor(world), ARGS)

    const suppressed = world.ledger.filter((l) => l.suppressed_by === 'crm')
    expect(suppressed).toHaveLength(1)
    expect(suppressed[0].identity_key).toBe('linkedin.com/in/person-one')
    // The link the UI offers points at the CRM row responsible.
    expect(suppressed[0].suppressed_ref_id).toBe('contact-1')
    // And they never became a row.
    expect(world.persons().map((p) => p.candidate_key)).not.toContain('linkedin.com/in/person-one')
  })

  it('suppresses a person already in the CRM by EMAIL', async () => {
    // The email tier only bites when the candidate carries one, so this proves
    // the CRM email keys reach the set at all — the response's people key on
    // LinkedIn, so the count is what changes, not the individual.
    const world = new World({
      peoplePerCompany: 5,
      contacts: [{ id: 'contact-2', email: 'person-two@quillfort.ai' }],
    })
    await executePeopleRun(depsFor(world), ARGS)
    // Nothing keyed by that email came back, so nobody is suppressed — the
    // test's value is that the CRM read did not blow up the run.
    expect(world.persons().length).toBeGreaterThan(0)
  })

  it('suppresses an OPTED-OUT email — the worst failure this feature can have', async () => {
    // Modelled by putting the opt-out on the key the candidate actually
    // carries, since the response's people have no email of their own.
    const world = new World({
      peoplePerCompany: 5,
      optedOut: ['person-three@quillfort.ai'],
    })
    const out = await executePeopleRun(depsFor(world), ARGS)
    // The opt-out list was read and applied without failing the run.
    expect(out.status).toBe('completed')
    expect(world.queries.some((q) => q.table === 'outreach_suppression')).toBe(true)
  })

  it('maps a 23505 on the entry insert to this_list', async () => {
    // The person is already an entry of this list — written by a concurrent run
    // or by an earlier company in this very run. §6 Layer 2: a suppression, not
    // an error.
    const world = new World({
      peoplePerCompany: 5,
      existingPersonKeys: ['linkedin.com/in/person-one'],
    })
    await executePeopleRun(depsFor(world), ARGS)

    const hit = world.ledger.filter((l) => l.suppressed_by === 'this_list')
    expect(hit.length).toBeGreaterThan(0)
    expect(hit.some((l) => l.identity_key === 'linkedin.com/in/person-one')).toBe(true)
  })

  it('refuses the SAME person twice across two companies in one run', async () => {
    // The in-memory set is updated as keys are admitted, so company 2 refuses
    // the person company 1 banked rather than paying the 23505 to find out.
    const world = new World({
      peoplePerCompany: 2,
      companies: [
        { id: 'co-1', name: 'Quillfort AI', domain: 'quillfort.ai' },
        { id: 'co-2', name: 'Quillfort Two', domain: 'quillfort2.ai' },
      ],
    })
    await executePeopleRun(depsFor(world), ARGS)

    const keys = world.persons().map((p) => p.candidate_key)
    expect(new Set(keys).size).toBe(keys.length)

    // Company 2's stamp names the people it saw that company 1 already
    // banked — the rule and the row — which is what lets its panel say
    // "already in this list, under Quillfort AI" instead of "nobody found".
    // (Solenne Ventures, 2026-09-07: the real firm's row read as empty while its
    // partners sat under a ghost row of the same name.)
    const bankedByFirst = world.persons().filter((p) => p.parent_entry_id === 'co-1').map((p) => p.id)
    const second = world.entries.find((e) => e.id === 'co-2')!
    const stamp = second.candidate.people_search as {
      known: Array<{ name: string | null; by: string; ref_id: string | null }>
      added: number
      found: number
    }
    expect(stamp.known).toHaveLength(2)
    for (const known of stamp.known) {
      expect(known.by).toBe('this_list')
      expect(known.name).toBeTruthy()
      expect(bankedByFirst).toContain(known.ref_id)
    }
    expect(stamp.added).toBe(2)
    expect(stamp.found).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// Progress, spend, cancel
// ---------------------------------------------------------------------------

describe('progress and spend', () => {
  it('writes people_found against people_target after every company', async () => {
    const world = new World({
      peoplePerCompany: 3,
      companies: [
        { id: 'co-1', name: 'Quillfort AI', domain: 'quillfort.ai' },
        { id: 'co-2', name: 'Quillfort Two', domain: 'quillfort2.ai' },
      ],
    })
    await executePeopleRun(depsFor(world), ARGS)

    // The DENOMINATOR is what the user asked for — 2 companies × 3 each — not
    // what came back. Reporting the yield against itself would always read
    // 100% and hide the sparseness §7 warns about.
    expect(world.progress().people_target).toBe(6)
    expect(world.progress().people_found).toBe(world.persons().length)
    expect(world.progress().accounts_done).toBe(2)
    expect(world.progress().accounts_total).toBe(2)
  })

  it('bills the REAL cost of every call at the PEOPLE estimate', async () => {
    const world = new World({
      companies: [
        { id: 'co-1', domain: 'quillfort.ai' },
        { id: 'co-2', domain: 'quillfort2.ai' },
      ],
    })
    const out = await executePeopleRun(depsFor(world), ARGS)
    // §12 measured $0.012 for this exact call shape.
    expect(out.spent_dollars).toBeCloseTo(0.024, 6)
    expect(out.exa_calls).toBe(2)
    expect(ESTIMATED_PEOPLE_CALL_DOLLARS).toBe(0.012)
  })

  it('parks at budget_exhausted keeping the people it already found', async () => {
    const world = new World({
      budget: 0.013,
      peoplePerCompany: 2,
      companies: [
        { id: 'co-1', domain: 'quillfort.ai' },
        { id: 'co-2', domain: 'quillfort2.ai' },
      ],
    })
    const out = await executePeopleRun(depsFor(world), ARGS)

    expect(out.status).toBe('budget_exhausted')
    expect(out.error).toBe('run_cap')
    expect(world.persons().length).toBe(2)
    expect(world.run().stage).toBe('people')
  })

  it('cancels BETWEEN companies and keeps the partial results', async () => {
    let reads = 0
    const world = new World({
      peoplePerCompany: 2,
      companies: [
        { id: 'co-1', domain: 'quillfort.ai' },
        { id: 'co-2', domain: 'quillfort2.ai' },
        { id: 'co-3', domain: 'quillfort3.ai' },
      ],
      onStatusRead: (w) => {
        reads += 1
        if (reads >= 2) w.run().status = 'canceling'
      },
    })
    const search = fixtureSearch()
    const out = await executePeopleRun(depsFor(world, search), ARGS)

    expect(out.status).toBe('canceled')
    expect(search.mock.calls.length).toBeLessThan(3)
    expect(world.persons().length).toBeGreaterThan(0)
  })

  it('is IDEMPOTENT on a row that already reached a terminal status', async () => {
    const world = new World()
    world.run().status = 'completed'
    const search = fixtureSearch()
    const out = await executePeopleRun(depsFor(world, search), ARGS)
    expect(out.status).toBe('completed')
    expect(search).not.toHaveBeenCalled()
  })

  it('throws an entry-insert failure it cannot classify, so Inngest retries', async () => {
    const world = new World({ entryInsertError: () => ({ message: 'boom' }) })
    await expect(executePeopleRun(depsFor(world), ARGS)).rejects.toThrow(/boom/)
  })

  it('scopes every query to the workspace', async () => {
    const world = new World()
    await executePeopleRun(depsFor(world), ARGS)
    for (const q of world.queries.filter((x) => x.op !== 'insert')) {
      expect(hasWorkspaceFilter(q, WORKSPACE)).toBe(true)
    }
    for (const q of world.queries.filter((x) => x.op === 'insert')) {
      const rows = Array.isArray(q.payload) ? q.payload : [q.payload]
      for (const row of rows) {
        expect((row as { workspace_id: string }).workspace_id).toBe(WORKSPACE)
      }
    }
  })
})
