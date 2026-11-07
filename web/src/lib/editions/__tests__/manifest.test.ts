/**
 * Tests for the edition manifest — the ONE definition of a persona edition.
 *
 * Two jobs, mirroring the trust-policy test's split:
 *
 *   1. NORMALIZATION. Any shape of garbage in `settings.edition` degrades to
 *      `full` (today's behavior) rather than throwing — the manifest's
 *      invariant 1.
 *
 *   2. COHERENCE GUARDS. Every id the manifest names must exist in the system
 *      it names it from: views in the `EditionView` union, tool categories in
 *      `TOOL_CATEGORIES`. These are the tests that
 *      make the one-file promise safe: rename a tool category and the
 *      manifest fails loudly instead of silently mis-scoping a workspace.
 */
import { describe, it, expect } from 'vitest'
import {
  ALWAYS_ALLOWED_VIEWS,
  DEFAULT_EDITION_ID,
  EDITIONS,
  EDITION_IDS,
  EDITION_LIST,
  FEATURES,
  FEATURE_KEYS,
  NON_DEFAULT_FEATURE_KEYS,
  allowedViews,
  composeSurface,
  getEdition,
  isAutoCreateAllowed,
  isEditionId,
  isViewAllowed,
  normalizeEditionId,
  editionDefaultAgentSlug,
  withEffectiveSurface,
  type EditionView,
} from '../manifest'
import { computeEditionToolCeiling, intersectCeilings } from '../tool-ceiling'
import { ALL_CATEGORY_IDS, getToolNamesForCategories } from '@/lib/ai/tool-registry'
import { SCOPED } from '@/test/editions'

// ── Every view, once (compile-time exhaustive) ─────────────────────────────
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false
const ALL_VIEWS = [
  'todo', 'captures', 'docs', 'initiatives', 'projects', 'flows', 'teams',
  'team-actions', 'calendar', 'contacts', 'companies', 'mail', 'knowledge', 'agents',
  'sequences', 'campaigns', 'prospecting', 'evals',
] as const satisfies readonly EditionView[]
const _allViews: Equals<(typeof ALL_VIEWS)[number], EditionView> = true
void _allViews

describe('normalizeEditionId', () => {
  it('degrades every shape of garbage to the default', () => {
    expect(normalizeEditionId(null)).toBe('full')
    expect(normalizeEditionId(undefined)).toBe('full')
    expect(normalizeEditionId(42)).toBe('full')
    expect(normalizeEditionId({})).toBe('full')
    expect(normalizeEditionId([])).toBe('full')
    expect(normalizeEditionId('')).toBe('full')
    expect(normalizeEditionId('SALES')).toBe('full') // case-sensitive by design
    expect(normalizeEditionId('enterprise')).toBe('full') // unknown/retired id
  })

  it('passes through every known edition id', () => {
    for (const id of EDITION_IDS) expect(normalizeEditionId(id)).toBe(id)
  })

  it('defaults to full — today’s exact behavior', () => {
    expect(DEFAULT_EDITION_ID).toBe('full')
    expect(normalizeEditionId(undefined)).toBe(DEFAULT_EDITION_ID)
  })
})

describe('isEditionId', () => {
  it('is strict — no coercion, so attribution can tell "sales" from garbage', () => {
    expect(isEditionId('sales')).toBe(true)
    expect(isEditionId('full')).toBe(true)
    expect(isEditionId('nope')).toBe(false)
    expect(isEditionId(null)).toBe(false)
    expect(isEditionId(7)).toBe(false)
  })
})

describe('getEdition', () => {
  it('returns the definition for a valid id', () => {
    expect(getEdition('sales').id).toBe('sales')
  })

  it('returns the full definition for garbage — never null, never throws', () => {
    expect(getEdition('garbage').id).toBe('full')
    expect(getEdition(null).id).toBe('full')
  })
})

