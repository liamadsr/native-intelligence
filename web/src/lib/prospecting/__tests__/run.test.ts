/**
 * The discovery run engine (spec §7, §9, §15).
 *
 * Every test here drives the REAL `executeDiscoveryRun` loop — the real
 * exclusion set, the real parser, the real fit scorer — against a fake
 * Supabase and a fixture-backed `deepSearch`. Nothing about the loop is
 * stubbed, because the behaviours worth testing (when it stops, what it bills,
 * what it suppresses) are all emergent from the loop rather than from any one
 * function in it.
 *
 * THE CENTREPIECE is `the SECOND run` block. §6's promise — "how do you make
 * sure you don't get the same thing if you do it twice" — is the feature's
 * single most load-bearing claim, and the only honest way to test it is to run
 * the same list twice against the same recorded responses and assert that the
 * second run creates zero duplicate entries, records every repeat with a
 * reason, and bills only for its own calls.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  parseDeepSearchResponse,
  type DeepSearchArgs,
  type DeepSearchResult,
} from '@/lib/exa/deep-search'
import { executeDiscoveryRun, type RunEngineDeps } from '../run'
import { PROSPECTING_MONTHLY_CAP_DOLLARS } from '../spend'
import { emptyIcp } from '../icp'
import type { Icp, ProspectingRunProgress } from '../types'
import { type Captured, filterArgs, hasWorkspaceFilter } from './fake-supabase'
import buyersFixture from './fixtures/exa/discovery-buyers-n25.json'
import investorsFixture from './fixtures/exa/discovery-investors-n15.json'

const WORKSPACE = 'ws-1'
const LIST = 'list-1'
const USER = 'user-1'

const buyers: DeepSearchResult = parseDeepSearchResponse(buyersFixture.response)
const investors: DeepSearchResult = parseDeepSearchResponse(investorsFixture.response)

// ---------------------------------------------------------------------------
// A stateful world: the rows the engine reads AND writes.
// ---------------------------------------------------------------------------

interface EntryRow {
  id: string
  list_id: string
  candidate_key: string
  stage: string
  dismissed_reason: string | null
  discovered_by_run_id: string | null
  fit_score: number | null
  fit_rationale: string | null
  discovery_angle: string | null
}

interface RunRow {
  id: string
  status: string
  stage: string
  list_id: string
  spent_dollars: number
  exa_calls: number
  budget_dollars: number
  icp_snapshot: unknown
  progress: unknown
  counts: unknown
  exclusion_snapshot: unknown
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
  discovery_angle: string | null
  display_name: string | null
}

interface WorldOptions {
  icp?: Icp
  purpose?: string
  maxRounds?: number
  targetNew?: number
  budget?: number
  /** Runs already on the books this calendar month, excluding the live one. */
  priorMonthSpend?: number
  /** Synthetic extra `prospecting_run` rows this month, to push the
   *  monthly-spend read past a single page. */
  extraMonthRuns?: number
  /** What each of those synthetic rows spent. */
  extraMonthSpendEach?: number
  /** Company domains already in the CRM. */
  crmDomains?: string[]
  excludeCrm?: boolean
  /** Called before each `prospecting_run` status read, so a test can flip the
   *  row to `canceling` between angles the way a cancel route would. */
  onStatusRead?: (world: World) => void
  /** Force an insert failure for a given candidate key. */
  entryInsertError?: (key: string) => { message: string; code?: string } | null
  /**
   * `member` rows for the workspace. NOTE the shape: `user_id` only. There is
   * no `member.email` column (migration 013) — selecting one makes PostgREST
   * reject the whole query, which is how the `self` exclusion silently died in
   * production. The email lives on `auth.users`, keyed by this id.
   */
  members?: Array<{ user_id: string }>
  /** `auth.admin.getUserById` results, keyed by user id. A missing key models
   *  a lookup that failed for that one member. */
  authUsers?: Record<string, { email?: string | null }>
  /** Fail the `member` SELECT itself. */
  memberReadError?: { message: string }
}

class World {
  entries: EntryRow[] = []
  runs: RunRow[] = []
  ledger: LedgerRow[] = []
  queries: Captured[] = []
  /** Every id passed to `auth.admin.getUserById`, in call order. */
  adminLookups: string[] = []
  private seq = 0

  constructor(readonly opts: WorldOptions = {}) {}

  addRun(id: string, over: Partial<RunRow> = {}): RunRow {
    const row: RunRow = {
      id,
      status: 'running',
      stage: 'discover',
      list_id: LIST,
      spent_dollars: 0,
      exa_calls: 0,
      budget_dollars: this.opts.budget ?? 2.0,
      icp_snapshot: this.opts.icp ?? icpFor('buyers'),
      progress: {},
      counts: {},
      exclusion_snapshot: {},
      error: null,
      created_at: '2026-09-02T00:00:00.000Z',
      finished_at: null,
      ...over,
    }
    this.runs.push(row)
    return row
  }

  nextId(prefix: string): string {
    this.seq += 1
    return `${prefix}-${this.seq}`
  }

  run(id: string): RunRow | undefined {
    return this.runs.find((r) => r.id === id)
  }

  ledgerFor(runId: string): LedgerRow[] {
    return this.ledger.filter((l) => l.run_id === runId)
  }

  entriesFor(runId: string): EntryRow[] {
    return this.entries.filter((e) => e.discovered_by_run_id === runId)
  }

