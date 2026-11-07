/**
 * Tests for the SHARED feature-write helper (lib/editions/features.ts) — the
 * collapse/prune/write that both `/api/account/workspace/features` and
 * `/api/admin/workspaces/[id]/features` go through.
 *
 * The behaviors asserted here are the ones a divergence between those two routes
 * would break, so they are pinned at the helper rather than only through either
 * route:
 *  - AUTO-COLLAPSE: a state matching what the edition already gives deletes the
 *    key rather than storing it, so the workspace keeps following the preset.
 *    Every edition presets every feature now (manifest invariant 5), so an
 *    `on` always collapses and an `off` is what gets stored.
 *  - PRUNE of the whole map on every write: overrides interact through
 *    `requires`, so a key can become a no-op because a DIFFERENT key changed.
 *  - The READ and WRITE clients are distinct: the account route reads through
 *    the RLS-scoped session client and writes through a service client, because
 *    the workspace UPDATE policy is owner-only.
 *  - `.select('id')` row-count assert: a 0-row update is a failure, never a
 *    silent success.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  isOnByDefault,
  pruneNoOpOverrides,
  setWorkspaceFeatureState,
} from '../features'

let storedSettings: Record<string, unknown>
let writtenSettings: Record<string, unknown> | null
/** Which client the last update() went through — 'service' or 'session'. */
let writtenVia: string | null
let readVia: string | null
let readError: { message: string } | null
let writeError: { message: string } | null
/** Rows the update reports as affected. 0 models the RLS-blocked no-op. */
let updatedRows: { id: string }[]

function makeSupabase(kind: 'session' | 'service'): SupabaseClient {
  return {
    from() {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.update = (vals: { settings: Record<string, unknown> }) => {
        writtenSettings = vals.settings
        writtenVia = kind
        return {
          eq: () => ({
            select: async () => ({ data: updatedRows, error: writeError }),
          }),
        }
      }
      chain.eq = () => chain
      chain.maybeSingle = async () => {
        readVia = kind
        return readError
          ? { data: null, error: readError }
          : { data: { settings: storedSettings }, error: null }
      }
      return chain
    },
  } as unknown as SupabaseClient
}

/** The overrides map as actually persisted by the last write. */
function writtenOverrides() {
  return (writtenSettings as { feature_overrides?: Record<string, unknown> } | null)
    ?.feature_overrides
}

async function write(
  feature: Parameters<typeof setWorkspaceFeatureState>[0]['feature'],
  state: Parameters<typeof setWorkspaceFeatureState>[0]['state'],
) {
  return setWorkspaceFeatureState({
    read: makeSupabase('session'),
    write: makeSupabase('service'),
    workspaceId: 'ws-1',
    feature,
    state,
  })
}

beforeEach(() => {
  storedSettings = {}
  writtenSettings = null
  writtenVia = null
  readVia = null
  readError = null
  writeError = null
  updatedRows = [{ id: 'ws-1' }]
})

describe('setWorkspaceFeatureState — client split', () => {
  it('READS through the read client and WRITES through the write client', async () => {
    storedSettings = { edition: 'notes' }
    const res = await write('email', 'on')
    expect(res.ok).toBe(true)
    expect(readVia).toBe('session')
    expect(writtenVia).toBe('service')
  })

  it('accepts the SAME client for both — the admin caller passes one service client', async () => {
    storedSettings = { edition: 'notes' }
    const client = makeSupabase('service')
    const res = await setWorkspaceFeatureState({
      read: client,
      write: client,
      workspaceId: 'ws-1',
      feature: 'email',
      state: 'on',
    })
    expect(res.ok).toBe(true)
    expect(readVia).toBe('service')
    expect(writtenVia).toBe('service')
  })
})

describe('setWorkspaceFeatureState — auto-collapse', () => {
  it('COLLAPSES an `on` in every edition — every edition already gives every feature', async () => {
    for (const edition of ['full', 'sales', 'notes', 'brain']) {
      storedSettings = { edition }
      const res = await write('projects', 'on')
      expect(res).toMatchObject({ ok: true })
      expect(writtenOverrides(), edition).toEqual({})
      if (res.ok) expect(res.result.effectiveFeatures, edition).toBe('all')
    }
  })

  it('STORES an `off` in every edition', async () => {
    for (const edition of ['full', 'sales', 'notes', 'brain']) {
      storedSettings = { edition }
      const res = await write('email', 'off')
      expect(writtenOverrides(), edition).toEqual({ email: 'off' })
      if (res.ok) expect(res.result.effectiveFeatures, edition).not.toContain('email')
    }
  })

  it('evals and the browser collapse an `on` too — neither is opt-in any more', async () => {
    storedSettings = { edition: 'full' }
    await write('evals', 'on')
    expect(writtenOverrides()).toEqual({})
    await write('browser', 'on')
    expect(writtenOverrides()).toEqual({})
  })

  it('collapses correctly against the `all` edition in both directions', async () => {
    storedSettings = { edition: 'full' }
    await write('crm', 'on')
    expect(writtenOverrides()).toEqual({})
    await write('crm', 'off')
    expect(writtenOverrides()).toEqual({ crm: 'off' })
  })

  it('`default` always deletes the key, whichever way it was set', async () => {
    for (const state of ['on', 'off'] as const) {
      storedSettings = { edition: 'notes', feature_overrides: { email: state } }
      await write('email', 'default')
      expect(writtenOverrides()).toEqual({})
    }
  })

  it('leaves other features’ overrides alone', async () => {
    storedSettings = { edition: 'notes', feature_overrides: { crm: 'off', flows: 'off' } }
    await write('email', 'off')
    expect(writtenOverrides()).toEqual({ crm: 'off', flows: 'off', email: 'off' })
  })

  it('prunes a stored `on` left over from a preset that no longer needs it', async () => {
    // What a sales workspace had to store before every edition got every
    // feature: each key is a no-op now, and any write clears them all.
    storedSettings = {
      edition: 'sales',
      feature_overrides: { projects: 'on', flows: 'on', evals: 'on', browser: 'on' },
    }
    const res = await write('email', 'off')
    expect(writtenOverrides()).toEqual({ email: 'off' })
    if (res.ok) expect(res.result.effectiveFeatures).toContain('projects')
  })
})

