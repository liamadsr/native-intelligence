/**
 * Tests for edition resolution + storage, mirroring the trust-policy resolve
 * tests: fail-open reads that never throw, plus the two write semantics that
 * make attribution safe — first-write-wins for the signup stamp, unconditional
 * overwrite for the settings switcher — and the read-modify-write that keeps
 * every other `settings` key (notably trust_policy) intact.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  adoptBusinessEdition,
  resolveWorkspaceEdition,
  resolveWorkspaceEditionFromSettings,
  resolveWorkspaceEditionId,
  setWorkspaceEdition,
  stampWorkspaceEdition,
} from '../resolve'
import { EDITIONS } from '../manifest'
import { computeEditionToolCeiling } from '../tool-ceiling'

const WS = 'ws-1'

/**
 * A supabase stub covering both chains this module uses:
 *   .from('workspace').select('settings').eq(...).maybeSingle()
 *   .from('workspace').update({ settings }).eq(...).select('id')
 * `updates` records every settings blob written, so the tests can assert the
 * read-modify-write preserved unrelated keys.
 *
 * The write chain ends in `.select('id')` because both writers ASSERT their
 * effect: the workspace UPDATE policy is owner-only, so a 0-row update is a
 * real failure mode that reports no error. `updatedRows: []` models it.
 */
function stubClient(opts: {
  settings?: unknown
  readError?: { message: string }
  writeError?: { message: string }
  throws?: boolean
  /** Rows the update reports as affected; `[]` is the RLS-blocked no-op. */
  updatedRows?: { id: string }[]
} = {}) {
  const updates: Record<string, unknown>[] = []

  const maybeSingle = vi.fn(async () => {
    if (opts.throws) throw new Error('boom')
    if (opts.readError) return { data: null, error: opts.readError }
    return { data: { settings: opts.settings ?? {} }, error: null }
  })

  const from = vi.fn(() => ({
    select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })),
    update: vi.fn((payload: { settings: Record<string, unknown> }) => {
      updates.push(payload.settings)
      return {
        eq: vi.fn(() => ({
          select: vi.fn(async () => {
            if (opts.throws) throw new Error('boom')
            return {
              data: opts.updatedRows ?? [{ id: WS }],
              error: opts.writeError ?? null,
            }
          }),
        })),
      }
    }),
  }))

  return { client: { from } as unknown as SupabaseClient, updates }
}

