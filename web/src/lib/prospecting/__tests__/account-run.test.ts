/**
 * The account-card run engine (spec §7 Stage 3b, §12).
 *
 * Every test drives the REAL `executeAccountCardRun` — the real parser, the
 * real `mergeBlobFields`, the real fit scorer — against a fake Supabase and
 * the RECORDED quoteleaf response. Nothing about the loop is stubbed, because
 * the behaviours worth testing are all emergent from it: what it merges, what
 * it refuses to downgrade, when it stops, and what it bills.
 *
 * The two tests that matter most are the two ways this run can silently damage
 * an entry the user is already looking at:
 *
 *   1. the MERGE. An entry arrives carrying discovery's `research`, and a card
 *      that omits a field — or reports it less confidently — must leave the old
 *      value alone. `mergeBlobFields` is the CRM's own rule, imported rather
 *      than reimplemented, and `a pre-existing field is never downgraded` is
 *      the test that proves the import is wired up.
 *   2. the RE-SCORE. The entry was already tiered, and an anchored card that
 *      happens not to restate the industry must never demote a B to a C under
 *      the user's cursor.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  parseDeepSearchResponse,
  type DeepSearchArgs,
  type DeepSearchResult,
} from '@/lib/exa/deep-search'
import { executeAccountCardRun } from '../account-run'
import { emptyIcp } from '../icp'
import { ESTIMATED_ACCOUNT_CARD_DOLLARS } from '../spend'
import type { Icp, ProspectingRunProgress } from '../types'
import { type Captured, filterArgs, hasWorkspaceFilter } from './fake-supabase'
import cardFixture from './fixtures/exa/account-card-quoteleaf.json'

const WORKSPACE = 'ws-1'
const LIST = 'list-1'
const RUN = 'run-1'
const USER = 'user-1'

const card: DeepSearchResult = parseDeepSearchResponse(cardFixture.response)

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
  research: Record<string, unknown>
  sources: unknown[]
  fit_tier: string | null
  fit_score: number | null
  fit_signals: unknown
  fit_rationale: string | null
  fit_confidence: string | null
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

interface WorldOptions {
  icp?: Icp
  budget?: number
  targets?: string[]
  entries?: Partial<EntryRow>[]
  peoplePerCompany?: number
  /** Called before each `prospecting_run` status read, so a test can flip the
   *  row to `canceling` the way a cancel route would. */
  onStatusRead?: (world: World) => void
  entryUpdateError?: (id: string) => { message: string; code?: string } | null
}

function entry(over: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 'entry-1',
    list_id: LIST,
    kind: 'company',
    stage: 'discovered',
    candidate: { name: 'Quoteleaf', domain: 'quoteleaf.com', found_via: 'synthesized' },
    candidate_key: 'quoteleaf.com',
    research: {},
    sources: [],
    fit_tier: null,
    fit_score: null,
    fit_signals: [],
    fit_rationale: null,
    fit_confidence: null,
    ...over,
  }
}

class World {
  entries: EntryRow[]
  runs: RunRow[] = []
  queries: Captured[] = []