describe('EDITIONS integrity', () => {
  it('every entry’s key matches its own id', () => {
    for (const id of EDITION_IDS) expect(EDITIONS[id].id).toBe(id)
  })

  it('EDITION_LIST covers every edition in id order', () => {
    expect(EDITION_LIST.map((e) => e.id)).toEqual([...EDITION_IDS])
  })

  it('every edition has a label and description for the settings switcher', () => {
    for (const e of EDITION_LIST) {
      expect(e.label.length).toBeGreaterThan(0)
      expect(e.description.length).toBeGreaterThan(0)
    }
  })

  it('every views list is duplicate-free', () => {
    for (const e of EDITION_LIST) {
      expect(new Set(e.views).size).toBe(e.views.length)
    }
  })

  // ── defaultAgents: the AUTHORED per-mode default meeting persona ──────────
  it('every edition declares a complete defaultAgents shape', () => {
    for (const e of EDITION_LIST) {
      expect(e.defaultAgents, `${e.id} has no defaultAgents`).toBeTruthy()
      for (const mode of ['live', 'batch'] as const) {
        const slug = e.defaultAgents[mode]
        expect(
          slug === null || typeof slug === 'string',
          `${e.id}.defaultAgents.${mode} must be a slug or null`,
        ).toBe(true)
        // SLUGS, never ids: a system recipe's id is per-environment, so a uuid
        // here would make the manifest environment-specific.
        if (typeof slug === 'string') {
          expect(slug.length, `${e.id}.defaultAgents.${mode} is empty`).toBeGreaterThan(0)
          expect(slug, `${e.id}.defaultAgents.${mode} looks like a uuid, not a slug`).not.toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-/i,
          )
          expect(slug, `${e.id}.defaultAgents.${mode} is not slug-shaped`).toMatch(
            /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
          )
        }
      }
    }
  })
})

// ── Guard: views ───────────────────────────────────────────────────────────
describe('view guards', () => {
  it('every view / extraAllowedView is a real EditionView', () => {
    for (const e of EDITION_LIST) {
      for (const v of [...e.views, ...e.extraAllowedViews]) {
        expect(ALL_VIEWS, `${e.id} references unknown view "${v}"`).toContain(v)
      }
    }
  })

  it('every ALWAYS_ALLOWED_VIEWS entry is a real EditionView', () => {
    for (const v of ALWAYS_ALLOWED_VIEWS) expect(ALL_VIEWS).toContain(v)
  })

  it('every feature together reaches every page (views, extras and the always-allowed), each view once', () => {
    const surface = composeSurface([...FEATURE_KEYS])
    const all = [...surface.views]
    expect(new Set(all).size).toBe(all.length)
    expect(new Set([...all, ...surface.extraAllowedViews, ...ALWAYS_ALLOWED_VIEWS])).toEqual(new Set(ALL_VIEWS))
  })

  it('every edition’s views are every feature’s views (invariant 5)', () => {
    expect([...NON_DEFAULT_FEATURE_KEYS]).toEqual([])
    for (const e of EDITION_LIST) {
      expect([...e.views], e.id).toEqual([...composeSurface([...FEATURE_KEYS]).views])
    }
  })
})

// ── Guard: tool categories ─────────────────────────────────────────────────
describe('tool category guards', () => {
  it('every listed toolCategory id exists in TOOL_CATEGORIES', () => {
    for (const e of EDITION_LIST) {
      if (e.toolCategories === 'all') continue
      for (const id of e.toolCategories) {
        expect(ALL_CATEGORY_IDS, `${e.id} references unknown tool category "${id}"`).toContain(id)
      }
    }
  })

  it('every edition uses the inherit-all sentinel, not an enumerated list', () => {
    for (const e of EDITION_LIST) expect(e.toolCategories, e.id).toBe('all')
  })

  it('no edition lists a duplicate category', () => {
    for (const e of EDITION_LIST) {
      if (e.toolCategories === 'all') continue
      expect(new Set(e.toolCategories).size).toBe(e.toolCategories.length)
    }
  })
})