describe('resolveWorkspaceEdition', () => {
  it('reads a stamped edition and marks it explicit', async () => {
    const { client } = stubClient({ settings: { edition: 'sales' } })
    const got = await resolveWorkspaceEdition(client, WS)
    expect(got.id).toBe('sales')
    // Structural, not referential: the resolved edition is now the manifest
    // entry with its EFFECTIVE surface composed in, so it is an equal object
    // rather than the same one. With no overrides stored, equal is the whole
    // point — an untouched workspace resolves to exactly its manifest entry.
    expect(got.edition).toEqual(EDITIONS.sales)
    expect(got.explicit).toBe(true)
  })

  it('returns non-explicit full when settings has no edition key', async () => {
    const { client } = stubClient({ settings: { trust_policy: { enabled: true } } })
    const got = await resolveWorkspaceEdition(client, WS)
    expect(got.id).toBe('full')
    expect(got.explicit).toBe(false)
  })

  it('treats a garbage edition value as NON-explicit full (a stamp may still claim it)', async () => {
    for (const junk of ['enterprise', 42, null, {}, '']) {
      const { client } = stubClient({ settings: { edition: junk } })
      const got = await resolveWorkspaceEdition(client, WS)
      expect(got.id).toBe('full')
      expect(got.explicit).toBe(false)
    }
  })

  it('fails open to non-explicit full on a query error (never throws)', async () => {
    const { client } = stubClient({ readError: { message: 'rls' } })
    const got = await resolveWorkspaceEdition(client, WS)
    expect(got.id).toBe('full')
    expect(got.explicit).toBe(false)
  })

  it('fails open to non-explicit full when the client throws', async () => {
    const { client } = stubClient({ throws: true })
    const got = await resolveWorkspaceEdition(client, WS)
    expect(got.id).toBe('full')
    expect(got.explicit).toBe(false)
  })

  it('carries autoCreateEntities through for the auto-apply gate', async () => {
    const full = await resolveWorkspaceEdition(stubClient({ settings: { edition: 'full' } }).client, WS)
    expect(full.autoCreateEntities).toBe('all')

    const notes = await resolveWorkspaceEdition(stubClient({ settings: { edition: 'notes' } }).client, WS)
    expect(notes.autoCreateEntities).toBe('all')

    // A COPY, not the composed array — a consumer that mutates it must not be
    // able to retune the workspace for the whole process.
    const noCrm = await resolveWorkspaceEdition(
      stubClient({ settings: { edition: 'notes', feature_overrides: { crm: 'off' } } }).client,
      WS,
    )
    expect(noCrm.autoCreateEntities).not.toContain('contact')
    ;(noCrm.autoCreateEntities as string[]).push('contact')
    expect(noCrm.edition.autoCreateEntities).not.toContain('contact')
  })

  it('resolveWorkspaceEditionId returns just the id, same fail-open contract', async () => {
    await expect(
      resolveWorkspaceEditionId(stubClient({ settings: { edition: 'brain' } }).client, WS),
    ).resolves.toBe('brain')
    await expect(
      resolveWorkspaceEditionId(stubClient({ throws: true }).client, WS),
    ).resolves.toBe('full')
  })

  it('fails open when the workspace row is missing entirely', async () => {
    const maybeSingle = vi.fn(async () => ({ data: null, error: null }))
    const client = {
      from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })) })),
    } as unknown as SupabaseClient
    const got = await resolveWorkspaceEdition(client, WS)
    expect(got.id).toBe('full')
    expect(got.explicit).toBe(false)
  })
})

describe('stampWorkspaceEdition (first-write-wins)', () => {
  it('stamps an unclaimed workspace', async () => {
    const { client, updates } = stubClient({ settings: {} })
    await expect(stampWorkspaceEdition(client, WS, 'sales')).resolves.toEqual({
      stamped: true,
      edition: 'sales',
    })
    expect(updates).toEqual([{ edition: 'sales' }])
  })

  it('preserves every other settings key on write', async () => {
    const trust = { enabled: true, allow_external: false }
    const { client, updates } = stubClient({ settings: { trust_policy: trust, other: 1 } })
    await stampWorkspaceEdition(client, WS, 'notes')
    expect(updates[0]).toEqual({ trust_policy: trust, other: 1, edition: 'notes' })
  })

  it('does NOT overwrite an already-stamped workspace', async () => {
    const { client, updates } = stubClient({ settings: { edition: 'brain' } })
    await expect(stampWorkspaceEdition(client, WS, 'sales')).resolves.toEqual({
      stamped: false,
      reason: 'already-set',
    })
    expect(updates).toHaveLength(0)
  })

  it('CLAIMS a workspace whose stored edition is garbage', async () => {
    const { client, updates } = stubClient({ settings: { edition: 'enterprise' } })
    await expect(stampWorkspaceEdition(client, WS, 'sales')).resolves.toEqual({
      stamped: true,
      edition: 'sales',
    })
    expect(updates[0]).toEqual({ edition: 'sales' })
  })

  it('refuses an invalid incoming edition without touching the row', async () => {
    const { client, updates } = stubClient({ settings: {} })
    for (const junk of ['enterprise', '', null, undefined, 7]) {
      await expect(stampWorkspaceEdition(client, WS, junk)).resolves.toEqual({
        stamped: false,
        reason: 'invalid',
      })
    }
    expect(updates).toHaveLength(0)
  })

  it('never throws on a read error', async () => {
    const { client } = stubClient({ readError: { message: 'rls' } })
    await expect(stampWorkspaceEdition(client, WS, 'sales')).resolves.toEqual({
      stamped: false,
      reason: 'error',
    })
  })

  it('reports error, not success, when the update affects 0 rows', async () => {
    // Same silent-no-op hazard as setWorkspaceEdition: the owner-only UPDATE
    // policy makes a non-owner's write match nothing and report no error.
    // `stamped: true` there would be a lie recorded in analytics.
    const { client } = stubClient({ settings: {}, updatedRows: [] })
    await expect(stampWorkspaceEdition(client, WS, 'sales')).resolves.toEqual({
      stamped: false,
      reason: 'error',
    })
  })

  it('never throws on a write error', async () => {
    const { client } = stubClient({ settings: {}, writeError: { message: 'nope' } })
    await expect(stampWorkspaceEdition(client, WS, 'sales')).resolves.toEqual({
      stamped: false,
      reason: 'error',
    })
  })

  it('never throws when the client itself throws', async () => {
    const { client } = stubClient({ throws: true })
    await expect(stampWorkspaceEdition(client, WS, 'sales')).resolves.toEqual({
      stamped: false,
      reason: 'error',
    })
  })
})

