/**
 * Tests for EDITION DEFAULT AGENTS — the resolver that turns an edition's
 * declared persona slug into a real `recipe` row.
 *
 * The thing under test is almost entirely FAIL-OPEN behavior, so that is what
 * these pin. A default agent is a PREFERENCE: an edition with no opinion, a
 * workspace that opted out, an environment whose seeding migration has not run,
 * an unreadable settings blob, a thrown query — every one of them must produce
 * `null`, which every caller treats as today's exact behavior (live = the
 * client-side Interactive Assistant, batch = the built-in ASSISTANT_PERSONA).
 * A preference that can BLOCK extraction is a bug, not a feature (manifest
 * invariant 2).
 *
 * The one case that is NOT tested here is "an explicit recipe_id wins": the
 * resolver is never called on that path at all — the live-agent route's
 * else-branch is the enforcement, and it is asserted structurally at the bottom
 * of this file.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSupabaseMock, type SupabaseResult } from '@/test/supabase-mock'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  normalizeDefaultAgentOverrides,
  resolveDefaultAgentSlugFromSettings,
  loadSystemRecipeBySlug,
  resolveDefaultRecipeForCapture,
  resolveBatchHandoffAgentId,
} from '../default-agent'

const WS = 'ws-1'

const SALES_LIVE_ROW = {
  id: 'rec-sales-live',
  system_prompt: 'You coach the rep mid-call.',
  agent_config: { enabled_tools: ['list_contacts'] },
  model: 'deepseek-v4-flash',
}

function db(tables: Record<string, SupabaseResult>) {
  return createSupabaseMock({ tables }) as unknown as SupabaseClient
}

// ── normalizeDefaultAgentOverrides ─────────────────────────────────────────
describe('normalizeDefaultAgentOverrides', () => {
  it('degrades every shape of garbage to "no override"', () => {
    expect(normalizeDefaultAgentOverrides(null)).toEqual({})
    expect(normalizeDefaultAgentOverrides(undefined)).toEqual({})
    expect(normalizeDefaultAgentOverrides(42)).toEqual({})
    expect(normalizeDefaultAgentOverrides('sales-live')).toEqual({})
    expect(normalizeDefaultAgentOverrides([])).toEqual({})
  })

  it('keeps a slug per mode, trimmed', () => {
    expect(normalizeDefaultAgentOverrides({ live: ' my-agent ', batch: 'other' })).toEqual({
      live: 'my-agent',
      batch: 'other',
    })
  })

  it('PRESERVES an explicit null — it is the opt-out, not an absent key', () => {
    const got = normalizeDefaultAgentOverrides({ live: null })
    expect('live' in got).toBe(true)
    expect(got.live).toBeNull()
    expect('batch' in got).toBe(false)
  })

  it('drops keys that express no intent (wrong type, empty string)', () => {
    expect(normalizeDefaultAgentOverrides({ live: 7, batch: '' })).toEqual({})
    expect(normalizeDefaultAgentOverrides({ live: {}, batch: '   ' })).toEqual({})
  })

  it('ignores unknown modes', () => {
    expect(normalizeDefaultAgentOverrides({ live: 'a', hybrid: 'b' })).toEqual({ live: 'a' })
  })
})

// ── resolveDefaultAgentSlugFromSettings (PURE) ─────────────────────────────
describe('resolveDefaultAgentSlugFromSettings', () => {
  it('no settings at all → no default (today’s behavior)', () => {
    for (const blob of [null, undefined, 42, 'nope', {}]) {
      expect(resolveDefaultAgentSlugFromSettings(blob, 'live')).toBeNull()
      expect(resolveDefaultAgentSlugFromSettings(blob, 'batch')).toBeNull()
    }
  })

  it('a sales workspace gets its edition’s per-mode slugs', () => {
    expect(resolveDefaultAgentSlugFromSettings({ edition: 'sales' }, 'live')).toBe('sales-live')
    expect(resolveDefaultAgentSlugFromSettings({ edition: 'sales' }, 'batch')).toBe(
      'sales-post-call',
    )
  })

  it('full / notes / brain declare no default', () => {
    for (const edition of ['full', 'notes', 'brain']) {
      expect(resolveDefaultAgentSlugFromSettings({ edition }, 'live')).toBeNull()
      expect(resolveDefaultAgentSlugFromSettings({ edition }, 'batch')).toBeNull()
    }
  })

  it('a garbage edition degrades to full ⇒ no default, never a throw', () => {
    expect(resolveDefaultAgentSlugFromSettings({ edition: 'enterprise' }, 'live')).toBeNull()
    expect(resolveDefaultAgentSlugFromSettings({ edition: 7 }, 'batch')).toBeNull()
  })

  it('the workspace override is checked BEFORE the edition default', () => {
    const settings = { edition: 'sales', default_agents: { live: 'my-own-agent' } }
    expect(resolveDefaultAgentSlugFromSettings(settings, 'live')).toBe('my-own-agent')
    // …and only for the mode it names: batch still follows the edition.
    expect(resolveDefaultAgentSlugFromSettings(settings, 'batch')).toBe('sales-post-call')
  })

  it('an explicit null override OPTS OUT of the edition’s opinion', () => {
    const settings = { edition: 'sales', default_agents: { live: null, batch: null } }
    expect(resolveDefaultAgentSlugFromSettings(settings, 'live')).toBeNull()
    expect(resolveDefaultAgentSlugFromSettings(settings, 'batch')).toBeNull()
  })

  it('an ABSENT override follows the edition — not the same as a null one', () => {
    expect(
      resolveDefaultAgentSlugFromSettings({ edition: 'sales', default_agents: {} }, 'live'),
    ).toBe('sales-live')
  })

  it('an override can give a no-opinion edition a default', () => {
    const settings = { edition: 'notes', default_agents: { batch: 'house-style' } }
    expect(resolveDefaultAgentSlugFromSettings(settings, 'batch')).toBe('house-style')
    expect(resolveDefaultAgentSlugFromSettings(settings, 'live')).toBeNull()
  })

  it('a garbage override blob is ignored, leaving the edition default intact', () => {
    const settings = { edition: 'sales', default_agents: 'nonsense' }
    expect(resolveDefaultAgentSlugFromSettings(settings, 'live')).toBe('sales-live')
  })

  it('feature overrides on the same blob do not disturb the default agent', () => {
    const settings = { edition: 'sales', feature_overrides: { crm: 'off' } }
    expect(resolveDefaultAgentSlugFromSettings(settings, 'live')).toBe('sales-live')
  })
})

// ── loadSystemRecipeBySlug ─────────────────────────────────────────────────
describe('loadSystemRecipeBySlug', () => {
  it('returns the row’s four fields when a system recipe matches', async () => {
    const got = await loadSystemRecipeBySlug(
      db({ recipe: { data: SALES_LIVE_ROW, error: null } }),
      'sales-live',
    )
    expect(got).toEqual({
      id: 'rec-sales-live',
      system_prompt: 'You coach the rep mid-call.',
      agent_config: { enabled_tools: ['list_contacts'] },
      model: 'deepseek-v4-flash',
    })
  })

  it('MISSING ROW → null (an unseeded environment is not an error)', async () => {
    expect(
      await loadSystemRecipeBySlug(db({ recipe: { data: null, error: null } }), 'sales-live'),
    ).toBeNull()
  })

  it('normalizes absent optional columns to null rather than undefined', async () => {
    const got = await loadSystemRecipeBySlug(
      db({ recipe: { data: { id: 'r1' }, error: null } }),
      'x',
    )
    expect(got).toEqual({ id: 'r1', system_prompt: null, agent_config: null, model: null })
  })

  it('scopes the lookup to SEEDED SYSTEM rows so a workspace recipe cannot hijack a slug', async () => {
    const eq = vi.fn()
    const is = vi.fn()
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'limit']) chain[m] = vi.fn(() => chain)
    chain.eq = vi.fn((...args: unknown[]) => {
      eq(...args)
      return chain
    })
    chain.is = vi.fn((...args: unknown[]) => {
      is(...args)
      return chain
    })
    chain.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }))
    const supabase = { from: vi.fn(() => chain) } as unknown as SupabaseClient

    await loadSystemRecipeBySlug(supabase, 'sales-live')
    expect(eq).toHaveBeenCalledWith('slug', 'sales-live')
    expect(eq).toHaveBeenCalledWith('is_system', true)
    expect(is).toHaveBeenCalledWith('workspace_id', null)
  })

  it('a THROWN query is swallowed → null, never a rejected promise', async () => {
    const supabase = {
      from: () => {
        throw new Error('network down')
      },
    } as unknown as SupabaseClient
    await expect(loadSystemRecipeBySlug(supabase, 'sales-live')).resolves.toBeNull()
  })
})

// ── resolveDefaultRecipeForCapture ─────────────────────────────────────────
describe('resolveDefaultRecipeForCapture', () => {
  it('sales + a seeded row → the recipe, per mode', async () => {
    const supabase = db({ recipe: { data: SALES_LIVE_ROW, error: null } })
    for (const mode of ['live', 'batch'] as const) {
      const got = await resolveDefaultRecipeForCapture({
        supabase,
        workspaceId: WS,
        mode,
        settings: { edition: 'sales' },
      })
      expect(got?.id).toBe('rec-sales-live')
    }
  })

  it('NO EDITION DEFAULT → null WITHOUT touching the recipe table', async () => {
    const from = vi.fn()
    const supabase = { from } as unknown as SupabaseClient
    const got = await resolveDefaultRecipeForCapture({
      supabase,
      workspaceId: WS,
      mode: 'live',
      settings: { edition: 'full' },
    })
    expect(got).toBeNull()
    // The null-slug short-circuit is the point: an edition with no opinion must
    // cost no query at all, on a route that fires every ~3s during a recording.
    expect(from).not.toHaveBeenCalled()
  })

  it('MISSING SEED ROW → null (fails open to today’s behavior)', async () => {
    const got = await resolveDefaultRecipeForCapture({
      supabase: db({ recipe: { data: null, error: null } }),
      workspaceId: WS,
      mode: 'batch',
      settings: { edition: 'sales' },
    })
    expect(got).toBeNull()
  })

  it('NO SETTINGS blob passed → reads the workspace row itself', async () => {
    const supabase = db({
      workspace: { data: { settings: { edition: 'sales' } }, error: null },
      recipe: { data: SALES_LIVE_ROW, error: null },
    })
    const got = await resolveDefaultRecipeForCapture({ supabase, workspaceId: WS, mode: 'live' })
    expect(got?.id).toBe('rec-sales-live')
  })

  it('an UNREADABLE workspace (no row) still resolves — to the full default, null', async () => {
    const got = await resolveDefaultRecipeForCapture({
      supabase: db({ workspace: { data: null, error: null }, recipe: { data: null, error: null } }),
      workspaceId: WS,
      mode: 'live',
    })
    expect(got).toBeNull()
  })

  it('an explicit null OVERRIDE beats the edition — null, and no recipe query', async () => {
    const from = vi.fn()
    const supabase = { from } as unknown as SupabaseClient
    const got = await resolveDefaultRecipeForCapture({
      supabase,
      workspaceId: WS,
      mode: 'live',
      settings: { edition: 'sales', default_agents: { live: null } },
    })
    expect(got).toBeNull()
    expect(from).not.toHaveBeenCalled()
  })

  it('a slug OVERRIDE is what gets looked up, not the edition’s slug', async () => {
    const eq = vi.fn()
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'limit', 'is']) chain[m] = vi.fn(() => chain)
    chain.eq = vi.fn((...args: unknown[]) => {
      eq(...args)
      return chain
    })
    chain.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }))
    const supabase = { from: vi.fn(() => chain) } as unknown as SupabaseClient

    await resolveDefaultRecipeForCapture({
      supabase,
      workspaceId: WS,
      mode: 'batch',
      settings: { edition: 'sales', default_agents: { batch: 'house-style' } },
    })
    expect(eq).toHaveBeenCalledWith('slug', 'house-style')
    expect(eq).not.toHaveBeenCalledWith('slug', 'sales-post-call')
  })

  it('a THROWN query anywhere is swallowed → null', async () => {
    const supabase = {
      from: () => {
        throw new Error('boom')
      },
    } as unknown as SupabaseClient
    await expect(
      resolveDefaultRecipeForCapture({
        supabase,
        workspaceId: WS,
        mode: 'live',
        settings: { edition: 'sales' },
      }),
    ).resolves.toBeNull()
  })
})

// ── Structural: the resolver must never reach an eval run ───────────────
//
// An eval run must grade the agent its suite named — and when the suite named
// NOTHING, the built-in ASSISTANT_PERSONA that start-run.ts snapshotted an
// all-null prompt hash for. Two independent guards in the cloud route enforce
// that, and BOTH are structural (a unit test of the resolver sees neither):
//
//   1. The `else` of `if (recipe_id)` — an explicit target short-circuits.
//   2. `!isEvalCapture` — `eval_suite.target_recipe_id` is NULLABLE (and is
//      SET NULL when the targeted recipe is deleted), and run-trial.ts posts
//      `recipe_id: args.recipeId ?? undefined`, so a baseline suite reaches
//      the else-branch with no recipe_id at all. Without this guard a sales
//      workspace would silently grade `sales-post-call` against that null
//      hash.
//
// So assert the shape of the call sites; a refactor that drops either guard
// fails here.
describe('explicit recipe_id short-circuits the default (structural)', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

  // The cloud route and the eve spec route share ONE persona resolver
  // (resolveLiveAgentPersona in turn-composition.ts): the route resolves the
  // turn's persona for pair_notes + the usage row's model, the spec route for
  // the prompt/ceiling/model the eve session runs. So the structural guards
  // are pinned on that function, and both callers are pinned to it.
  const RESOLVER = 'src/lib/live-agent/turn-composition.ts'
  const resolverBody = () => {
    const src = read(RESOLVER)
    const start = src.indexOf('export async function resolveLiveAgentPersona(')
    expect(start, 'resolveLiveAgentPersona moved or was renamed').toBeGreaterThan(-1)
    const end = src.indexOf('\n}\n', start)
    return src.slice(start, end)
  }

  it('the cloud live-agent persona resolves the default only in the else-branch', () => {
    const src = resolverBody()
    // The PERSONA-selection resolution is inside the else-branch that follows
    // the `if (recipeId) {` lookup. There are exactly TWO call sites and the
    // other one is deliberate and different: the safety net for every turn
    // that WRITES the record (`if (writesRecord && isAssistOnlyAgent(...))` — a
    // batch run or a paired notes turn) re-resolves after REJECTING an
    // assist-only persona, which is a replacement, not a selection — see
    // assist-only.test.ts. Anything beyond those two is a regression.
    const calls = src.match(/resolveDefaultRecipeForCapture\(/g) ?? []
    expect(calls.length).toBe(2)
    expect(
      src.match(/if \(writesRecord && isAssistOnlyAgent\(recipe\?\.agent_config\)\) \{[\s\S]*?resolveDefaultRecipeForCapture\(/),
      'the second call site is not the assist-only safety net',
    ).not.toBeNull()
    const guard = src.match(
      /if \(recipeId\) \{[\s\S]*?\} else if \(!isEvalCapture\) \{[\s\S]*?resolveDefaultRecipeForCapture\(/,
    )
    expect(guard, 'resolveDefaultRecipeForCapture escaped the recipe_id else-branch').not.toBeNull()
  })

  it('the cloud live-agent persona never resolves a default for an EVAL capture', () => {
    // A suite with a null target posts no recipe_id, so the else-branch alone
    // does not protect it — the eval guard has to be on the branch itself.
    expect(
      resolverBody(),
      'the edition default is reachable on an eval run — a null-target suite would grade the wrong persona',
    ).toMatch(/\} else if \(!isEvalCapture\) \{/)
  })

  it('the cloud route passes the request’s mode through, to the SAME fenced resolver the eve spec uses', () => {
    // A paired notes turn (`writesRecord`) resolves the BATCH persona: it is
    // the record's writer, running during the call.
    expect(resolverBody()).toMatch(/mode: writesRecord \? 'batch' : 'live'/)
    const route = read('src/app/api/ai/live-agent/route.ts')
    expect(route).toMatch(/const writesRecord = isBatch \|\| notesRole/)
    // No second, inline copy of the resolution in the route…
    expect(route).not.toMatch(/resolveDefaultRecipeForCapture\(/)
    // …and the route's call carries the same recipe fence the spec's does (its
    // client is service-role for a device token).
    for (const file of ['src/app/api/ai/live-agent/route.ts', 'src/lib/live-agent/live-agent-spec.ts']) {
      expect(read(file), file).toMatch(
        /resolveLiveAgentPersona\(\{[\s\S]*?writesRecord,[\s\S]*?explicitRecipeVisibleTo: \{ userId: [\w.]+ \},?\s*\}\)/,
      )
    }
  })
})

/**
 * THE END-OF-CALL HANDOFF RULE.
 *
 * An edition declares two personas — one that speaks mid-call, one that writes
 * the finished record — but the client's agent selection is a single value that
 * the capture panel LOCKS to the live persona while live mode is on. These pin
 * the one thing that makes the handoff safe: the rule fires ONLY for a selection
 * that is the edition's live default (the lock's doing), and never touches a
 * selection the user made.
 */