describe('computeEditionToolCeiling', () => {
  it('every edition inherits everything — no ceiling at all', () => {
    // `'all'` = every category a default-on feature contributes, and every
    // feature is default-on, so there is nothing to enumerate out.
    for (const e of EDITION_LIST) expect(computeEditionToolCeiling(e), e.id).toBeNull()
  })

  it('returns a real ceiling for a scoped edition', () => {
    const ceiling = computeEditionToolCeiling(SCOPED.notes)
    expect(ceiling).not.toBeNull()
    // Core tools survive any ceiling (they are unioned in by computeToolCeiling).
    expect(ceiling!.has('search_tools')).toBe(true)
    expect(ceiling!.has('list_actions')).toBe(true)
    // Its own categories are present…
    expect(ceiling!.has('get_capture_transcript')).toBe(true)
    // …and categories it excludes are absent.
    expect(ceiling!.has('create_sequence')).toBe(false)
    expect(ceiling!.has('create_initiative')).toBe(false)
  })

  it('the scoped sales preset keeps CRM + sequences and drops project machinery', () => {
    const ceiling = computeEditionToolCeiling(SCOPED.sales)!
    expect(ceiling.has('get_contact_details')).toBe(true)
    expect(ceiling.has('create_sequence')).toBe(true)
    expect(ceiling.has('create_project')).toBe(false)
    expect(ceiling.has('create_initiative')).toBe(false)
    expect(ceiling.has('create_cycle')).toBe(false)
    expect(ceiling.has('create_flow')).toBe(false)
  })

  it('the scoped brain preset is the notes set plus knowledge and flows', () => {
    const brain = computeEditionToolCeiling(SCOPED.brain)!
    const notes = computeEditionToolCeiling(SCOPED.notes)!
    for (const name of notes) expect(brain.has(name)).toBe(true)
    expect(brain.has('create_claim')).toBe(true)
    expect(brain.has('list_flows')).toBe(true)
    expect(notes.has('create_claim')).toBe(false)
  })

  it('a scoped ceiling contains exactly its categories’ tools (plus core)', () => {
    const e = SCOPED.notes
    const expected = new Set(getToolNamesForCategories([...(e.toolCategories as string[])]))
    const ceiling = computeEditionToolCeiling(e)!
    for (const name of expected) expect(ceiling.has(name)).toBe(true)
  })
})

// ── isViewAllowed / allowedViews ───────────────────────────────────────────
describe('isViewAllowed', () => {
  it('always allows the infrastructure views in every edition', () => {
    for (const e of EDITION_LIST) {
      for (const v of ALWAYS_ALLOWED_VIEWS) expect(isViewAllowed(e, v)).toBe(true)
    }
  })

  it('allows every view in every edition, evals included', () => {
    for (const e of EDITION_LIST) {
      for (const v of ALL_VIEWS) expect(isViewAllowed(e, v), `${e.id} should allow ${v}`).toBe(true)
    }
    // …and an `off` is what closes one.
    expect(
      isViewAllowed(withEffectiveSurface(EDITIONS.full, { evals: 'off' }), 'evals'),
    ).toBe(false)
  })

  it('the scoped sales preset: CRM and mail in, projects out, companies reachable as an extra', () => {
    const sales = SCOPED.sales
    expect(isViewAllowed(sales, 'contacts')).toBe(true)
    expect(isViewAllowed(sales, 'sequences')).toBe(true)
    expect(isViewAllowed(sales, 'mail')).toBe(true)
    expect(sales.views).toContain('mail')
    expect(isViewAllowed(sales, 'companies')).toBe(true) // extraAllowed
    expect(sales.views).not.toContain('companies')
    expect(isViewAllowed(sales, 'projects')).toBe(false)
    expect(isViewAllowed(sales, 'initiatives')).toBe(false)
    expect(isViewAllowed(sales, 'flows')).toBe(false)
  })

  it('the scoped notes preset keeps to the capture surface', () => {
    const notes = SCOPED.notes
    expect(isViewAllowed(notes, 'captures')).toBe(true)
    expect(isViewAllowed(notes, 'contacts')).toBe(false)
    expect(isViewAllowed(notes, 'sequences')).toBe(false)
    expect(isViewAllowed(notes, 'knowledge')).toBe(false)
  })

  it('allowedViews is the union of always-allowed, views and extras', () => {
    const set = allowedViews(SCOPED.brain)
    expect(set.has('knowledge')).toBe(true)
    expect(set.has('teams')).toBe(true) // always allowed
    expect(set.has('sequences')).toBe(false)
    for (const v of ALL_VIEWS) {
      expect(set.has(v)).toBe(isViewAllowed(SCOPED.brain, v))
    }
  })
})