describe('setWorkspaceEdition (unconditional overwrite)', () => {
  it('overwrites an existing edition — the settings escape hatch', async () => {
    const { client, updates } = stubClient({ settings: { edition: 'sales' } })
    await expect(setWorkspaceEdition(client, WS, 'notes')).resolves.toEqual({
      ok: true,
      edition: 'notes',
    })
    expect(updates[0]).toEqual({ edition: 'notes', edition_source: 'chosen' })
  })

  it('preserves every other settings key', async () => {
    const { client, updates } = stubClient({ settings: { trust_policy: { enabled: false } } })
    await setWorkspaceEdition(client, WS, 'brain')
    expect(updates[0]).toEqual({ trust_policy: { enabled: false }, edition: 'brain', edition_source: 'chosen' })
  })

  it('normalizes garbage to full rather than writing garbage into the jsonb', async () => {
    const { client, updates } = stubClient({ settings: {} })
    await expect(setWorkspaceEdition(client, WS, 'enterprise')).resolves.toEqual({
      ok: true,
      edition: 'full',
    })
    expect(updates[0]).toEqual({ edition: 'full', edition_source: 'chosen' })
  })

  it('propagates a read error to the caller (user-facing PATCH must report it)', async () => {
    const { client } = stubClient({ readError: { message: 'rls' } })
    await expect(setWorkspaceEdition(client, WS, 'sales')).resolves.toEqual({
      ok: false,
      error: 'rls',
    })
  })

  it('propagates a write error to the caller', async () => {
    const { client } = stubClient({ settings: {}, writeError: { message: 'denied' } })
    await expect(setWorkspaceEdition(client, WS, 'sales')).resolves.toEqual({
      ok: false,
      error: 'denied',
    })
  })

  it('FAILS a 0-row update rather than reporting a write that never happened', async () => {
    // The workspace UPDATE policy is owner-only, so an RLS-bound non-owner's
    // update matches nothing and postgrest reports NO error. Without the row
    // count the caller would 200 with an edition that was never stored — the
    // exact silent no-op this assertion exists to make loud.
    const { client } = stubClient({ settings: {}, updatedRows: [] })
    const result = await setWorkspaceEdition(client, WS, 'sales')
    expect(result.ok).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Feature overrides — resolution returns the EFFECTIVE surface, and does so
// under the manifest's own field names so no consumer needs a change.
// ───────────────────────────────────────────────────────────────────────────

describe('resolveWorkspaceEdition with feature_overrides', () => {
  it('with no overrides, resolves to the manifest edition unchanged', async () => {
    const { client } = stubClient({ settings: { edition: 'notes' } })
    const got = await resolveWorkspaceEdition(client, WS)
    expect(got.edition).toEqual(EDITIONS.notes)
    expect(got.overrides).toEqual({})
  })

  it('every edition resolves to the whole app, evals and the browser included', async () => {
    for (const edition of ['full', 'sales', 'notes', 'brain']) {
      const { client } = stubClient({ settings: { edition } })
      const got = await resolveWorkspaceEdition(client, WS)
      // Same field names the chat route / device-ask / verdict-apply already read.
      expect(got.edition.views, edition).toContain('mail')
      expect(got.edition.views, edition).toContain('projects')
      expect(got.edition.views, edition).toContain('evals')
      expect(got.edition.toolCategories, edition).toBe('all')
      // The edition IDENTITY is untouched: it is the persona.
      expect(got.id).toBe(edition)
    }
  })

  it('a stored `on` left by an old preset is harmless — the surface is the same', async () => {
    const { client } = stubClient({
      settings: { edition: 'sales', feature_overrides: { projects: 'on', evals: 'on' } },
    })
    const got = await resolveWorkspaceEdition(client, WS)
    expect(got.overrides).toEqual({ projects: 'on', evals: 'on' })
    expect(got.edition.toolCategories).toBe('all')
    expect(got.autoCreateEntities).toBe('all')
  })

  it('an `off` override narrows it, including the auto-create passthrough', async () => {
    const { client } = stubClient({
      settings: { edition: 'sales', feature_overrides: { crm: 'off', sequences: 'off' } },
    })
    const got = await resolveWorkspaceEdition(client, WS)
    expect(got.edition.views).not.toContain('contacts')
    expect(got.edition.toolCategories).not.toContain('contacts')
    expect(got.autoCreateEntities).not.toContain('contact')
    expect(got.autoCreateEntities).toContain('action')
  })

  it('full with no overrides keeps BOTH inherit-all sentinels', async () => {
    const { client } = stubClient({ settings: { edition: 'full' } })
    const got = await resolveWorkspaceEdition(client, WS)
    expect(got.edition.toolCategories).toBe('all')
    expect(got.autoCreateEntities).toBe('all')
    // The sentinel survives (a category added tomorrow is still inherited), and
    // with no hidden or opt-in feature it computes to no ceiling at all.
    expect(computeEditionToolCeiling(got.edition)).toBeNull()
  })

  it('full with an `off` override drops BOTH inherit-all sentinels', async () => {
    const { client } = stubClient({
      settings: { edition: 'full', feature_overrides: { email: 'off' } },
    })
    const got = await resolveWorkspaceEdition(client, WS)
    expect(got.edition.toolCategories).not.toBe('all')
    expect(got.autoCreateEntities).not.toBe('all')
  })

  it('full with an `off` override forces an EXPLICIT, narrowed ceiling', async () => {
    const { client } = stubClient({
      settings: { edition: 'full', feature_overrides: { email: 'off' } },
    })
    const got = await resolveWorkspaceEdition(client, WS)
    const ceiling = computeEditionToolCeiling(got.edition)
    expect(ceiling).not.toBeNull()
    expect(ceiling!.has('list_emails')).toBe(false)
    expect(ceiling!.has('create_project')).toBe(true)
  })

  it('an `off` takes its DEPENDENTS down too, and narrows the ceiling accordingly', async () => {
    // Flipped deliberately from the old resurrect semantics, where `sequences`
    // (still on) pulled crm back in through `requires` and the ceiling
    // collapsed back to inherit-all — leaving the user's `crm: 'off'` a
    // stranded key that nonetheless froze the tool ceiling into an enumerated
    // snapshot. Off wins: crm goes, sequences goes with it, and the ceiling
    // narrows to match what the workspace can actually reach.
    const { client } = stubClient({
      settings: { edition: 'full', feature_overrides: { crm: 'off' } },
    })
    const got = await resolveWorkspaceEdition(client, WS)
    expect(got.edition.views).not.toContain('contacts')
    expect(got.edition.views).not.toContain('sequences')
    const ceiling = computeEditionToolCeiling(got.edition)
    expect(ceiling).not.toBeNull()
    expect(ceiling!.has('list_contacts')).toBe(false)
    // Everything unrelated survives.
    expect(ceiling!.has('list_captures')).toBe(true)
  })

  it('`crm: off, sequences: on` keeps both off — never a surface the AI cannot operate', async () => {
    const { client } = stubClient({
      settings: { edition: 'notes', feature_overrides: { crm: 'off', sequences: 'on' } },
    })
    const got = await resolveWorkspaceEdition(client, WS)
    expect(got.edition.views).not.toContain('sequences')
    expect(got.edition.views).not.toContain('contacts')
    expect(got.edition.extraAllowedViews).not.toContain('companies')
    expect(got.autoCreateEntities).not.toContain('contact')
  })

  it('normalizes garbage overrides rather than throwing or honoring them', async () => {
    for (const junk of [42, 'crm', null, ['crm'], { wormhole: 'on' }, { crm: 'maybe' }]) {
      const { client } = stubClient({
        settings: { edition: 'notes', feature_overrides: junk },
      })
      const got = await resolveWorkspaceEdition(client, WS)
      expect(got.overrides).toEqual({})
      expect(got.edition).toEqual(EDITIONS.notes)
    }
  })

  it('ignores an attempt to switch the locked core feature off', async () => {
    const { client } = stubClient({
      settings: { edition: 'notes', feature_overrides: { core: 'off' } },
    })
    const got = await resolveWorkspaceEdition(client, WS)
    expect(got.overrides).toEqual({})
    expect(got.edition.views).toContain('captures')
  })

  it('applies overrides even when the edition value itself is garbage', async () => {
    // Overrides are keyed by FEATURE, not by edition: a workspace that turned
    // Email on meant it regardless of what its (unreadable) edition says.
    const { client } = stubClient({
      settings: { edition: 'enterprise', feature_overrides: { email: 'on' } },
    })
    const got = await resolveWorkspaceEdition(client, WS)
    expect(got.id).toBe('full')
    expect(got.explicit).toBe(false)
    expect(got.overrides).toEqual({ email: 'on' })
  })

  it('fails open to no overrides when the client throws', async () => {
    const { client } = stubClient({ throws: true })
    const got = await resolveWorkspaceEdition(client, WS)
    expect(got.overrides).toEqual({})
    expect(got.edition).toEqual(EDITIONS.full)
  })
})

/**
 * The pure half of resolveWorkspaceEdition. The live-agent turn path resolves
 * the edition, the trust policy, and the claims auto-accept policy off ONE read
 * of workspace.settings (that route fires every ~3s during a recording), so this
 * variant must reproduce the fetching one's semantics exactly — including the
 * fail-open default a failed shared read (`null` settings) lands on.
 */
describe('resolveWorkspaceEditionFromSettings', () => {
  it('reads a stamped edition and marks it explicit', () => {
    const got = resolveWorkspaceEditionFromSettings({ edition: 'sales' })
    expect(got.id).toBe('sales')
    expect(got.edition).toEqual(EDITIONS.sales)
    expect(got.explicit).toBe(true)
  })

  it('returns non-explicit full when settings has no edition key', () => {
    const got = resolveWorkspaceEditionFromSettings({ trust_policy: { enabled: true } })
    expect(got.id).toBe('full')
    expect(got.explicit).toBe(false)
  })

  it('treats a garbage edition value as NON-explicit full', () => {
    for (const junk of ['enterprise', 42, null, {}, '']) {
      const got = resolveWorkspaceEditionFromSettings({ edition: junk })
      expect(got.id).toBe('full')
      expect(got.explicit).toBe(false)
    }
  })

  it('applies feature_overrides from the same blob', () => {
    const got = resolveWorkspaceEditionFromSettings({
      edition: 'notes',
      feature_overrides: { email: 'off' },
    })
    expect(got.id).toBe('notes')
    expect(got.overrides).toEqual({ email: 'off' })
    expect(got.edition.views).not.toContain('mail')
    expect(got.edition.toolCategories).not.toContain('emails')
  })

  it('fails open to non-explicit full with NO overrides for null/garbage settings', () => {
    // What a failed shared read hands in — must degrade exactly like the
    // fetching variant's catch, not throw.
    for (const bad of [null, undefined, 'nope', 42]) {
      const got = resolveWorkspaceEditionFromSettings(bad)
      expect(got.id).toBe('full')
      expect(got.explicit).toBe(false)
      expect(got.overrides).toEqual({})
    }
  })

  it('still returns a COPY of autoCreateEntities, not the composed array', () => {
    const noCrm = resolveWorkspaceEditionFromSettings({
      edition: 'notes',
      feature_overrides: { crm: 'off' },
    })
    expect(noCrm.autoCreateEntities).not.toContain('contact')
    ;(noCrm.autoCreateEntities as string[]).push('contact')
    expect(noCrm.edition.autoCreateEntities).not.toContain('contact')
  })

  it('agrees with resolveWorkspaceEdition on the same settings blob', async () => {
    for (const settings of [
      {},
      { edition: 'sales' },
      { edition: 'notes', feature_overrides: { email: 'off' } },
      { edition: 'bogus' },
    ]) {
      expect(resolveWorkspaceEditionFromSettings(settings)).toEqual(
        await resolveWorkspaceEdition(stubClient({ settings }).client, WS),
      )
    }
  })
})

describe('adoptBusinessEdition', () => {
  it('a text sign-up stamps a fresh workspace with the business edition', async () => {
    const { client, updates } = stubClient({ settings: { trust_policy: { enabled: false } } })
    await expect(adoptBusinessEdition(client, WS, 'signup')).resolves.toBe(true)
    expect(updates).toEqual([{ trust_policy: { enabled: false }, edition: 'service' }])
  })

  it('a text sign-up never overwrites an edition already there (first write wins)', async () => {
    const { client, updates } = stubClient({ settings: { edition: 'sales' } })
    await expect(adoptBusinessEdition(client, WS, 'signup')).resolves.toBe(false)
    expect(updates).toEqual([])
  })

  it("a first business profile switches the attribution stamp (every web sign-up has one)", async () => {
    const { client, updates } = stubClient({ settings: { edition: 'sales', trust_policy: { enabled: true } } })
    await expect(adoptBusinessEdition(client, WS, 'profile')).resolves.toBe(true)
    expect(updates).toEqual([{ edition: 'service', edition_source: 'business', trust_policy: { enabled: true } }])
  })

  it('a profile never replaces an edition a person chose (the settings or admin switcher)', async () => {
    const { client, updates } = stubClient({ settings: { edition: 'sales', edition_source: 'chosen' } })
    await expect(adoptBusinessEdition(client, WS, 'profile')).resolves.toBe(false)
    expect(updates).toEqual([])
  })

  it('a switch after the profile is a choice: re-making the profile keeps it', async () => {
    const { client, updates } = stubClient({ settings: { edition: 'service', edition_source: 'business' } })
    await setWorkspaceEdition(client, WS, 'full')
    expect(updates[0]).toEqual({ edition: 'full', edition_source: 'chosen' })
    const after = stubClient({ settings: updates[0] })
    await expect(adoptBusinessEdition(after.client, WS, 'profile')).resolves.toBe(false)
    expect(after.updates).toEqual([])
  })

  it('a text sign-up on a workspace already on the business edition counts as on it', async () => {
    const { client, updates } = stubClient({ settings: { edition: 'service' } })
    await expect(adoptBusinessEdition(client, WS, 'signup')).resolves.toBe(true)
    expect(updates).toEqual([])
  })

  it('a profile on a workspace already on the business edition writes nothing', async () => {
    const { client, updates } = stubClient({ settings: { edition: 'service' } })
    await expect(adoptBusinessEdition(client, WS, 'profile')).resolves.toBe(true)
    expect(updates).toEqual([])
  })

  it('never throws: a failed read or write is false, and the business is still set up', async () => {
    await expect(adoptBusinessEdition(stubClient({ throws: true }).client, WS, 'signup')).resolves.toBe(false)
    await expect(adoptBusinessEdition(stubClient({ throws: true }).client, WS, 'profile')).resolves.toBe(false)
    await expect(adoptBusinessEdition(stubClient({ readError: { message: 'rls' } }).client, WS, 'profile')).resolves.toBe(false)
    await expect(adoptBusinessEdition(stubClient({ updatedRows: [] }).client, WS, 'profile')).resolves.toBe(false)
  })
})
