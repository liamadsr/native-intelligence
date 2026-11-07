/**
 * Tests for seedDefaultLoops (GEN-148) — the out-of-box loop seeder.
 *
 * The seeder is dependency-injected with the service client, so these tests
 * pass a purpose-built chainable mock that:
 *   - controls the `flow`.select result (which loops already exist) and the
 *     `recipe`.select result (which skill slugs resolve to ids), and
 *   - captures the `flow`.insert payload so we can assert the exact rows seeded.
 *
 * The invariants under test:
 *   - the seed set is Triage alone: enabled, event-driven, the closed loop
 *   - Weekly groom, Commitment reconciler and Morning brief are never seeded
 *   - idempotency: an already-seeded workspace inserts nothing
 *   - a missing skill is skipped, not fatal
 *   - the row carries workspace_id + created_by + seed_key and is team-less.
 */
import { describe, it, expect, vi } from 'vitest'
import { seedDefaultLoops, SEED_KEYS } from '../seed-default-loops'
import type { RunSkillActionConfig } from '../types'

// The groom/reconcile/brief skills still exist in the library (on-demand
// skills); resolving them must not make the seeder seed their loops.
const ALL_SKILLS = [
  { id: 'skill-triage', slug: 'triage' },
  { id: 'skill-groom', slug: 'groom' },
  { id: 'skill-reconcile', slug: 'reconcile' },
  { id: 'skill-brief', slug: 'brief' },
]

interface MockOpts {
  /**
   * seed_keys already present on the `flow` table (the idempotency baseline).
   * The mock models a plain INSERT against the PARTIAL unique index: inserting a
   * row whose seed_key is already here raises 23505 (unique_violation) — exactly
   * as the real DB would, so the seeder's 23505-catch path is exercised.
   */
  existingSeedKeys?: string[]
  /** Rows returned by the `recipe`.select (slug → id resolution). */
  skills?: Array<{ id: string; slug: string }>
  /** Force an error on a given query. */
  errorOn?: { table: 'flow-select' | 'recipe' | 'insert'; message: string }
}

/**
 * A table-aware, minimally STATEFUL chainable mock. The `flow` table holds a
 * live `present` set of seed_keys so that:
 *   - the step-1 `.select('seed_key').not('seed_key','is',null)` reflects it,
 *   - `.insert(rows).select()` models the PARTIAL unique index: any row whose
 *     seed_key is already present raises 23505 (matching Postgres); otherwise
 *     the rows are added and their seed_keys returned.
 * This is what makes the suite guard the real insert/conflict path instead of
 * rubber-stamping any query (the defect the prior mock had).
 */
function makeService(opts: MockOpts = {}) {
  const captured: { insertRows?: Array<Record<string, unknown>> } = {}
  const present = new Set(opts.existingSeedKeys ?? [])

  const from = vi.fn((table: string) => {
    if (table === 'recipe') {
      const result =
        opts.errorOn?.table === 'recipe'
          ? { data: null, error: { message: opts.errorOn.message } }
          : { data: opts.skills ?? ALL_SKILLS, error: null }
      const chain: Record<string, unknown> = {}
      const passthrough = () => chain
      for (const m of ['select', 'eq', 'in']) chain[m] = vi.fn(passthrough)
      chain.then = (res: (r: unknown) => unknown) => Promise.resolve(result).then(res)
      return chain
    }

    // table === 'flow' — the SELECT shape (existing guard + post-23505 re-read)
    // and the INSERT shape.
    const chain: Record<string, unknown> = {}
    const passthrough = () => chain
    for (const m of ['select', 'eq', 'not']) chain[m] = vi.fn(passthrough)

    // SELECT path: thenable resolving to the current `present` set. Both the
    // step-1 read and the post-conflict re-read land here.
    chain.then = (res: (r: unknown) => unknown) => {
      const result =
        opts.errorOn?.table === 'flow-select'
          ? { data: null, error: { message: opts.errorOn.message } }
          : { data: [...present].map((k) => ({ seed_key: k })), error: null }
      return Promise.resolve(result).then(res)
    }

    // INSERT path: capture rows, model the partial unique index.
    chain.insert = vi.fn((rows: Array<Record<string, unknown>>) => {
      captured.insertRows = rows
      const conflicting = rows.some((r) => present.has(r.seed_key as string))
      const result =
        opts.errorOn?.table === 'insert'
          ? { data: null, error: { message: opts.errorOn.message, code: undefined } }
          : conflicting
            ? { data: null, error: { message: 'duplicate key value', code: '23505' } }
            : (() => {
                for (const r of rows) present.add(r.seed_key as string)
                return { data: rows.map((r) => ({ seed_key: r.seed_key })), error: null }
              })()
      return {
        select: vi.fn(() => ({
          then: (res: (r: unknown) => unknown) => Promise.resolve(result).then(res),
        })),
      }
    })

    return chain
  })

  return { service: { from } as never, captured, from, present }
}