  constructor(readonly opts: WorldOptions = {}) {
    this.entries = (opts.entries ?? [{}]).map((e) => entry(e))
    this.runs.push({
      id: RUN,
      status: 'running',
      stage: 'account_card',
      list_id: LIST,
      kind: 'account_card',
      target_entry_ids: opts.targets ?? this.entries.map((e) => e.id),
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

  run(): RunRow {
    return this.runs[0]
  }

  entryById(id: string): EntryRow | undefined {
    return this.entries.find((e) => e.id === id)
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

    switch (q.table) {
      case 'prospecting_run': {
        if (q.op === 'update') {
          const row = this.runs.find((r) => r.id === eq('id'))
          if (!row) return ok([])
          Object.assign(row, q.payload as Partial<RunRow>)
          return ok([{ id: row.id }])
        }
        // The monthly-spend read: no `id` filter, a `gte` window instead.
        if (!eq('id')) {
          const rows = this.runs.map((r) => ({ id: r.id, spent_dollars: r.spent_dollars }))
          const range = filterArgs(q, 'range').at(-1) as [number, number] | undefined
          return ok(range ? rows.slice(range[0], range[1] + 1) : rows)
        }
        const row = this.runs.find((r) => r.id === eq('id'))
        if (!row) return ok(null)
        // Snapshot BEFORE the hook, so a hook that flips the row models a
        // cancel landing AFTER this read returned.
        const snapshot = { ...row }
        this.opts.onStatusRead?.(this)
        return ok(snapshot)
      }

      case 'prospect_list':
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

      case 'prospect_list_entry': {
        if (q.op === 'update') {
          const id = eq('id')
          const forced = this.opts.entryUpdateError?.(id ?? '')
          if (forced) return { data: null, error: forced, count: null }
          const row = this.entries.find((e) => e.id === id)
          if (row) Object.assign(row, q.payload as Partial<EntryRow>)
          return ok([{ id }])
        }
        const ids = filterArgs(q, 'in').find(([c]) => c === 'id')?.[1] as string[] | undefined
        const rows = this.entries.filter((e) => !ids || ids.includes(e.id))
        return ok(rows.map((e) => ({ ...e })))
      }

      case 'company':
      case 'contact':
      case 'member':
        return ok(null)

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
  icp.target.industries = ['sales']
  icp.target.buyer_titles = ['VP Sales']
  return icp
}

function fixtureSearch(res: DeepSearchResult = card) {
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

/** A blob field, in the shape `entry.research` carries. */
function field(value: string, confidence: 'high' | 'medium' | 'low' = 'high') {
  return { value, source_url: 'https://prior.example/a', source_title: 'Prior', confidence }
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

describe('the anchored card call', () => {
  it('anchors on the company’s OWN domain, with the contract’s query and prompt', async () => {
    const world = new World()
    const search = fixtureSearch()
    await executeAccountCardRun(depsFor(world, search), ARGS)

    expect(search).toHaveBeenCalledTimes(1)
    const sent = search.mock.calls[0][0]
    // `includeDomains` is what makes the card anchored BY CONSTRUCTION, which
    // is why `parseAccountCard` runs no identity gate at all.
    expect(sent.includeDomains).toEqual(['quoteleaf.com'])
    expect(sent.category).toBe('company')
    expect(sent.numResults).toBe(5)
    expect(sent.query).toContain('Company profile of quoteleaf.com')
    expect(sent.query).toContain('headcount')
    expect(sent.query).toContain('key people')
    // The source line is what makes `whyFit` a SALES artefact rather than a
    // generic company summary.
    expect(sent.systemPrompt).toContain('AI workspace for sales teams')
    expect(sent.systemPrompt).toContain('why it would buy')
  })

  it('falls back to the candidate_key when the candidate has no domain', async () => {
    // `candidate_key` IS the normalized domain for a company entry.
    const world = new World({ entries: [{ candidate: { name: 'Quoteleaf' } }] })
    const search = fixtureSearch()
    await executeAccountCardRun(depsFor(world, search), ARGS)
    expect(search.mock.calls[0][0].includeDomains).toEqual(['quoteleaf.com'])
  })

  it('SKIPS a company with no domain rather than searching unanchored', async () => {
    // An unanchored card is the namesake failure `includeDomains` exists to
    // prevent, so the company is counted done and nothing is spent.
    const world = new World({ entries: [{ candidate: {}, candidate_key: 'someone@example.com' }] })
    const search = fixtureSearch()
    const out = await executeAccountCardRun(depsFor(world, search), ARGS)

    expect(search).not.toHaveBeenCalled()
    expect(out.status).toBe('completed')
    expect(out.spent_dollars).toBe(0)
    expect(world.progress().accounts_done).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

describe('research merges ADDITIVELY', () => {
  it('keeps discovery’s fields and adds the card’s', async () => {
    const world = new World({
      entries: [{ research: { one_liner: field('Document automation'), why_match: field('Sells to sales teams') } }],
    })
    await executeAccountCardRun(depsFor(world), ARGS)

    const research = world.entryById('entry-1')!.research as Record<string, { value: string }>
    // Discovery's fields survive — nothing in the card mentions them.
    expect(research.one_liner.value).toBe('Document automation')
    expect(research.why_match.value).toBe('Sells to sales teams')
    // The card's own fields arrive alongside them, snake_cased by
    // `groundedFields` exactly as the CRM blob is.
    expect(research.headquarters.value).toContain('San Francisco')
    expect(research.employee_count.value).toContain('700')
    expect(research.why_fit.value).toContain('Quoteleaf')
  })

  it('a pre-existing field is NEVER downgraded by a less confident card', async () => {
    // THE test. `mergeBlobFields` is imported from `crm/enrichment` precisely
    // so a verified fact cannot be displaced by a weaker new one; if that
    // import were ever replaced with a naive spread, this is what breaks.
    const strong = field('1,200 employees', 'high')
    const world = new World({ entries: [{ research: { employee_count: strong } }] })

    // A card whose employeeCount is grounded LOW.
    const weak = weakenField(card, 'employeeCount')
    await executeAccountCardRun(depsFor(world, fixtureSearch(weak)), ARGS)

    const research = world.entryById('entry-1')!.research as Record<string, { value: string }>
    expect(research.employee_count.value).toBe('1,200 employees')
  })

  it('a MORE confident card does replace the old value', async () => {
    const world = new World({
      entries: [{ research: { headquarters: field('Somewhere', 'low') } }],
    })
    await executeAccountCardRun(depsFor(world), ARGS)
    const research = world.entryById('entry-1')!.research as Record<string, { value: string }>
    expect(research.headquarters.value).toContain('San Francisco')
  })

  it('unions the sources, this run’s citations first and de-duplicated', async () => {
    const prior = { url: 'https://prior.example/a', title: 'Prior', published_date: null }
    const world = new World({ entries: [{ sources: [prior] }] })
    await executeAccountCardRun(depsFor(world), ARGS)

    const sources = world.entryById('entry-1')!.sources as Array<{ url: string }>
    const urls = sources.map((s) => s.url)
    expect(urls).toContain(prior.url)
    expect(new Set(urls).size).toBe(urls.length)
    expect(urls.length).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// candidate.name
// ---------------------------------------------------------------------------

describe('candidate.name', () => {
  it('fills a MISSING name from the merged research', async () => {
    // A candidate harvested purely from a result entity can arrive nameless,
    // and "(no name)" in the list is the most visible symptom of that.
    const world = new World({
      entries: [
        {
          candidate: { domain: 'quoteleaf.com' },
          research: { name: field('Quoteleaf') },
        },
      ],
    })
    await executeAccountCardRun(depsFor(world), ARGS)
    expect((world.entryById('entry-1')!.candidate as { name: string }).name).toBe('Quoteleaf')
  })

  it('never overwrites a name the entry already has', async () => {
    const world = new World({
      entries: [
        {
          candidate: { name: 'Quoteleaf Inc.', domain: 'quoteleaf.com' },
          research: { name: field('Quoteleaf') },
        },
      ],
    })
    await executeAccountCardRun(depsFor(world), ARGS)
    expect((world.entryById('entry-1')!.candidate as { name: string }).name).toBe('Quoteleaf Inc.')
  })
})

// ---------------------------------------------------------------------------
// The stamp
// ---------------------------------------------------------------------------

describe('candidate.account_card_at', () => {
  it('stamps the entry when the card completes', async () => {
    const world = new World()
    await executeAccountCardRun(depsFor(world), ARGS)
    const candidate = world.entryById('entry-1')!.candidate as { account_card_at?: string }
    expect(candidate.account_card_at).toBe('2026-09-04T12:00:00.000Z')
  })

  it('stamps EVEN WHEN the card extracted nothing', async () => {
    // The whole reason the stamp is unconditional. A company that cost money
    // and yielded nothing must still leave the research queue, or the gate
    // re-offers it at full price forever.
    const empty = parseDeepSearchResponse({
      requestId: 'req-empty',
      output: { content: {}, grounding: [] },
      results: [],
      costDollars: ESTIMATED_ACCOUNT_CARD_DOLLARS,
    })
    const world = new World()
    await executeAccountCardRun(depsFor(world, fixtureSearch(empty)), ARGS)
    const candidate = world.entryById('entry-1')!.candidate as { account_card_at?: string }
    expect(candidate.account_card_at).toBe('2026-09-04T12:00:00.000Z')
  })

  it('keeps every other candidate field, and still fills a missing name', async () => {
    // The stamp rides on `candidate`, and the write replaces that jsonb whole —
    // so a stamp that dropped `domain` would break the next run's anchoring and
    // a stamp written INSTEAD of the name fill would undo the "(no name)" fix.
    const world = new World({
      entries: [
        {
          candidate: { domain: 'quoteleaf.com', found_via: 'result_entity' },
          research: { name: field('Quoteleaf') },
        },
      ],
    })
    await executeAccountCardRun(depsFor(world), ARGS)
    expect(world.entryById('entry-1')!.candidate).toMatchObject({
      domain: 'quoteleaf.com',
      found_via: 'result_entity',
      name: 'Quoteleaf',
      account_card_at: '2026-09-04T12:00:00.000Z',
    })
  })
})

// ---------------------------------------------------------------------------
// The re-score
// ---------------------------------------------------------------------------

describe('THE score', () => {
  /** The recorded card, with a `fitScore` the way the model now returns one.
   *  The fixture predates the property, so it is spliced into `content`; no
   *  grounding row means `groundedFields` keeps it at confidence 'low', which
   *  must not matter — the score is read from the card, not gated by
   *  grounding. */
  function cardWithScore(score: unknown): DeepSearchResult {
    return { ...card, content: { ...(card.content ?? {}), fitScore: score } }
  }

  it("writes the card's fitScore to the column — the one scoring call in the pipeline", async () => {
    const world = new World({ entries: [{ fit_score: null, fit_rationale: 'From discovery', research: {} }] })
    await executeAccountCardRun(depsFor(world, fixtureSearch(cardWithScore(87))), ARGS)

    const row = world.entryById('entry-1')!
    expect(row.fit_score).toBe(87)
    // The rationale is the card's own why-fit, replacing discovery's sentence.
    expect(row.fit_rationale).toContain("Quoteleaf's focus on accelerating sales cycles")
  })

  it('REPLACES an earlier score rather than keeping the better one', async () => {
    // A profile that just read the company's own site knows more than anything
    // before it did. There is no "never lower" guard any more — that guard
    // protected a discovery-time tier that no longer exists.
    const world = new World({ entries: [{ fit_score: 95, fit_rationale: 'Old', research: {} }] })
    await executeAccountCardRun(depsFor(world, fixtureSearch(cardWithScore('42'))), ARGS)
    expect(world.entryById('entry-1')!.fit_score).toBe(42)
  })

  it('reads a decorated or fractional fitScore, and leaves NULL for junk', async () => {
    for (const [raw, expected] of [
      ['85/100', 85],
      [0.7, 70],
      ['strong', null],
    ] as const) {
      const world = new World({ entries: [{ fit_score: null, research: {} }] })
      await executeAccountCardRun(depsFor(world, fixtureSearch(cardWithScore(raw))), ARGS)
      expect(world.entryById('entry-1')!.fit_score, String(raw)).toBe(expected)
    }
  })

  it('leaves the score NULL when the card carries no fitScore — never an invented number', async () => {
    const world = new World({ entries: [{ fit_score: null, research: {} }] })
    await executeAccountCardRun(depsFor(world), ARGS)
    const row = world.entryById('entry-1')!
    expect(row.fit_score).toBeNull()
    // But the stamp still lands — the user paid for this card.
    expect((row.candidate as { account_card_at?: string }).account_card_at).toBeTruthy()
    // And the why-fit still becomes the rationale.
    expect(row.fit_rationale).toContain('Quoteleaf')
  })

  it("strips fit_score out of the research blob — it is a column, not a fact", async () => {
    const world = new World({ entries: [{ research: {} }] })
    await executeAccountCardRun(depsFor(world, fixtureSearch(cardWithScore(87))), ARGS)
    const research = world.entryById('entry-1')!.research as Record<string, unknown>
    expect(research).not.toHaveProperty('fit_score')
    // The other card fields still merged in.
    expect(research).toHaveProperty('headquarters')
    expect(research).toHaveProperty('why_fit')
  })

  it("zeroes the score and names the rule when the merged blob hits the ICP's anti term", async () => {
    // The user's own rule outranks the model's number. The fixture's why-fit
    // talks about "accelerating sales cycles"; excluding that phrase fires on
    // the merged blob, whole-word, and the 91 the card returned is discarded.
    const icp = icpFor()
    icp.anti.exclude_keywords = ['sales cycles']
    const world = new World({ icp, entries: [{ research: {} }] })
    await executeAccountCardRun(depsFor(world, fixtureSearch(cardWithScore(91))), ARGS)
    const row = world.entryById('entry-1')!
    expect(row.fit_score).toBe(0)
    expect(row.fit_rationale).toBe('Matches excluded keyword "sales cycles".')
  })

  it('puts the ideal customer and the rating rule in the system prompt', async () => {
    // `fitScore` is judged against the ICP, so the ICP has to reach the model
    // that produces the number — or it is a rating against nothing.
    const world = new World({ entries: [{ research: {} }] })
    const search = fixtureSearch()
    await executeAccountCardRun(depsFor(world, search), ARGS)
    const sent = search.mock.calls[0][0]
    expect(sent.systemPrompt).toContain('Ideal customer: B2B SaaS companies with large sales teams')
    expect(sent.systemPrompt).toContain('Industries: sales')
    expect(sent.systemPrompt).toContain('Buyers: VP Sales')
    expect(sent.systemPrompt).toContain('fitScore is how likely this company is to buy')
    expect(sent.systemPrompt).toContain('85–100 only')
    // No empty criterion rendered as "(none)".
    expect(sent.systemPrompt).not.toMatch(/Geographies:/)
  })
})

// ---------------------------------------------------------------------------
// The budget gate
// ---------------------------------------------------------------------------

describe('the budget gate', () => {
  it('checks the budget BEFORE each call, at the ACCOUNT estimate', async () => {
    // A budget that affords exactly two cards at the recorded $0.012 each.
    const world = new World({
      budget: 0.026,
      entries: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }],
      targets: ['e1', 'e2', 'e3'],
    })
    const search = fixtureSearch()
    const out = await executeAccountCardRun(depsFor(world, search), ARGS)

    // Two calls fit ($0.012 then $0.024); the third's reservation
    // (0.024 + 0.013 = 0.037) does not.
    expect(search).toHaveBeenCalledTimes(2)
    expect(out.status).toBe('budget_exhausted')
    expect(out.error).toBe('run_cap')
    // The estimate is the ACCOUNT one, not discovery's — reserving $0.03 here
    // would park the run a whole card early.
    expect(ESTIMATED_ACCOUNT_CARD_DOLLARS).toBe(0.013)
  })

  it('PARKS with the partial results kept, not discarded', async () => {
    const world = new World({
      budget: 0.014,
      entries: [{ id: 'e1' }, { id: 'e2' }],
      targets: ['e1', 'e2'],
    })
    const out = await executeAccountCardRun(depsFor(world), ARGS)

    expect(out.status).toBe('budget_exhausted')
    // The first company IS enriched and stays that way.
    expect(Object.keys(world.entryById('e1')!.research).length).toBeGreaterThan(0)
    expect(Object.keys(world.entryById('e2')!.research).length).toBe(0)
    expect(world.progress().accounts_done).toBe(1)
    expect(world.progress().accounts_total).toBe(2)
    // The stage says where it actually stopped; only a completed run says done.
    expect(world.run().stage).toBe('account_card')
  })

  it('parks at the MONTHLY ceiling before spending anything', async () => {
    const world = new World()
    world.runs.push({ ...world.run(), id: 'other', spent_dollars: 25 })
    const search = fixtureSearch()
    const out = await executeAccountCardRun(depsFor(world, search), ARGS)

    expect(out.status).toBe('budget_exhausted')
    expect(out.error).toBe('monthly_cap')
    expect(search).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

describe('cancel', () => {
  it('stops BETWEEN companies and keeps what it already enriched', async () => {
    let reads = 0
    const world = new World({
      entries: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }],
      targets: ['e1', 'e2', 'e3'],
      onStatusRead: (w) => {
        reads += 1
        // Flip after the first company's gate read, so the SECOND gate sees it.
        if (reads >= 2) w.run().status = 'canceling'
      },
    })
    const search = fixtureSearch()
    const out = await executeAccountCardRun(depsFor(world, search), ARGS)

    expect(out.status).toBe('canceled')
    // The cancel is checked BEFORE the call, so nothing is billed for the
    // company it stopped on.
    expect(search.mock.calls.length).toBeLessThan(3)
    expect(Object.keys(world.entryById('e1')!.research).length).toBeGreaterThan(0)
    expect(world.run().status).toBe('canceled')
  })

  it('reports cancel rather than budget when both would fire', async () => {
    // A user who pressed Cancel wants the run stopped; telling them it ran out
    // of money would be a lie about why it stopped, so the cancel poll runs
    // FIRST in the per-company gate.
    //
    // Note the ordering this test has to respect: the engine's own "I am
    // running" write lands after preflight and BEFORE the loop (the same shape
    // `run.ts` has, and the same status the wrapper's CAS claim writes), so a
    // cancel that arrived before preflight finished is overwritten and settled
    // by the next gate instead. The hook models the realistic case — a cancel
    // landing once the loop is under way.
    // Budget affords exactly ONE card, so company 2's gate would park at
    // budget_exhausted if the cancel poll did not run first.
    const world = new World({
      budget: 0.013,
      entries: [{ id: 'e1' }, { id: 'e2' }],
      targets: ['e1', 'e2'],
      onStatusRead: (w) => {
        // The fake snapshots the row BEFORE this hook, so setting the status
        // here models a cancel landing after the read it precedes — which is
        // why the SECOND gate read is the one that sees it.
        w.run().status = 'canceling'
      },
    })
    const out = await executeAccountCardRun(depsFor(world), ARGS)
    expect(out.status).toBe('canceled')
    expect(out.error).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Progress, spend and the lifecycle
// ---------------------------------------------------------------------------

describe('progress and spend', () => {
  it('reports accounts_done / accounts_total after EVERY company', async () => {
    const world = new World({ entries: [{ id: 'e1' }, { id: 'e2' }], targets: ['e1', 'e2'] })
    const out = await executeAccountCardRun(depsFor(world), ARGS)

    expect(out.status).toBe('completed')
    expect(world.progress().accounts_total).toBe(2)
    expect(world.progress().accounts_done).toBe(2)
    expect(world.progress().stage).toBe('done')
  })

  it('bills the REAL cost of every call, and counts them', async () => {
    const world = new World({ entries: [{ id: 'e1' }, { id: 'e2' }], targets: ['e1', 'e2'] })
    const out = await executeAccountCardRun(depsFor(world), ARGS)
    // The recorded response reports $0.012.
    expect(out.spent_dollars).toBeCloseTo(0.024, 6)
    expect(out.exa_calls).toBe(2)
    expect(world.run().spent_dollars).toBeCloseTo(0.024, 6)
  })

  it('runs the companies in the ORDER the user selected them', async () => {
    const world = new World({
      entries: [{ id: 'e1', candidate: { domain: 'one.com' } }, { id: 'e2', candidate: { domain: 'two.com' } }],
      targets: ['e2', 'e1'],
    })
    const search = fixtureSearch()
    await executeAccountCardRun(depsFor(world, search), ARGS)
    expect(search.mock.calls.map((c) => c[0].includeDomains?.[0])).toEqual(['two.com', 'one.com'])
  })

  it('completes over an EMPTY selection without billing', async () => {
    // Every selected row vanished between the press and the run. Nothing went
    // wrong, so it is a completed run over zero companies.
    const world = new World({ entries: [], targets: ['gone'] })
    const search = fixtureSearch()
    const out = await executeAccountCardRun(depsFor(world, search), ARGS)
    expect(out.status).toBe('completed')
    expect(search).not.toHaveBeenCalled()
  })

  it('ignores a dismissed or person row that slipped into the selection', async () => {
    const world = new World({
      entries: [
        { id: 'e1' },
        { id: 'e2', stage: 'dismissed' },
        { id: 'e3', kind: 'person', candidate_key: 'linkedin.com/in/x' },
      ],
      targets: ['e1', 'e2', 'e3'],
    })
    const search = fixtureSearch()
    await executeAccountCardRun(depsFor(world, search), ARGS)
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('is IDEMPOTENT on a row that already reached a terminal status', async () => {
    const world = new World()
    world.run().status = 'completed'
    const search = fixtureSearch()
    const out = await executeAccountCardRun(depsFor(world, search), ARGS)
    expect(out.status).toBe('completed')
    expect(search).not.toHaveBeenCalled()
  })

  it('carries a RESUMED run’s earlier spend rather than re-starting at zero', async () => {
    const world = new World({ budget: 2 })
    world.run().spent_dollars = 1.5
    const out = await executeAccountCardRun(depsFor(world), ARGS)
    expect(out.spent_dollars).toBeCloseTo(1.512, 6)
  })

  it('throws a write failure it cannot classify, so Inngest retries', async () => {
    const world = new World({ entryUpdateError: () => ({ message: 'boom' }) })
    await expect(executeAccountCardRun(depsFor(world), ARGS)).rejects.toThrow(/boom/)
  })

  it('scopes every query to the workspace', async () => {
    const world = new World()
    await executeAccountCardRun(depsFor(world), ARGS)
    for (const q of world.queries) {
      expect(hasWorkspaceFilter(q, WORKSPACE)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------

/** The recorded response with one grounded field demoted to `low`, so the
 *  merge's confidence rule has something weaker to refuse. */
function weakenField(res: DeepSearchResult, field: string): DeepSearchResult {
  return {
    ...res,
    grounding: res.grounding.map((g) =>
      g.field === field ? { ...g, confidence: 'low' as const } : g,
    ),
  }
}