describe('setWorkspaceFeatureState — pruning stranded overrides', () => {
  it('prunes a `sequences: off` that crm’s own off already implies', async () => {
    storedSettings = {
      edition: 'sales',
      feature_overrides: { crm: 'off', sequences: 'off' },
    }
    await write('sequences', 'default')
    expect(writtenOverrides()).toEqual({ crm: 'off' })
  })

  it('prunes a stranded key written by ANY client, not just the one being toggled', async () => {
    storedSettings = {
      edition: 'sales',
      feature_overrides: { crm: 'off', sequences: 'off' },
    }
    await write('docs', 'off')
    expect(writtenOverrides()).toEqual({ crm: 'off', docs: 'off' })
  })

  it('keeps a full workspace on the `all` sentinel once the last real off is gone', async () => {
    // A stranded key on `full` would keep effectiveFeatures an enumerated list
    // forever, silently freezing the tool ceiling against every category added
    // later.
    storedSettings = { edition: 'full', feature_overrides: { crm: 'off' } }
    const res = await write('crm', 'default')
    expect(writtenOverrides()).toEqual({})
    expect(res).toMatchObject({ ok: true })
    if (res.ok) expect(res.result.effectiveFeatures).toBe('all')
  })

  it('never prunes a key that IS load-bearing', async () => {
    storedSettings = { edition: 'sales', feature_overrides: { crm: 'off' } }
    await write('projects', 'off')
    expect(writtenOverrides()).toEqual({ crm: 'off', projects: 'off' })
  })
})

describe('setWorkspaceFeatureState — settings blob and failure modes', () => {
  it('preserves every other settings key, edition included', async () => {
    storedSettings = { edition: 'notes', trust_policy: { enabled: false }, keep: 'me' }
    await write('email', 'off')
    expect(writtenSettings).toEqual({
      edition: 'notes',
      trust_policy: { enabled: false },
      keep: 'me',
      feature_overrides: { email: 'off' },
    })
  })

  it('drops pre-existing garbage from the overrides map on write', async () => {
    storedSettings = {
      edition: 'notes',
      feature_overrides: { email: 'off', bogus: 'on', core: 'off', crm: 'perhaps' },
    }
    await write('flows', 'off')
    expect(writtenOverrides()).toEqual({ email: 'off', flows: 'off' })
  })

  it('propagates a read failure rather than failing open', async () => {
    readError = { message: 'rls' }
    const res = await write('email', 'on')
    expect(res).toEqual({ ok: false, error: 'rls' })
    expect(writtenSettings).toBeNull()
  })

  it('propagates a write failure — the caller must learn it did not save', async () => {
    writeError = { message: 'denied' }
    const res = await write('email', 'on')
    expect(res).toEqual({ ok: false, error: 'denied' })
  })

  it('fails a 0-row update instead of reporting a toggle that was never stored', async () => {
    updatedRows = []
    storedSettings = { edition: 'notes' }
    const res = await write('email', 'on')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/affected no rows/)
  })
})

describe('isOnByDefault', () => {
  it('is true for every feature in every edition', () => {
    for (const edition of ['full', 'sales', 'notes', 'brain'] as const) {
      for (const feature of ['email', 'crm', 'sequences', 'projects', 'evals', 'browser'] as const) {
        expect(isOnByDefault(feature, edition), `${edition}/${feature}`).toBe(true)
      }
    }
  })
})

describe('pruneNoOpOverrides', () => {
  it('drops exactly one of a mutually-redundant pair, never both', () => {
    // Dropping both would change the effective outcome; dropping neither would
    // strand a key. Whichever survives, the outcome must be identical.
    const pruned = pruneNoOpOverrides('full', { crm: 'off', sequences: 'off' })
    expect(Object.keys(pruned)).toEqual(['crm'])
  })

  it('is a no-op on an empty map and on a fully load-bearing one', () => {
    expect(pruneNoOpOverrides('full', {})).toEqual({})
    expect(pruneNoOpOverrides('notes', { email: 'off', projects: 'off' })).toEqual({
      email: 'off',
      projects: 'off',
    })
  })

  it('drops every `on`: no edition leaves a feature for one to add', () => {
    expect(pruneNoOpOverrides('sales', { projects: 'on', evals: 'on', email: 'off' })).toEqual({
      email: 'off',
    })
  })
})