describe('intersectCeilings', () => {
  it('treats null as the identity element on both sides', () => {
    const a = new Set(['x', 'y'])
    expect(intersectCeilings(null, a)).toBe(a)
    expect(intersectCeilings(a, null)).toBe(a)
    expect(intersectCeilings(null, null)).toBeNull()
    expect(intersectCeilings(undefined, undefined)).toBeNull()
  })

  it('intersects — never unions — so neither side can widen the other', () => {
    const got = intersectCeilings(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))
    expect([...got!].sort()).toEqual(['b', 'c'])
  })

  it('a full-edition ceiling never widens a narrowed agent ceiling', () => {
    const agent = new Set(['list_captures'])
    const out = intersectCeilings(computeEditionToolCeiling(EDITIONS.full), agent)!
    expect([...out]).toEqual(['list_captures'])
  })

  it('an agent allowlist cannot restore a tool the edition removed', () => {
    const got = intersectCeilings(
      computeEditionToolCeiling(SCOPED.notes),
      new Set(['create_sequence', 'list_captures']),
    )
    expect(got!.has('create_sequence')).toBe(false)
    expect(got!.has('list_captures')).toBe(true)
  })
})

describe('isAutoCreateAllowed', () => {
  it('every edition imposes no restriction (the "all" sentinel)', () => {
    for (const e of EDITION_LIST) {
      expect(e.autoCreateEntities, e.id).toBe('all')
      for (const t of ['action', 'decision', 'contact', 'company', 'project'] as const) {
        expect(isAutoCreateAllowed(e, t), `${e.id}/${t}`).toBe(true)
      }
    }
  })

  it('every edition permits actions and decisions — the shared spine', () => {
    for (const e of EDITION_LIST) {
      expect(isAutoCreateAllowed(e, 'action')).toBe(true)
      expect(isAutoCreateAllowed(e, 'decision')).toBe(true)
    }
  })

  it('the scoped sales preset adds contacts; scoped notes and brain do not', () => {
    expect(isAutoCreateAllowed(SCOPED.sales, 'contact')).toBe(true)
    expect(isAutoCreateAllowed(SCOPED.notes, 'contact')).toBe(false)
    expect(isAutoCreateAllowed(SCOPED.brain, 'contact')).toBe(false)
  })

  it('an unknown entity type is never auto-created under an enumerated list', () => {
    expect(isAutoCreateAllowed(SCOPED.sales, 'wormhole')).toBe(false)
  })
})


// ── editionDefaultAgentSlug ────────────────────────────────────────────────
describe('editionDefaultAgentSlug', () => {
  it('sales names its two seeded personas, one per mode', () => {
    expect(editionDefaultAgentSlug(EDITIONS.sales, 'live')).toBe('sales-live')
    expect(editionDefaultAgentSlug(EDITIONS.sales, 'batch')).toBe('sales-post-call')
  })

  it('full, notes and brain declare no opinion — today’s behavior', () => {
    for (const id of ['full', 'notes', 'brain'] as const) {
      expect(editionDefaultAgentSlug(EDITIONS[id], 'live')).toBeNull()
      expect(editionDefaultAgentSlug(EDITIONS[id], 'batch')).toBeNull()
    }
  })

  it('accepts a bare edition id as well as a definition', () => {
    expect(editionDefaultAgentSlug('sales', 'live')).toBe('sales-live')
    expect(editionDefaultAgentSlug('full', 'batch')).toBeNull()
  })

  it('degrades garbage to the full default (null) rather than throwing', () => {
    expect(editionDefaultAgentSlug(null, 'live')).toBeNull()
    expect(editionDefaultAgentSlug(undefined, 'batch')).toBeNull()
    expect(editionDefaultAgentSlug(42, 'live')).toBeNull()
    expect(editionDefaultAgentSlug('enterprise', 'batch')).toBeNull()
    expect(editionDefaultAgentSlug({}, 'live')).toBeNull()
  })

  it('survives feature overrides — defaultAgents is authored, never composed', () => {
    // A sales workspace that switches CRM off loses the CRM surface but keeps
    // its sales personas: the default agent is an edition-level preference, not
    // part of the composed surface.
    const scoped = withEffectiveSurface(EDITIONS.sales, { crm: 'off' })
    expect(editionDefaultAgentSlug(scoped, 'live')).toBe('sales-live')
    expect(editionDefaultAgentSlug(scoped, 'batch')).toBe('sales-post-call')
  })
})