describe('resolveBatchHandoffAgentId', () => {
  const agents = [
    { id: 'live-id', slug: 'sales-live' },
    { id: 'batch-id', slug: 'sales-post-call' },
    { id: 'pm-id', slug: 'project-manager' },
  ]
  const sales = { editionLiveAgentSlug: 'sales-live', editionBatchAgentSlug: 'sales-post-call' }

  it('swaps the edition LIVE default for its BATCH default', () => {
    expect(
      resolveBatchHandoffAgentId({ selectedAgentId: 'live-id', ...sales, agents }),
    ).toBe('batch-id')
  })

  it('keeps an explicit user pick — never overridden', () => {
    expect(
      resolveBatchHandoffAgentId({ selectedAgentId: 'pm-id', ...sales, agents }),
    ).toBe('pm-id')
  })

  it('keeps the batch default when it is already selected', () => {
    expect(
      resolveBatchHandoffAgentId({ selectedAgentId: 'batch-id', ...sales, agents }),
    ).toBe('batch-id')
  })

  it('passes "no selection" straight through', () => {
    expect(
      resolveBatchHandoffAgentId({ selectedAgentId: null, ...sales, agents }),
    ).toBeNull()
  })

  it('leaves the selection alone in an edition with no live opinion', () => {
    expect(
      resolveBatchHandoffAgentId({
        selectedAgentId: 'live-id',
        editionLiveAgentSlug: null,
        editionBatchAgentSlug: null,
        agents,
      }),
    ).toBe('live-id')
  })

  it('falls back to null (⇒ no recipe_id ⇒ server resolves) when the batch agent is not in the list', () => {
    // Unseeded environment, or the agents fetch has not landed yet. Sending the
    // LIVE persona would be worse than sending nothing.
    expect(
      resolveBatchHandoffAgentId({
        selectedAgentId: 'live-id',
        ...sales,
        agents: [{ id: 'live-id', slug: 'sales-live' }],
      }),
    ).toBeNull()
    expect(
      resolveBatchHandoffAgentId({
        selectedAgentId: 'live-id',
        editionLiveAgentSlug: 'sales-live',
        editionBatchAgentSlug: null,
        agents,
      }),
    ).toBeNull()
  })

  it('is inert when the selection merely SHARES no slug with the live default', () => {
    // An id that matches nothing in the list is a user pick we cannot classify;
    // leaving it alone is the fail-open answer.
    expect(
      resolveBatchHandoffAgentId({ selectedAgentId: 'unknown-id', ...sales, agents }),
    ).toBe('unknown-id')
  })
})