  /** The client. Every table the engine touches is handled; an unhandled one
   *  throws rather than silently returning null, because a read that quietly
   *  yields nothing is how a broken exclusion set passes its tests. */
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
        // The service-role surface the engine uses to turn member `user_id`s
        // into emails, because `member` has no email column.
        admin: {
          getUserById: async (id: string) => {
            this.adminLookups.push(id)
            const found = this.opts.authUsers?.[id]
            if (!found) return { data: { user: null }, error: { message: 'not found' } }
            return { data: { user: found }, error: null }
          },
        },
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
          const id = eq('id')
          const requiredStatus = eq('status')
          const row = this.runs.find((r) => r.id === id)
          const inFilter = filterArgs(q, 'in').find(([c]) => c === 'status')?.[1] as
            | string[]
            | undefined
          if (!row) return ok([])
          if (requiredStatus && row.status !== requiredStatus) return ok([])
          if (inFilter && !inFilter.includes(row.status)) return ok([])
          Object.assign(row, q.payload as Partial<RunRow>)
          return ok([{ id: row.id }])
        }
        // The monthly-spend read: no `id` filter, a `gte` window instead.
        if (!eq('id')) {
          const rows: Array<{ id: string; spent_dollars: number }> = this.runs.map((r) => ({
            id: r.id,
            spent_dollars: r.spent_dollars,
          }))
          const prior = this.opts.priorMonthSpend
          if (prior != null) rows.push({ id: 'prior-run', spent_dollars: prior })
          // Extra synthetic rows, for the paging test: enough to force the
          // reader past one page.
          for (let i = 0; i < (this.opts.extraMonthRuns ?? 0); i++) {
            rows.push({ id: `filler-${i}`, spent_dollars: this.opts.extraMonthSpendEach ?? 0 })
          }
          // HONOUR `.range()`. A fake that ignored it would hand the reader the
          // same page forever — the pager would loop to its bound and sum the
          // same dollars 40 times, so an unpaged reader and a broken pager
          // would be indistinguishable here.
          const range = filterArgs(q, 'range').at(-1) as [number, number] | undefined
          if (!range) return ok(rows)
          const [from, to] = range
          return ok(rows.slice(from, to + 1))
        }
        const row = this.runs.find((r) => r.id === eq('id'))
        if (!row) return ok(null)
        // Snapshot BEFORE the hook so a hook that flips the row to
        // `canceling` models a cancel landing AFTER this read returned —
        // which is what "cancel between steps" actually is.
        const snapshot = { ...row }
        this.opts.onStatusRead?.(this)
        return ok(snapshot)
      }

      case 'prospect_list':
        // `buildExclusionSet` reads active lists (a `status` filter); the
        // engine reads THE list by id.
        if (eq('id')) {
          return ok({
            id: LIST,
            purpose: this.opts.purpose ?? 'buyers',
            icp: this.opts.icp ?? icpFor('buyers'),
            icp_version: 3,
            status: 'active',
            exclude_crm: this.opts.excludeCrm !== false,
            exclude_other_lists: false,
            exclude_contacted: 'ever',
            target_new_candidates: this.opts.targetNew ?? 20,
            max_rounds: this.opts.maxRounds ?? 2,
          })
        }
        return ok([{ id: LIST }])

      case 'prospect_list_entry': {
        if (q.op === 'insert') {
          const payload = q.payload as { candidate_key: string; [k: string]: unknown }
          const forced = this.opts.entryInsertError?.(payload.candidate_key)
          if (forced) return { data: null, error: forced, count: null }
          if (this.entries.some((e) => e.list_id === LIST && e.candidate_key === payload.candidate_key)) {
            return {
              data: null,
              error: { message: 'duplicate key', code: '23505' },
              count: null,
            }
          }
          const id = this.nextId('entry')
          this.entries.push({
            id,
            list_id: LIST,
            candidate_key: payload.candidate_key,
            stage: 'discovered',
            dismissed_reason: null,
            discovered_by_run_id: payload.discovered_by_run_id as string | null,
            fit_score: (payload.fit_score as number | null | undefined) ?? null,
            fit_rationale: (payload.fit_rationale as string | null | undefined) ?? null,
            discovery_angle: payload.discovery_angle as string | null,
          })
          return ok({ id })
        }
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
        // Both the source-company lookup (`maybeSingle`, filtered) and the
        // exclusion set's CRM read land here; the filters tell them apart.
        if (filterArgs(q, 'range').length > 0) {
          return ok((this.opts.crmDomains ?? []).map((d, i) => ({ id: `co-${i}`, domain: d })))
        }
        return ok(null)

      case 'contact':
        if (filterArgs(q, 'range').length > 0) return ok([])
        return ok(null)

      case 'member': {
        // TWO different reads land here and the filters tell them apart:
        // resolveSourceCompany asks for one row by `user_id`, while the
        // member-email read asks for every row in the workspace.
        const byUser = filterArgs(q, 'eq').some(([col]) => col === 'user_id')
        if (byUser) return ok(null)
        if (this.opts.memberReadError) {
          return { data: null, error: this.opts.memberReadError, count: null }
        }
        return ok((this.opts.members ?? []).map((m) => ({ ...m })))
      }

      case 'sequence_enrollment':
      case 'outreach_suppression':
        return ok([])

      default:
        throw new Error(`unhandled table in fake: ${q.table}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function icpFor(kind: 'buyers' | 'thin'): Icp {
  const icp = emptyIcp()
  icp.source.name = 'Dial8'
  icp.source.domain = 'dial8.ai'
  icp.source.what_we_sell = 'a meeting-capture and CRM workspace'
  if (kind === 'buyers') {
    icp.target.description = 'B2B SaaS companies with large sales teams'
    icp.target.industries = ['B2B SaaS']
    icp.target.buyer_titles = ['VP Sales']
    icp.target.employee_bands = ['201-1000']
  }
  return icp
}

/** A `deepSearch` that returns the recorded response every call and counts
 *  calls. `costDollars` on the buyers fixture is the measured $0.027.
 *
 *  Typed with the real argument so `mock.calls[0][0]` is the request body the
 *  engine actually built — the tests that assert on category, numResults and
 *  the systemPrompt read it directly rather than through a cast. */
function fixtureSearch(res: DeepSearchResult = buyers) {
  return vi.fn(async (_args: DeepSearchArgs) => res)
}

function depsFor(world: World, search = fixtureSearch()): RunEngineDeps {
  return {
    supabase: world.client(),
    deepSearch: search as unknown as RunEngineDeps['deepSearch'],
    now: () => new Date('2026-09-04T12:00:00.000Z'),
    guardUsage: vi.fn(async () => {}),
    // Every domain answers as a live site unless a test says otherwise — no
    // discovery test may reach the network.
    probeDomain: async () => ({ status: 'live' as const, reason: null }),
  }
}

const ARGS = { runId: 'run-1', workspaceId: WORKSPACE, listId: LIST, userId: USER }

// ---------------------------------------------------------------------------

describe('executeDiscoveryRun — a first run', () => {
  it('completes, creates entries, records EVERY candidate, and bills per call', async () => {
    const world = new World({ maxRounds: 1, targetNew: 100 })
    world.addRun('run-1', { status: 'running' })
    const search = fixtureSearch()
    const outcome = await executeDiscoveryRun(depsFor(world, search), ARGS)

    expect(outcome.status).toBe('completed')
    expect(outcome.new_entries).toBeGreaterThan(15)
    expect(world.entriesFor('run-1')).toHaveLength(outcome.new_entries)

    // Every candidate the parser produced reached the ledger — new,
    // suppressed and invalid alike. A dedup that silently drops repeats is
    // indistinguishable from a search that found nothing (§6).
    const ledger = world.ledgerFor('run-1')
    expect(ledger.length).toBeGreaterThanOrEqual(outcome.new_entries)
    expect(ledger.every((l) => ['new', 'suppressed', 'invalid'].includes(l.outcome))).toBe(true)
    expect(ledger.filter((l) => l.outcome === 'new')).toHaveLength(outcome.new_entries)
    for (const row of ledger.filter((l) => l.outcome === 'suppressed')) {
      // A suppression with no reason is exactly the opaque behaviour §6 exists
      // to prevent.
      expect(row.suppressed_by).toBeTruthy()
    }

    // Real money: the fixture's own measured cost, once per call.
    expect(outcome.exa_calls).toBe(search.mock.calls.length)
    expect(outcome.spent_dollars).toBeCloseTo(buyers.costDollars! * outcome.exa_calls, 6)
    expect(world.run('run-1')!.spent_dollars).toBeCloseTo(outcome.spent_dollars, 6)
  })

  it('stamps the angle and the run id on every entry, and NO score', async () => {
    const world = new World({ maxRounds: 1, targetNew: 100 })
    world.addRun('run-1')
    await executeDiscoveryRun(depsFor(world), ARGS)

    const entries = world.entriesFor('run-1')
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      // discovery_angle is telemetry that is unavailable retroactively (§7).
      expect(entry.discovery_angle).toBeTruthy()
      // Discovery does not score (fit.ts): the profile does, once. What
      // discovery leaves is the search's own why-match sentence as the "why".
      expect(entry.fit_score).toBeNull()
      expect(entry).not.toHaveProperty('fit_tier')
    }
    expect(entries.some((e) => typeof e.fit_rationale === 'string' && e.fit_rationale.length > 0)).toBe(true)
  })

  it('carries workspace_id on every read and write', async () => {
    const world = new World({ maxRounds: 1 })
    world.addRun('run-1')
    await executeDiscoveryRun(depsFor(world), ARGS)

    // RLS is not the boundary here: the engine runs under a service-role
    // client where RLS does not apply at all.
    const scoped = world.queries.filter((q) =>
      ['prospecting_run', 'prospect_list', 'prospect_list_entry'].includes(q.table),
    )
    expect(scoped.length).toBeGreaterThan(0)
    for (const q of scoped) {
      if (q.op === 'insert') {
        const payload = q.payload as { workspace_id?: string }
        expect(payload.workspace_id).toBe(WORKSPACE)
      } else {
        expect(hasWorkspaceFilter(q, WORKSPACE)).toBe(true)
      }
    }
    for (const q of world.queries.filter((q) => q.table === 'prospect_run_candidate')) {
      const rows = q.payload as Array<{ workspace_id?: string }>
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        expect(row.workspace_id).toBe(WORKSPACE)
      }
    }
  })

  it('writes progress after every angle, shaped as ProspectingRunProgress', async () => {
    const world = new World({ maxRounds: 1, targetNew: 100 })
    world.addRun('run-1')
    const search = fixtureSearch()
    await executeDiscoveryRun(depsFor(world, search), ARGS)

    const progress = world.run('run-1')!.progress as ProspectingRunProgress
    // A structural assertion, not a snapshot: the §9 stepper renders every one
    // of these, and an untyped jsonb here is a permanently blank progress bar
    // that no other test would catch.
    const shape: ProspectingRunProgress = progress
    expect(shape.stage).toBe('done')
    expect(shape.round).toBe(1)
    expect(shape.max_rounds).toBe(1)
    expect(shape.found).toBeGreaterThan(0)
    // The arithmetic a user does reading "38 candidates · 20 already in this
    // list · 9 new". It only holds because all four counters are per-IDENTITY
    // and a re-sighting of this run's own find is neither new nor suppressed.
    expect(shape.new + shape.suppressed + shape.invalid).toBe(shape.found)
    expect(shape.exa_calls).toBe(search.mock.calls.length)
    expect(shape.spent_dollars).toBeGreaterThan(0)
    expect(typeof shape.updated_at).toBe('string')
    // Discovery is `kind: 'discover'` — the per-company counters are honestly
    // zero, never absent.
    expect(shape.accounts_total).toBe(0)
    expect(shape.people_target).toBe(0)

    // Written at every boundary, not just at the end: a mid-run reload has to
    // rehydrate exactly.
    const progressWrites = world.queries.filter(
      (q) => q.table === 'prospecting_run' && q.op === 'update' && (q.payload as Record<string, unknown>).progress,
    )
    expect(progressWrites.length).toBeGreaterThanOrEqual(search.mock.calls.length + 1)
  })

  it('writes the exclusion snapshot in preflight, before any paid call', async () => {
    const world = new World({ maxRounds: 1, crmDomains: ['chimewell.io', 'forecastly.com'] })
    world.addRun('run-1')
    const search = fixtureSearch()
    await executeDiscoveryRun(depsFor(world, search), ARGS)

    const snapshotWrite = world.queries.findIndex(
      (q) =>
        q.table === 'prospecting_run' &&
        q.op === 'update' &&
        (q.payload as Record<string, unknown>).exclusion_snapshot !== undefined,
    )
    expect(snapshotWrite).toBeGreaterThanOrEqual(0)
    const snapshot = (world.run('run-1')!.exclusion_snapshot ?? {}) as {
      domain_count: number
      sources: Record<string, number>
    }
    // The number that makes the consent screen honest: "excluding N domains
    // you already know."
    expect(snapshot.domain_count).toBeGreaterThanOrEqual(2)
    expect(snapshot.sources.crm).toBe(2)
  })

  it('suppresses a company already in the CRM and links the record that caused it', async () => {
    // chimewell.io is a real result host in the recorded response (§12).
    const world = new World({ maxRounds: 1, crmDomains: ['chimewell.io'] })
    world.addRun('run-1')
    await executeDiscoveryRun(depsFor(world), ARGS)

    const hit = world.ledgerFor('run-1').find((l) => l.identity_key === 'chimewell.io')
    expect(hit?.outcome).toBe('suppressed')
    expect(hit?.suppressed_by).toBe('crm')
    expect(hit?.suppressed_ref_id).toBe('co-0')
    expect(world.entries.some((e) => e.candidate_key === 'chimewell.io')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Member emails → the `self` exclusion source
// ---------------------------------------------------------------------------

describe('member emails feed the `self` exclusion', () => {
  it('reads user_id from `member` and NEVER an email column', async () => {
    // The production defect: this read was `.select('email')`, and `member`
    // (migration 013) has no such column — `user_id`, `role`, `display_name`
    // only. PostgREST rejects the whole query with "column member.email does
    // not exist", so the read returned nothing and the `self` exclusion was
    // silently off. Asserting the SELECT list is what keeps it off.
    const world = new World({
      maxRounds: 1,
      members: [{ user_id: 'u-1' }],
      authUsers: { 'u-1': { email: 'liam@dial8.ai' } },
    })
    world.addRun('run-1')
    await executeDiscoveryRun(depsFor(world), ARGS)

    // Two reads hit `member`: resolveSourceCompany's single row by `user_id`,
    // and this one — every row in the workspace. Pick the latter.
    const memberRead = world.queries.find(
      (q) => q.table === 'member' && !filterArgs(q, 'eq').some(([col]) => col === 'user_id'),
    )
    expect(memberRead).toBeTruthy()
    const selected = filterArgs(memberRead!, 'select').flat()
    expect(selected).toEqual(['user_id'])
    // No member.email column exists; asking for one rejects the whole query.
    for (const q of world.queries.filter((x) => x.table === 'member')) {
      expect(String(filterArgs(q, 'select').flat())).not.toContain('email')
    }
    // RLS is never the only boundary in this lib.
    expect(hasWorkspaceFilter(memberRead!, WORKSPACE)).toBe(true)
  })

  it('resolves each member through the auth admin API', async () => {
    const world = new World({
      maxRounds: 1,
      members: [{ user_id: 'u-1' }, { user_id: 'u-2' }],
      authUsers: { 'u-1': { email: 'liam@dial8.ai' }, 'u-2': { email: 'sam@dial8.ai' } },
    })
    world.addRun('run-1')
    await executeDiscoveryRun(depsFor(world), ARGS)

    // One getUserById per member — deliberately NOT a listUsers page, which
    // would walk the entire product user base to map two rows.
    expect(world.adminLookups.sort()).toEqual(['u-1', 'u-2'])
  })

  it("counts every member's employer domain in the `self` exclusion snapshot", async () => {
    // The whole point of the read: a member's employer domain is "us", and
    // prospecting "us" wastes a paid slot on the user's own company.
    const world = new World({
      maxRounds: 1,
      members: [{ user_id: 'u-1' }],
      authUsers: { 'u-1': { email: 'liam@dial8.ai' } },
    })
    world.addRun('run-1')
    await executeDiscoveryRun(depsFor(world), ARGS)

    const snapshot = (world.run('run-1')!.exclusion_snapshot ?? {}) as {
      sources: Record<string, number>
    }
    expect(snapshot.sources.self).toBeGreaterThanOrEqual(1)
  })

  it('degrades to no member emails when the `member` read fails', async () => {
    // A missing member email costs one wasted candidate; failing the run costs
    // the whole search. So the read fails soft and the run still completes.
    const world = new World({ maxRounds: 1, memberReadError: { message: 'boom' } })
    world.addRun('run-1')
    const out = await executeDiscoveryRun(depsFor(world), ARGS)

    expect(out.status).toBe('completed')
    expect(world.adminLookups).toEqual([])
  })

  it('degrades over ONE failed lookup rather than losing the others', async () => {
    // getUserById is a network call per member; one 404 or a throttled request
    // must not take the rest of the exclusion set down with it.
    const world = new World({
      maxRounds: 1,
      members: [{ user_id: 'u-1' }, { user_id: 'missing' }],
      authUsers: { 'u-1': { email: 'liam@dial8.ai' } },
    })
    world.addRun('run-1')
    const out = await executeDiscoveryRun(depsFor(world), ARGS)

    expect(out.status).toBe('completed')
    expect(world.adminLookups.sort()).toEqual(['missing', 'u-1'])
    const snapshot = (world.run('run-1')!.exclusion_snapshot ?? {}) as {
      sources: Record<string, number>
    }
    expect(snapshot.sources.self).toBeGreaterThanOrEqual(1)
  })

  it('caps the fan-out at 50 members', async () => {
    // The emails feed one thing — "us, do not prospect us" — and the first
    // handful already cover the workspace's own domain. The tail would cost
    // one GoTrue round trip each for nothing.
    const members = Array.from({ length: 60 }, (_, i) => ({ user_id: `u-${i}` }))
    const authUsers = Object.fromEntries(
      members.map((m) => [m.user_id, { email: `${m.user_id}@dial8.ai` }]),
    )
    const world = new World({ maxRounds: 1, members, authUsers })
    world.addRun('run-1')
    await executeDiscoveryRun(depsFor(world), ARGS)

    expect(world.adminLookups).toHaveLength(50)
  })
})

// ---------------------------------------------------------------------------
// THE SECOND-RUN TEST (§15)
// ---------------------------------------------------------------------------

describe('the SECOND run of the same list — §6', () => {
  it('records every repeat as suppressed, inserts ZERO duplicates, and bills only its own calls', async () => {
    const world = new World({ maxRounds: 1, targetNew: 100 })
    world.addRun('run-1')
    const search1 = fixtureSearch()
    const first = await executeDiscoveryRun(depsFor(world, search1), ARGS)

    expect(first.status).toBe('completed')
    expect(first.new_entries).toBeGreaterThan(15)
    const entriesAfterFirst = world.entries.length

    // Two weeks later: "Find more". Same list, same fixtures — so EVERY
    // candidate run 2 sees is one run 1 already banked.
    world.addRun('run-2', { status: 'running' })
    const search2 = fixtureSearch()
    const second = await executeDiscoveryRun(depsFor(world, search2), {
      ...ARGS,
      runId: 'run-2',
    })

    expect(second.status).toBe('completed')

    // 1. Not one duplicate entry.
    expect(second.new_entries).toBe(0)
    expect(world.entries).toHaveLength(entriesAfterFirst)

    // 2. Every repeat is VISIBLE, with a reason. This is what makes dedup
    //    trustworthy rather than indistinguishable from a failed search.
    const ledger2 = world.ledgerFor('run-2')
    expect(ledger2.length).toBeGreaterThan(0)
    expect(ledger2.some((l) => l.outcome === 'new')).toBe(false)
    const suppressed = ledger2.filter((l) => l.outcome === 'suppressed')
    expect(suppressed.length).toBeGreaterThan(15)
    // Every repeat is `this_list`. The ONE exception in this fixture is
    // linkedin.com, a real result host (§12) that `isNoiseHost` refuses in
    // BOTH runs — it never became an entry in run 1, so it cannot be a repeat
    // in run 2, and it is honestly reported as `noise_host` instead (its own
    // source since migration 251; before that it borrowed `personal_domain`).
    expect(suppressed.some((l) => l.suppressed_by === 'noise_host')).toBe(true)
    const repeats = suppressed.filter(
      (l) => l.suppressed_by !== 'noise_host' && l.suppressed_by !== 'personal_domain',
    )
    expect(repeats.length).toBeGreaterThan(15)
    expect(repeats.every((l) => l.suppressed_by === 'this_list')).toBe(true)
    // …and each points at the entry that caused it, for the UI's link.
    expect(
      repeats.every((l) => world.entries.some((e) => e.id === l.suppressed_ref_id)),
    ).toBe(true)

    // 3. Run 2 bills its OWN calls and inherits none of run 1's spend.
    expect(second.exa_calls).toBe(search2.mock.calls.length)
    expect(world.run('run-2')!.spent_dollars).toBeCloseTo(
      buyers.costDollars! * second.exa_calls,
      6,
    )
    expect(world.run('run-1')!.spent_dollars).toBeCloseTo(
      buyers.costDollars! * first.exa_calls,
      6,
    )

    // 4. And it stops after ONE round rather than burning the second on an
    //    exhausted ICP.
    expect(second.rounds_run).toBe(1)

    // 5. Counts are the per-reason tally the run summary renders.
    expect(second.counts.this_list).toBe(repeats.length)
    expect(second.counts.crm).toBe(0)
  })

  it("keeps a dismissed company suppressed — a dismissal is data, not a deletion", async () => {
    const world = new World({ maxRounds: 1, targetNew: 100 })
    world.addRun('run-1')
    await executeDiscoveryRun(depsFor(world), ARGS)

    // The user dismisses one. The entry SURVIVES: that is the suppression.
    const victim = world.entries[0]
    victim.stage = 'dismissed'
    victim.dismissed_reason = 'not_icp'

    world.addRun('run-2')
    await executeDiscoveryRun(depsFor(world), { ...ARGS, runId: 'run-2' })

    const hit = world.ledgerFor('run-2').find((l) => l.identity_key === victim.candidate_key)
    expect(hit?.outcome).toBe('suppressed')
    expect(hit?.suppressed_by).toBe('this_list')
  })
})

// ---------------------------------------------------------------------------
// Stop conditions
// ---------------------------------------------------------------------------

describe('the round loop stops', () => {
  it('HARD STOPS after a round that yields zero new candidates', async () => {
    const world = new World({ maxRounds: 3, targetNew: 500 })
    world.addRun('run-1')
    await executeDiscoveryRun(depsFor(world), ARGS)

    // Round 1 banks everything the fixture has; round 2 would find nothing new
    // and cost a full round. An exhausted ICP must not burn three rounds of
    // full-price searches (§9).
    world.addRun('run-2')
    const search = fixtureSearch()
    const second = await executeDiscoveryRun(depsFor(world, search), { ...ARGS, runId: 'run-2' })

    expect(second.new_entries).toBe(0)
    expect(second.rounds_run).toBe(1)
    // Exactly one round of calls, not three.
    expect(search.mock.calls.length).toBeLessThanOrEqual(4)
  })

  it('respects max_rounds when the target is never reached', async () => {
    // Every call returns nothing usable, so the loop can only be bounded by
    // max_rounds… except it is bounded EARLIER by the zero-new hard stop,
    // which is the point: an empty round is the cheapest possible exit.
    const empty: DeepSearchResult = {
      requestId: null,
      content: { companies: [] },
      grounding: [],
      results: [],
      costDollars: 0.027,
    }
    const world = new World({ maxRounds: 3, targetNew: 100 })
    world.addRun('run-1')
    const search = fixtureSearch(empty)
    const outcome = await executeDiscoveryRun(depsFor(world, search), ARGS)

    expect(outcome.status).toBe('completed')
    expect(outcome.new_entries).toBe(0)
    expect(outcome.rounds_run).toBe(1)
  })

  it('never exceeds max_rounds even when every round finds something new', async () => {
    // A fresh response each call, so no round is ever "zero new" and only
    // max_rounds can end the loop.
    let n = 0
    const search = vi.fn(async () => syntheticResponse(n++))
    const world = new World({ maxRounds: 2, targetNew: 1000 })
    world.addRun('run-1')
    const outcome = await executeDiscoveryRun(
      depsFor(world, search as unknown as ReturnType<typeof fixtureSearch>),
      ARGS,
    )

    expect(outcome.rounds_run).toBe(2)
    expect(outcome.status).toBe('completed')
  })

  it('stops EARLY once target_new_candidates is reached', async () => {
    let n = 0
    const search = vi.fn(async () => syntheticResponse(n++))
    const world = new World({ maxRounds: 3, targetNew: 5 })
    world.addRun('run-1')
    const outcome = await executeDiscoveryRun(
      depsFor(world, search as unknown as ReturnType<typeof fixtureSearch>),
      ARGS,
    )

    expect(outcome.new_entries).toBeGreaterThanOrEqual(5)
    expect(outcome.rounds_run).toBe(1)
    expect(outcome.status).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// The two spend gates
// ---------------------------------------------------------------------------

describe('spend gates', () => {
  it('parks at budget_exhausted BEFORE the next call, keeping partial results', async () => {
    // A budget that affords one call and not two.
    const world = new World({ maxRounds: 2, targetNew: 100, budget: 0.05 })
    world.addRun('run-1')
    const search = fixtureSearch()
    const outcome = await executeDiscoveryRun(depsFor(world, search), ARGS)

    expect(outcome.status).toBe('budget_exhausted')
    expect(outcome.error).toBe('run_cap')
    // ONE call: after billing $0.027, $0.027 + $0.03 > $0.05 and the gate
    // refuses. The check is before the call, so the cap is never overshot.
    expect(search.mock.calls.length).toBe(1)
    expect(outcome.spent_dollars).toBeLessThanOrEqual(0.05)

    // PARTIAL RESULTS ARE KEPT. "budget_exhausted is an outcome, not a
    // failure" (§9) — a run that quietly threw away what it found would be a
    // bug report.
    expect(outcome.new_entries).toBeGreaterThan(0)
    expect(world.entriesFor('run-1').length).toBe(outcome.new_entries)
    expect(world.run('run-1')!.status).toBe('budget_exhausted')
    expect(world.run('run-1')!.finished_at).toBeTruthy()
  })

  it('refuses in preflight on the monthly ceiling, before ANY paid call', async () => {
    const world = new World({
      maxRounds: 2,
      priorMonthSpend: PROSPECTING_MONTHLY_CAP_DOLLARS + 1,
    })
    world.addRun('run-1')
    const search = fixtureSearch()
    const outcome = await executeDiscoveryRun(depsFor(world, search), ARGS)

    expect(outcome.status).toBe('budget_exhausted')
    expect(outcome.error).toBe('monthly_cap')
    // The assertion that matters: not one dollar was spent finding out.
    expect(search).not.toHaveBeenCalled()
    expect(outcome.spent_dollars).toBe(0)
    expect(world.run('run-1')!.status).toBe('budget_exhausted')
  })

  it('excludes THIS run from the monthly sum, so a resume cannot bill itself twice', async () => {
    // The run itself already spent $19 (a resume). Counting that against the
    // $20 ceiling would park a run for money it is about to re-report.
    // Its own per-run budget is raised out of the way so this test exercises
    // the MONTHLY gate alone.
    const world = new World({ maxRounds: 1, targetNew: 100, budget: 20 })
    world.addRun('run-1', { spent_dollars: 19 })
    const search = fixtureSearch()
    const outcome = await executeDiscoveryRun(depsFor(world, search), ARGS)

    expect(outcome.status).not.toBe('budget_exhausted')
    expect(search).toHaveBeenCalled()
  })

  it('scopes the monthly read to the UTC calendar month', async () => {
    const world = new World({ maxRounds: 1 })
    world.addRun('run-1')
    await executeDiscoveryRun(depsFor(world), ARGS)

    const monthQuery = world.queries.find(
      (q) => q.table === 'prospecting_run' && filterArgs(q, 'gte').length > 0,
    )
    expect(monthQuery).toBeTruthy()
    expect(filterArgs(monthQuery!, 'gte')[0]).toEqual([
      'created_at',
      '2026-09-01T00:00:00.000Z',
    ])
  })

  it('PAGES the monthly read, so a workspace past one page is not under-counted', async () => {
    // 700 cheap rows this month — past PostgREST's implicit row limit, which an
    // unpaged select would silently truncate at. Each is $0.05, so the true
    // total ($35) is over the $20 ceiling while any single truncated page is
    // under it. An unpaged reader admits this run and bills real money past the
    // cap that exists to bound it.
    const world = new World({
      maxRounds: 1,
      extraMonthRuns: 700,
      extraMonthSpendEach: 0.05,
    })
    world.addRun('run-1')
    const search = fixtureSearch()
    const outcome = await executeDiscoveryRun(depsFor(world, search), ARGS)

    expect(outcome.status).toBe('budget_exhausted')
    expect(outcome.error).toBe('monthly_cap')
    expect(search).not.toHaveBeenCalled()

    // It really paged: more than one windowed read, each with a distinct range.
    const monthQueries = world.queries.filter(
      (q) => q.table === 'prospecting_run' && filterArgs(q, 'gte').length > 0,
    )
    expect(monthQueries.length).toBeGreaterThan(1)
    const ranges = monthQueries.map((q) => JSON.stringify(filterArgs(q, 'range').at(-1)))
    expect(new Set(ranges).size).toBe(ranges.length)
    // And it stopped on the short page rather than looping to its bound.
    expect(monthQueries.length).toBeLessThan(5)
  })

  it('stops paging the monthly read at the first short page', async () => {
    const world = new World({ maxRounds: 1, extraMonthRuns: 3 })
    world.addRun('run-1')
    await executeDiscoveryRun(depsFor(world), ARGS)

    const monthQueries = world.queries.filter(
      (q) => q.table === 'prospecting_run' && filterArgs(q, 'gte').length > 0,
    )
    // A handful of rows is one page; a second request would be a wasted round
    // trip on every single run.
    expect(monthQueries).toHaveLength(1)
  })

  it('runs the usage guard BEFORE anything paid, and lets NonRetriable escape', async () => {
    const world = new World({ maxRounds: 1 })
    world.addRun('run-1')
    const search = fixtureSearch()
    const boom = new Error('over cap')
    const deps = {
      ...depsFor(world, search),
      guardUsage: vi.fn(async () => {
        throw boom
      }),
    }

    // The engine does NOT swallow it: Inngest must see the NonRetriable so it
    // stops cleanly rather than retrying against a cap that will not lift.
    await expect(executeDiscoveryRun(deps, ARGS)).rejects.toBe(boom)
    expect(search).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

describe('cancel', () => {
  it('stops between steps and writes canceled WITH partial results', async () => {
    // The cancel route writes `canceling`; the engine notices between angles.
    // The engine reads the run row once to LOAD it, then once per angle for
    // the cancel check. Read 1 = load, read 2 = the gate before angle 1, read
    // 3 = the gate before angle 2 — so flipping on read 2 lets exactly one
    // paid call happen before the cancel is seen.
    let statusReads = 0
    const world = new World({
      maxRounds: 2,
      targetNew: 500,
      onStatusRead: (w) => {
        statusReads += 1
        if (statusReads === 2) {
          const row = w.run('run-1')
          if (row) row.status = 'canceling'
        }
      },
    })
    world.addRun('run-1')
    const search = fixtureSearch()
    const outcome = await executeDiscoveryRun(depsFor(world, search), ARGS)

    expect(outcome.status).toBe('canceled')
    expect(outcome.error).toBeNull()
    // One call happened before the cancel landed; the second never fired.
    expect(search.mock.calls.length).toBe(1)
    // Partial results survive — a cancel is not a rollback.
    expect(outcome.new_entries).toBeGreaterThan(0)
    expect(world.entriesFor('run-1').length).toBe(outcome.new_entries)
    expect(world.run('run-1')!.status).toBe('canceled')
    expect(world.run('run-1')!.finished_at).toBeTruthy()
  })

  it('keeps a cancel pressed during preflight (the start write does not reset it to running)', async () => {
    const world = new World({ maxRounds: 2 })
    world.addRun('run-1', { status: 'canceling' })
    const search = fixtureSearch()
    const outcome = await executeDiscoveryRun(depsFor(world, search), ARGS)
    expect(outcome.status).toBe('canceled')
    expect(search).not.toHaveBeenCalled()
  })

  it('reports canceled rather than budget_exhausted when both are true', async () => {
    // A cancelled run that ALSO ran out of money must say the user stopped it.
    const world = new World({
      maxRounds: 2,
      budget: 0.05,
      onStatusRead: (w) => {
        const row = w.run('run-1')
        if (row && row.status === 'running') row.status = 'canceling'
      },
    })
    world.addRun('run-1')
    const outcome = await executeDiscoveryRun(depsFor(world), ARGS)
    expect(outcome.status).toBe('canceled')
  })
})

// ---------------------------------------------------------------------------
// Conflicts, idempotency and failure
// ---------------------------------------------------------------------------

describe('conflicts and idempotency', () => {
  it('maps a 23505 on the entry insert to suppressed this_list, never an error', async () => {
    // A concurrent run banked one of these keys between our exclusion set and
    // our insert. §6 Layer 2: the database refuses re-entry, and that refusal
    // is a suppression.
    const world = new World({ maxRounds: 1, targetNew: 100 })
    world.addRun('run-1')
    // Pre-seed an entry the exclusion set will NOT see (it is written after
    // preflight in real life; here we hide it by list_id mismatch on read and
    // let the insert collide).
    // A real admitted key from the recorded response. (Not a NOISE_HOSTS host
    // such as an ATS like `ashbyhq.com`: those never reach an insert.)
    const stolen = 'useticketry.com'
    const deps = depsFor(world)
    world.opts.entryInsertError = (key) =>
      key === stolen
        ? { message: 'duplicate key value violates unique constraint', code: '23505' }
        : null

    const outcome = await executeDiscoveryRun(deps, ARGS)

    expect(outcome.status).toBe('completed')
    const hit = world.ledgerFor('run-1').find((l) => l.identity_key === stolen)
    expect(hit?.outcome).toBe('suppressed')
    expect(hit?.suppressed_by).toBe('this_list')
    expect(outcome.counts.this_list).toBeGreaterThanOrEqual(1)
    expect(world.entries.some((e) => e.candidate_key === stolen)).toBe(false)
  })

  it('throws on a NON-conflict insert error so Inngest can retry it', async () => {
    const world = new World({ maxRounds: 1 })
    world.addRun('run-1')
    world.opts.entryInsertError = () => ({ message: 'connection reset' })
    await expect(executeDiscoveryRun(depsFor(world), ARGS)).rejects.toThrow(/connection reset/)
  })

  it('exits idempotently when the row is already terminal', async () => {
    const world = new World({ maxRounds: 1 })
    world.addRun('run-1', { status: 'completed' })
    const search = fixtureSearch()
    const outcome = await executeDiscoveryRun(depsFor(world, search), ARGS)

    expect(outcome.status).toBe('completed')
    // The point: a replay of a finished run re-bills NOTHING.
    expect(search).not.toHaveBeenCalled()
    expect(world.entries).toHaveLength(0)
  })

  it('RE-ENTERS a run left at running by a transient throw, and finishes it', async () => {
    // The retry contract, from the engine's side. Attempt 1 throws mid-search
    // (an Exa 503) after banking real entries; the wrapper leaves the row at
    // `running` precisely so this can happen. Attempt 2 must actually search.
    const world = new World({ maxRounds: 1, targetNew: 100 })
    world.addRun('run-1')

    let calls = 0
    const flaky = vi.fn(async (_args: DeepSearchArgs) => {
      calls += 1
      if (calls === 2) throw new Error('exa 503')
      return buyers
    })
    await expect(
      executeDiscoveryRun(depsFor(world, flaky), ARGS),
    ).rejects.toThrow(/exa 503/)

    // Partial results are on the row, and the status is NOT terminal — that is
    // what makes the run re-enterable.
    const midway = world.run('run-1')!
    expect(midway.status).toBe('running')
    expect(world.entriesFor('run-1').length).toBeGreaterThan(0)

    const search2 = fixtureSearch()
    const outcome = await executeDiscoveryRun(depsFor(world, search2), ARGS)

    expect(search2).toHaveBeenCalled()
    expect(outcome.status).toBe('completed')
    expect(world.run('run-1')!.status).toBe('completed')
  })

  it('REFUSES to re-enter a run some other writer marked failed', async () => {
    // The other half of the same contract, and the reason the wrapper must not
    // write `failed` while a retry is still pending: this guard cannot tell a
    // genuine terminal failure from a premature one, so a premature write
    // silently converts every retriable error into a permanent failure.
    const world = new World({ maxRounds: 1 })
    world.addRun('run-1', { status: 'failed' })
    const search = fixtureSearch()
    const outcome = await executeDiscoveryRun(depsFor(world, search), ARGS)

    expect(outcome.status).toBe('failed')
    expect(search).not.toHaveBeenCalled()
  })

  it('fails cleanly when the list is gone', async () => {
    const world = new World({ maxRounds: 1 })
    world.addRun('run-1')
    // Make the list read miss.
    const client = world.client()
    const spied = {
      ...client,
      from: (table: string) =>
        table === 'prospect_list'
          ? {
              select: () => ({
                eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
              }),
            }
          : (client as unknown as { from: (t: string) => unknown }).from(table),
    } as unknown as SupabaseClient
    const outcome = await executeDiscoveryRun(
      { ...depsFor(world), supabase: spied },
      ARGS,
    )
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toBe('list_not_found')
  })
})

// ---------------------------------------------------------------------------
// The search request itself
// ---------------------------------------------------------------------------

describe('the discovery call', () => {
  it('sends the measured shape: company category, 25 results, the list card', async () => {
    const world = new World({ maxRounds: 1 })
    world.addRun('run-1')
    const search = fixtureSearch()
    await executeDiscoveryRun(depsFor(world, search), ARGS)

    const call = search.mock.calls[0][0]
    expect(call.category).toBe('company')
    // §12 priced the whole cost model at numResults 25.
    expect(call.numResults).toBe(25)
    expect(call.outputSchema).toBeTruthy()
    expect(typeof call.query).toBe('string')
    expect(Array.isArray(call.additionalQueries)).toBe(true)
    expect(typeof call.systemPrompt).toBe('string')
  })

  it('names suppressed domains in the prompt as a COST hint, with the post-filter still authoritative', async () => {
    const world = new World({ maxRounds: 1, crmDomains: ['chimewell.io', 'forecastly.com'] })
    world.addRun('run-1')
    const search = fixtureSearch()
    await executeDiscoveryRun(depsFor(world, search), ARGS)

    const prompt = search.mock.calls[0][0].systemPrompt ?? ''
    expect(prompt).toContain('chimewell.io')

    // …and chimewell.io comes back anyway (it is a real host in the recorded
    // response). The measured leak is 2 of 30; the post-filter is what makes
    // the run correct.
    expect(world.entries.some((e) => e.candidate_key === 'chimewell.io')).toBe(false)
    expect(
      world.ledgerFor('run-1').find((l) => l.identity_key === 'chimewell.io')?.outcome,
    ).toBe('suppressed')
  })

  it('uses the investor noun for an investor list', async () => {
    const world = new World({ maxRounds: 1, purpose: 'investors' })
    world.addRun('run-1')
    const search = fixtureSearch(investors)
    await executeDiscoveryRun(depsFor(world, search), ARGS)

    const prompt = search.mock.calls[0][0].systemPrompt ?? ''
    // "companies" makes the model return the funds' PORTFOLIO companies.
    expect(prompt).toContain('venture funds')
  })

  it('searches the RUN snapshot, not the list\'s live ICP', async () => {
    const snapshot = emptyIcp()
    snapshot.source.name = 'SnapshotCo'
    snapshot.target.description = 'the ICP as it was when Find was pressed'
    const world = new World({ maxRounds: 1 })
    world.addRun('run-1', { icp_snapshot: snapshot })
    const search = fixtureSearch()
    await executeDiscoveryRun(depsFor(world, search), ARGS)

    // Run history stays honest about what was actually searched, even if the
    // user edited the ICP while the run was queued.
    const prompt = search.mock.calls[0][0].systemPrompt ?? ''
    expect(prompt).toContain('SnapshotCo')
  })
})

// ---------------------------------------------------------------------------

/** A synthetic response with `count` fresh companies, so a test can force a
 *  round to always find something new. */
function syntheticResponse(round: number, count = 6): DeepSearchResult {
  const companies = Array.from({ length: count }, (_, i) => ({
    name: `Company ${round}-${i}`,
    domain: `co-${round}-${i}.com`,
    oneLiner: 'A B2B SaaS company selling to sales teams.',
    whyMatch: 'A B2B SaaS company with a large sales organisation.',
    signal: 'Recently raised a Series B.',
    employeeRange: '201-1000',
  }))
  return {
    requestId: null,
    content: { companies },
    grounding: companies.flatMap((c, i) => [
      {
        field: `companies[${i}].name`,
        citations: [{ url: `https://${c.domain}`, title: c.name }],
        confidence: 'high' as const,
      },
      {
        field: `companies[${i}].domain`,
        citations: [{ url: `https://${c.domain}`, title: c.name }],
        confidence: 'high' as const,
      },
    ]),
    results: [],
    costDollars: 0.027,
  }
}