/**
 * A `flow` mock that models the concurrent-seed TOCTOU: the FIRST flow.select
 * (step-1 read) returns empty, the insert raises 23505 (a racer committed in
 * the gap), and the SECOND flow.select (post-conflict re-read) returns the
 * raced keys. Recipe resolves all skills normally.
 */
function makeRaceService() {
  const raced = [SEED_KEYS.triage]
  let flowSelectCount = 0

  const from = vi.fn((table: string) => {
    if (table === 'recipe') {
      const chain: Record<string, unknown> = {}
      const passthrough = () => chain
      for (const m of ['select', 'eq', 'in']) chain[m] = vi.fn(passthrough)
      chain.then = (res: (r: unknown) => unknown) =>
        Promise.resolve({ data: ALL_SKILLS, error: null }).then(res)
      return chain
    }

    const chain: Record<string, unknown> = {}
    const passthrough = () => chain
    for (const m of ['select', 'eq', 'not']) chain[m] = vi.fn(passthrough)

    chain.then = (res: (r: unknown) => unknown) => {
      flowSelectCount += 1
      // 1st read: empty (pre-race). 2nd read (post-23505): the raced keys.
      const data =
        flowSelectCount === 1 ? [] : raced.map((k) => ({ seed_key: k }))
      return Promise.resolve({ data, error: null }).then(res)
    }

    chain.insert = vi.fn(() => ({
      select: vi.fn(() => ({
        then: (res: (r: unknown) => unknown) =>
          Promise.resolve({
            data: null,
            error: { message: 'duplicate key value violates unique constraint', code: '23505' },
          }).then(res),
      })),
    }))

    return chain
  })

  return { service: { from } as never, from }
}

const WS = 'ws-1'
const USER = 'user-1'

function runSkillConfig(row: Record<string, unknown>): RunSkillActionConfig {
  const actions = row.actions as Array<{ config: RunSkillActionConfig }>
  return actions[0].config
}