describe('the handoff rule is wired into every batch call site (structural)', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

  it('Reprocess resolves the handoff instead of sending the raw selection', () => {
    const src = read('src/app/account/(dashboard)/views/capture-detail-panel.tsx')
    expect(
      src,
      'Reprocess still sends recording.agentId directly — a live capture would re-run with the mid-call persona',
    ).not.toMatch(/mode: 'batch',\s*\n\s*recipeId: recording\.agentId \|\| undefined/)
    expect(src).toMatch(/resolveBatchHandoffAgentId\(\{/)
  })

  it('the capture panel marks live-lock selections as such', () => {
    const src = read('src/app/account/(dashboard)/views/capture-detail-panel.tsx')
    // One lock effect (the recording's edges and a late agent list alike), and
    // every setAgentId it makes is marked.
    const marked = src.match(/setAgentId\(liveLockAgent\.id, \{ fromLiveLock: true \}\)/g) || []
    const all = src.match(/setAgentId\(liveLockAgent\.id\b/g) || []
    expect(marked.length, 'the live lock no longer selects the live persona').toBe(1)
    expect(all.length, 'a live-lock selection is unmarked; the stop path would inherit it').toBe(marked.length)
  })

  it('the stop path routes both batch runs through batchRecipeId()', () => {
    const src = read('src/hooks/recording-context.tsx')
    expect(src).toMatch(/recipeId: batchRecipeId\(\)/)
    expect(src).toMatch(/runApiBatchExtraction\(cid, batchRecipeId\(\) \?\? null\)/)
    expect(
      src,
      'a batch call site still reads agentIdRef directly',
    ).not.toMatch(/recipeId: agentIdRef\.current \|\| undefined/)
  })
})