// ---------------------------------------------------------------------------
// The parked-domain gate
// ---------------------------------------------------------------------------

/**
 * Exa's index remembers what a domain USED to host. solenneventures.net — a
 * HugeDomains for-sale page — became a row from stale pages, scored 80 off
 * the same pages, and swallowed the real firm's partners (2026-09-07). So
 * discovery asks each admitted domain whether a live site answers, and
 * refuses a parked or dead one as `invalid` with the reason in the ledger.
 */
describe('executeDiscoveryRun — the parked-domain gate', () => {
  it('refuses a parked domain as invalid with the reason, and never re-probes it', async () => {
    const world = new World({ maxRounds: 1, targetNew: 100 })
    world.addRun('run-1')
    // The first domain the engine asks about is the parked one — whichever
    // it is; the fixture's order is not this test's business.
    let parked: string | null = null
    const probed: string[] = []
    const probe = vi.fn(async (domain: string) => {
      probed.push(domain)
      parked ??= domain
      return domain === parked
        ? { status: 'parked' as const, reason: 'redirects to hugedomains.com' }
        : { status: 'live' as const, reason: null }
    })
    const outcome = await executeDiscoveryRun({ ...depsFor(world), probeDomain: probe }, ARGS)
    expect(outcome.status).toBe('completed')
    expect(parked).toBeTruthy()

    // No row for it — and the ledger says exactly why.
    expect(world.entriesFor('run-1').some((e) => e.candidate_key === parked)).toBe(false)
    const refused = world
      .ledgerFor('run-1')
      .filter((l) => l.outcome === 'invalid')
      .map((l) => l as unknown as { identity_key: string; raw?: Record<string, unknown> })
      .filter((l) => l.raw?.refused === 'parked_domain')
    expect(refused).toHaveLength(1)
    expect(refused[0].identity_key).toBe(parked)
    expect(refused[0].raw?.refused_reason).toBe('redirects to hugedomains.com')
    expect((world.run('run-1')!.progress as { invalid: number }).invalid).toBeGreaterThanOrEqual(1)

    // Probed ONCE, however many angles re-sight it; the ledger holds its row.
    expect(probed.filter((d) => d === parked)).toHaveLength(1)
    // And every other admitted company still got its row.
    expect(outcome.new_entries).toBeGreaterThan(10)
  })

  it('refuses a dead domain the same way, and admits one the probe could not decide', async () => {
    const world = new World({ maxRounds: 1, targetNew: 100 })
    world.addRun('run-1')
    const seen: string[] = []
    const probe = vi.fn(async (domain: string) => {
      seen.push(domain)
      if (seen.length === 1) return { status: 'dead' as const, reason: 'no DNS record' }
      if (seen.length === 2) return { status: 'unknown' as const, reason: 'socket hang up' }
      return { status: 'live' as const, reason: null }
    })
    const outcome = await executeDiscoveryRun({ ...depsFor(world), probeDomain: probe }, ARGS)
    expect(outcome.status).toBe('completed')
    const [dead, undecided] = seen
    expect(world.entriesFor('run-1').some((e) => e.candidate_key === dead)).toBe(false)
    const deadRow = world
      .ledgerFor('run-1')
      .map((l) => l as unknown as { identity_key: string; outcome: string; raw?: Record<string, unknown> })
      .find((l) => l.identity_key === dead)
    expect(deadRow?.outcome).toBe('invalid')
    expect(deadRow?.raw?.refused).toBe('dead_domain')
    // Unknown admits: a real company must never lose its row to a flaky fetch.
    expect(world.entriesFor('run-1').some((e) => e.candidate_key === undecided)).toBe(true)
  })

  it('probes without the injected prober only through the real one — never in these tests', async () => {
    // The deps default is the network prober; every World here injects a
    // stub, and the fixture-backed runs above prove the engine calls it.
    const world = new World({ maxRounds: 1, targetNew: 100 })
    world.addRun('run-1')
    const deps = depsFor(world)
    const probe = vi.fn(async () => ({ status: 'live' as const, reason: null }))
    await executeDiscoveryRun({ ...deps, probeDomain: probe }, ARGS)
    expect(probe).toHaveBeenCalled()
  })
})