describe('seedDefaultLoops', () => {
  it('seeds Triage alone on a fresh workspace: enabled, event-driven', async () => {
    const { service, captured } = makeService()
    const res = await seedDefaultLoops(service, { workspaceId: WS, createdByUserId: USER })

    expect(res).toEqual({ seeded: [SEED_KEYS.triage], alreadyPresent: [], skippedMissingSkill: [] })
    const rows = captured.insertRows!
    expect(rows).toHaveLength(1)
    const triage = rows[0]
    expect(triage.seed_key).toBe('seed:triage')
    expect(triage.name).toBe('Triage after every capture')
    expect(triage.enabled).toBe(true)
    expect(triage.trigger_type).toBe('capture_processed')
    expect(triage.trigger_config).toEqual({ kind: 'capture_processed' })
    expect(triage.next_run_at).toBeNull()
  })

  it('never seeds Weekly groom, Commitment reconciler or Morning brief', async () => {
    const { service, captured, from } = makeService()
    await seedDefaultLoops(service, { workspaceId: WS, createdByUserId: USER })
    const keys = captured.insertRows!.map((r) => r.seed_key)
    for (const gone of ['seed:groom', 'seed:reconcile', 'seed:brief']) expect(keys).not.toContain(gone)
    // Only Triage's skill is even looked up.
    const recipeCall = from.mock.results.find((_r, i) => from.mock.calls[i][0] === 'recipe')!
    const chain = recipeCall.value as { in: ReturnType<typeof vi.fn> }
    expect(chain.in.mock.calls[0][1]).toEqual(['triage'])
  })

  it('is team-less, stamped with ids, and runs the closed loop', async () => {
    const { service, captured } = makeService()
    await seedDefaultLoops(service, { workspaceId: WS, createdByUserId: USER })
    const row = captured.insertRows![0]
    expect(row.workspace_id).toBe(WS)
    expect(row.created_by).toBe(USER)
    expect(row.team_id).toBeNull()

    const cfg = runSkillConfig(row)
    expect(cfg.skill_id).toBe('skill-triage')
    // The closed loop (E2): act mode, auto_apply gated on explicitness by the
    // verdict-apply trust gate, external side effects forced off, cards not doc.
    expect(cfg.mode).toBe('act')
    expect(cfg.trust).toEqual({ auto_apply: true, min_confidence: 0.85, allow_external: false, max_cards_per_run: 3 })
    expect(cfg.deliver).toEqual({ document: false, notification: true })
  })

  it('stamps NO model on the seeded loop — the server picks the model per run', async () => {
    const { service, captured } = makeService()
    await seedDefaultLoops(service, { workspaceId: WS, createdByUserId: USER })
    expect('model' in runSkillConfig(captured.insertRows![0])).toBe(false)
  })

  it('is idempotent: an already-seeded workspace inserts nothing and skips the skill lookup', async () => {
    const { service, captured, from } = makeService({ existingSeedKeys: [SEED_KEYS.triage] })
    const res = await seedDefaultLoops(service, { workspaceId: WS, createdByUserId: USER })

    expect(res.seeded).toEqual([])
    expect(res.alreadyPresent).toEqual([SEED_KEYS.triage])
    expect(captured.insertRows).toBeUndefined()
    expect(from).not.toHaveBeenCalledWith('recipe')
  })

  it('a workspace holding an old seeded loop (groom, brief, reconcile) still gets Triage', async () => {
    const { service, captured } = makeService({ existingSeedKeys: ['seed:groom', 'seed:brief'] })
    const res = await seedDefaultLoops(service, { workspaceId: WS, createdByUserId: USER })
    expect(res.seeded).toEqual([SEED_KEYS.triage])
    expect(res.alreadyPresent).toEqual([])
    expect(captured.insertRows!.map((r) => r.seed_key)).toEqual([SEED_KEYS.triage])
  })

  it('skips Triage when its skill does not resolve — not fatal', async () => {
    const { service, captured } = makeService({ skills: [{ id: 'skill-brief', slug: 'brief' }] })
    const res = await seedDefaultLoops(service, { workspaceId: WS, createdByUserId: USER })
    expect(res.seeded).toEqual([])
    expect(res.skippedMissingSkill).toEqual([SEED_KEYS.triage])
    expect(captured.insertRows).toBeUndefined()
  })

  it('swallows a 23505 unique-violation as a lost concurrent-seed race (never throws)', async () => {
    // The TOCTOU: the step-1 read saw an EMPTY workspace, but a concurrent
    // seeder committed Triage in the gap. The partial unique index rejects the
    // insert with 23505. The seeder must catch it, re-read, and report the
    // now-present key as alreadyPresent — never throw.
    const svc = makeRaceService()
    const res = await seedDefaultLoops(svc.service, { workspaceId: WS, createdByUserId: USER })
    expect(res.alreadyPresent).toEqual([SEED_KEYS.triage])
    expect(res.seeded).toEqual([])
  })

  it('throws on an unexpected DB error (so the caller logs + workspace still created)', async () => {
    const { service } = makeService({ errorOn: { table: 'flow-select', message: 'connection reset' } })
    await expect(seedDefaultLoops(service, { workspaceId: WS, createdByUserId: USER })).rejects.toThrow(
      /connection reset/,
    )
  })

  it('throws on a failed skill lookup', async () => {
    const { service } = makeService({ errorOn: { table: 'recipe', message: 'recipe read failed' } })
    await expect(seedDefaultLoops(service, { workspaceId: WS, createdByUserId: USER })).rejects.toThrow(
      /recipe read failed/,
    )
  })

  it('propagates a non-conflict insert error (not a 23505 race)', async () => {
    const { service } = makeService({ errorOn: { table: 'insert', message: 'permission denied for table flow' } })
    await expect(seedDefaultLoops(service, { workspaceId: WS, createdByUserId: USER })).rejects.toThrow(
      /permission denied/,
    )
  })
})
