/**
 * Feature decomposition — the GOLDEN tests.
 *
 * The manifest's edition surfaces used to be hand-authored arrays. They are now
 * COMPOSED from a feature taxonomy (`FEATURES`) via `composeSurface`. That
 * refactor is only safe if composition reproduces the old arrays exactly — a
 * single missing tool category would silently narrow a live workspace's AI
 * ceiling, and a missing view would silently hide a page.
 *
 * Every shipped edition now presets every feature (manifest invariant 5), so
 * they all pin ONE surface, `SHIPPED`. The narrow presets sales, notes and brain
 * had before that live on as fixtures (`SCOPED` in src/test/editions.ts), and
 * their literals stay pinned here: they are what proves composition, `requires`
 * closure and the override machinery still work on a feature LIST.
 *
 * The second half covers the composition MACHINERY itself: `requires` closure,
 * the `'all'` passthrough that preserves the null tool ceiling, override
 * normalization, and tri-state merge.
 */
import { describe, it, expect } from 'vitest'
import {
  ADMIN_FEATURE_LIST,
  ALL_FEATURE_GATED_RECIPE_IDS,
  ADMIN_TOGGLEABLE_FEATURE_KEYS,
  CORE_FEATURE,
  EDITIONS,
  EDITION_LIST,
  FEATURES,
  FEATURE_KEYS,
  FEATURE_LIST,
  HIDDEN_FEATURE_KEYS,
  NON_DEFAULT_FEATURE_KEYS,
  STANDARD_FEATURE_KEYS,
  TOGGLEABLE_FEATURE_KEYS,
  isFeatureEnabled,
  composeEffectiveSurface,
  composeSurface,
  effectiveFeatureKeys,
  featureGatedRecipeExclusions,
  isFeatureKey,
  normalizeFeatureOverrides,
  resolveFeatureClosure,
  withEffectiveSurface,
  type EditionDefinition,
  type EditionEntityType,
  type EditionId,
  type EditionView,
} from '../manifest'
import { isOnByDefault, pruneNoOpOverrides } from '../features'
import { computeEditionToolCeiling, offFeatureDeniedToolNames } from '../tool-ceiling'
import { ALL_CATEGORY_IDS, ALL_TOOL_NAMES } from '@/lib/ai/tool-registry'
import { SCOPED } from '@/test/editions'

// ───────────────────────────────────────────────────────────────────────────
// GOLDEN: the surfaces, typed by hand. Do not "tidy" these — their value is that
// they were typed by a human describing the shipped behavior, not derived from
// the code under test.
// ───────────────────────────────────────────────────────────────────────────

interface GoldenSurface {
  views: readonly EditionView[]
  extraAllowedViews: readonly EditionView[]
  toolCategories: readonly string[] | 'all'
  autoCreateEntities: 'all' | readonly EditionEntityType[]
}

/** What EVERY shipped edition has: every feature (manifest invariant 5). */
const SHIPPED: GoldenSurface = {
  views: [
    'calendar',
    'todo',
    'team-actions',
    'captures',
    'docs',
    'knowledge',
    'initiatives',
    'projects',
    'flows',
    'mail',
    'contacts',
    // Added after the decomposition: a new view-contributing feature widens
    // this list by construction. Reviewed deliberately — the golden exists to
    // force exactly this moment.
    'prospecting',
    'sequences',
    'campaigns',
    // Evals was opt-in (in no preset) until every feature went on for everyone.
    'evals',
    'agents',
  ],
  extraAllowedViews: ['companies'],
  toolCategories: 'all',
  autoCreateEntities: 'all',
}

const GOLDEN: Record<EditionId, GoldenSurface> = {
  full: SHIPPED,
  sales: SHIPPED,
  notes: SHIPPED,
  brain: SHIPPED,
  // The service business (roadmap F1) changes words, never the surface.
  service: SHIPPED,
}

/** The presets sales, notes and brain shipped with before invariant 5, kept as
 *  the `SCOPED` fixtures: composition must still reproduce them exactly. */
const SCOPED_GOLDEN: Record<keyof typeof SCOPED, GoldenSurface> = {
  sales: {
    views: [
      'calendar',
      'todo',
      'captures',
      'docs',
      'knowledge',
      'mail',
      'contacts',
      'sequences',
      'agents',
    ],
    extraAllowedViews: ['companies'],
    toolCategories: [
      'captures',
      'actions',
      'documents',
      'tables',
      'decisions',
      'emails',
      'contacts',
      'calendar',
      'attachments',
      'comments',
      'calendar_capture',
      'dashboard',
      'notifications',
      'search',
      'knowledge',
      'sequences',
      'library',
      'content',
    ],
    autoCreateEntities: ['action', 'contact', 'decision'],
  },

  notes: {
    views: ['calendar', 'todo', 'team-actions', 'captures', 'docs', 'agents'],
    extraAllowedViews: [],
    toolCategories: [
      'captures',
      'actions',
      'documents',
      'tables',
      'decisions',
      'calendar',
      'calendar_capture',
      'attachments',
      'comments',
      'dashboard',
      'notifications',
      'search',
      'library',
      'content',
    ],
    autoCreateEntities: ['action', 'decision'],
  },

  brain: {
    views: ['calendar', 'todo', 'captures', 'docs', 'knowledge', 'flows', 'agents'],
    extraAllowedViews: [],
    toolCategories: [
      'captures',
      'actions',
      'documents',
      'tables',
      'decisions',
      'calendar',
      'calendar_capture',
      'attachments',
      'comments',
      'dashboard',
      'notifications',
      'search',
      'library',
      'content',
      'knowledge',
      'flows',
    ],
    autoCreateEntities: ['action', 'decision'],
  },
}

/** Every surface field is a set: the composer emits unions in feature order. */
const sorted = (xs: readonly string[]) => [...xs].sort()

describe('golden: composition reproduces every pinned surface exactly', () => {
  const cases: [string, EditionDefinition, GoldenSurface][] = [
    ...(Object.entries(GOLDEN) as [EditionId, GoldenSurface][]).map(
      ([id, golden]): [string, EditionDefinition, GoldenSurface] => [id, EDITIONS[id], golden],
    ),
    ...(Object.entries(SCOPED_GOLDEN) as [keyof typeof SCOPED, GoldenSurface][]).map(
      ([id, golden]): [string, EditionDefinition, GoldenSurface] => [
        `scoped ${id}`,
        SCOPED[id],
        golden,
      ],
    ),
  ]
  for (const [id, edition, golden] of cases) {
    describe(id, () => {

      it('views match', () => {
        expect(sorted(edition.views)).toEqual(sorted(golden.views))
      })

      it('extraAllowedViews match', () => {
        expect(sorted(edition.extraAllowedViews)).toEqual(sorted(golden.extraAllowedViews))
      })

      it('toolCategories match', () => {
        if (golden.toolCategories === 'all') {
          // The literal sentinel, not an exhaustive list — see composeSurface.
          expect(edition.toolCategories).toBe('all')
        } else {
          expect(edition.toolCategories).not.toBe('all')
          expect(sorted(edition.toolCategories as readonly string[])).toEqual(
            sorted(golden.toolCategories),
          )
        }
      })

      it('autoCreateEntities match', () => {
        if (golden.autoCreateEntities === 'all') {
          expect(edition.autoCreateEntities).toBe('all')
        } else {
          expect(edition.autoCreateEntities).not.toBe('all')
          expect(sorted(edition.autoCreateEntities as readonly string[])).toEqual(
            sorted(golden.autoCreateEntities),
          )
        }
      })
    })
  }

  it('full’s composed tool set would cover every category — but stays the sentinel', () => {
    // Proof the `'all'` passthrough is a CHOICE, not a gap: enumerating full's
    // features yields every registered category, so the sentinel loses no
    // capability today. It is kept because it also covers categories added
    // TOMORROW, which an enumerated snapshot would silently deny.
    const enumerated = composeSurface([...FEATURE_KEYS])
    expect(sorted(enumerated.toolCategories as readonly string[])).toEqual(sorted(ALL_CATEGORY_IDS))
    expect(EDITIONS.full.toolCategories).toBe('all')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// The taxonomy's own integrity
// ───────────────────────────────────────────────────────────────────────────

describe('FEATURES integrity', () => {
  it('every entry’s key matches its own id', () => {
    for (const k of FEATURE_KEYS) expect(FEATURES[k].id).toBe(k)
  })

  it('FEATURE_LIST is the user-facing list — every NON-hidden feature, in key order', () => {
    // VISIBILITY axis, not the preset axis: an OPT-IN feature is off by default
    // everywhere yet still the user's to see and toggle, so it IS listed.
    expect(FEATURE_LIST.map((f) => f.id)).toEqual(
      FEATURE_KEYS.filter((k) => !FEATURES[k].hidden),
    )
    expect(FEATURE_LIST.some((f) => f.hidden)).toBe(false)
    expect(FEATURE_LIST.map((f) => f.id)).toContain('evals')
    // The admin console gets every feature, hidden ones included, same order.
    expect(ADMIN_FEATURE_LIST.map((f) => f.id)).toEqual([...FEATURE_KEYS])
  })

  it('every feature is a default-on feature — nothing hidden, nothing opt-in', () => {
    // Invariant 5: every workspace has every feature. The `hidden` and `optIn`
    // flags are kept for a future surface that wants them; none carries one.
    expect([...STANDARD_FEATURE_KEYS]).toEqual([...FEATURE_KEYS])
    expect([...NON_DEFAULT_FEATURE_KEYS]).toEqual([])
    expect([...HIDDEN_FEATURE_KEYS]).toEqual([])
    expect(FEATURES.evals.optIn).toBeFalsy()
    expect(FEATURES.browser.optIn).toBeFalsy()
  })

  it('every edition presets every feature — an edition is a persona, not a surface', () => {
    for (const e of EDITION_LIST) expect(e.features, e.id).toBe('all')
  })

  it('core is the only locked feature, and is excluded from the toggleable set', () => {
    expect(FEATURES[CORE_FEATURE].locked).toBe(true)
    expect(ADMIN_FEATURE_LIST.filter((f) => f.locked).map((f) => f.id)).toEqual([CORE_FEATURE])
    expect(TOGGLEABLE_FEATURE_KEYS).not.toContain(CORE_FEATURE)
    // The user set drops core AND every hidden key; the admin set drops core only.
    expect(TOGGLEABLE_FEATURE_KEYS.length).toBe(FEATURE_KEYS.length - 1 - HIDDEN_FEATURE_KEYS.length)
    expect(ADMIN_TOGGLEABLE_FEATURE_KEYS.length).toBe(FEATURE_KEYS.length - 1)
    expect(ADMIN_TOGGLEABLE_FEATURE_KEYS).toContain('evals')
    // An OPT-IN feature is the USER's to toggle — it is in both sets.
    expect(TOGGLEABLE_FEATURE_KEYS).toContain('evals')
  })

  it('every feature has settings-card copy', () => {
    for (const f of ADMIN_FEATURE_LIST) {
      expect(f.label.length).toBeGreaterThan(0)
      expect(f.description.length).toBeGreaterThan(0)
    }
  })

  it('every listed toolCategory id exists in TOOL_CATEGORIES', () => {
    for (const f of ADMIN_FEATURE_LIST) {
      for (const id of f.toolCategories) {
        expect(ALL_CATEGORY_IDS, `${f.id} references unknown tool category "${id}"`).toContain(id)
      }
    }
  })

  it('every `requires` names a real feature, and nothing requires core', () => {
    for (const f of ADMIN_FEATURE_LIST) {
      for (const r of f.requires) {
        expect(FEATURE_KEYS, `${f.id} requires unknown feature "${r}"`).toContain(r)
        // core is unconditional; naming it would be noise.
        expect(r).not.toBe(CORE_FEATURE)
      }
    }
  })

  it('no two features claim the same view — a view has one owner', () => {
    const seen = new Map<string, string>()
    for (const f of FEATURE_LIST) {
      for (const v of f.views) {
        expect(seen.has(v), `view "${v}" claimed by both ${seen.get(v)} and ${f.id}`).toBe(false)
        seen.set(v, f.id)
      }
    }
  })

  it('no two features claim the same tool category', () => {
    const seen = new Map<string, string>()
    for (const f of FEATURE_LIST) {
      for (const c of f.toolCategories) {
        expect(seen.has(c), `category "${c}" claimed by both ${seen.get(c)} and ${f.id}`).toBe(false)
        seen.set(c, f.id)
      }
    }
  })

  it('projects grants BOTH project and milestone — the only source of create:project', () => {
    // Pinned directly because no golden edition enables `projects`, so nothing
    // else in this suite covers it: `full` is the `'all'` sentinel and the
    // three enumerated goldens omit the feature entirely. Yet the moment ANY
    // feature is switched off, autoCreateEntities becomes an enumerated union —
    // and since this feature is the sole contributor of 'project', dropping it
    // here would make create:project ungrantable in every non-pristine
    // workspace. Exact match, not `toContain`: an accidental addition would
    // widen what the auto-apply gate can create without review.
    expect(FEATURES.projects.autoCreateEntities).toEqual(['project', 'milestone'])
  })

  it('every scoped fixture’s feature list names real, non-core features', () => {
    for (const e of Object.values(SCOPED)) {
      if (e.features === 'all') continue
      for (const k of e.features) {
        expect(FEATURE_KEYS, `${e.id} names unknown feature "${k}"`).toContain(k)
        // core is implicit; listing it would imply it were optional.
        expect(k).not.toBe(CORE_FEATURE)
      }
      expect(new Set(e.features).size).toBe(e.features.length)
    }
  })
})

describe('isFeatureKey', () => {
  it('is strict — no coercion', () => {
    expect(isFeatureKey('crm')).toBe(true)
    expect(isFeatureKey('core')).toBe(true)
    expect(isFeatureKey('CRM')).toBe(false)
    expect(isFeatureKey('wormhole')).toBe(false)
    expect(isFeatureKey(null)).toBe(false)
    expect(isFeatureKey(7)).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// composeSurface
// ───────────────────────────────────────────────────────────────────────────

describe('composeSurface', () => {
  it('always includes core, even from an empty set', () => {
    const s = composeSurface([])
    expect(sorted(s.views)).toEqual(sorted(['calendar', 'todo', 'captures', 'agents']))
    expect(sorted(s.autoCreateEntities as readonly string[])).toEqual(['action', 'decision'])
  })

  it('closes over `requires` — sequences pulls in crm', () => {
    const s = composeSurface(['sequences'])
    expect(sorted(s.views)).toEqual(sorted(['calendar', 'todo', 'captures', 'contacts', 'sequences', 'agents']))
    expect(s.extraAllowedViews).toContain('companies') // crm's extra came along
    expect(s.toolCategories).toContain('contacts')
    expect(s.autoCreateEntities).toContain('contact')
  })

  it('composes the same views whatever order the features were named in', () => {
    const forward = composeSurface(['docs', 'projects', 'email'])
    const backward = composeSurface(['email', 'projects', 'docs'])
    expect([...forward.views]).toEqual([...backward.views])
    expect(sorted(forward.views)).toEqual(
      sorted(['calendar', 'todo', 'captures', 'docs', 'initiatives', 'projects', 'mail', 'agents']),
    )
  })

  it('`all` returns the literal sentinels — the null-ceiling passthrough', () => {
    const s = composeSurface('all')
    expect(s.toolCategories).toBe('all')
    expect(s.autoCreateEntities).toBe('all')
    // Views and extras are still real lists: those have no inherit-all sentinel.
    expect(sorted(s.views)).toEqual(sorted(SHIPPED.views))
    expect([...s.extraAllowedViews]).toEqual(['companies'])
  })

  it('an explicit exhaustive list is NOT the sentinel — it enumerates', () => {
    const s = composeSurface([...FEATURE_KEYS])
    expect(s.toolCategories).not.toBe('all')
    expect(Array.isArray(s.toolCategories)).toBe(true)
  })

  it('produces duplicate-free lists', () => {
    for (const keys of [['crm', 'sequences'], [...FEATURE_KEYS], []] as const) {
      const s = composeSurface([...keys])
      expect(new Set(s.views).size).toBe(s.views.length)
      expect(new Set(s.extraAllowedViews).size).toBe(s.extraAllowedViews.length)
      expect(new Set(s.toolCategories).size).toBe((s.toolCategories as readonly string[]).length)
    }
  })
})

describe('resolveFeatureClosure', () => {
  it('forces core in', () => {
    expect(resolveFeatureClosure([]).has(CORE_FEATURE)).toBe(true)
    expect(resolveFeatureClosure('all').has(CORE_FEATURE)).toBe(true)
  })

  it('is idempotent and order-insensitive', () => {
    const a = [...resolveFeatureClosure(['sequences', 'docs'])].sort()
    const b = [...resolveFeatureClosure(['docs', 'sequences', 'crm'])].sort()
    expect(a).toEqual(b)
  })

  it('drops garbage keys rather than throwing', () => {
    const got = resolveFeatureClosure(['crm', 'wormhole' as never, null as never])
    expect([...got].sort()).toEqual(['core', 'crm'])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// normalizeFeatureOverrides
// ───────────────────────────────────────────────────────────────────────────

describe('normalizeFeatureOverrides', () => {
  it('degrades every shape of garbage to no overrides', () => {
    expect(normalizeFeatureOverrides(null)).toEqual({})
    expect(normalizeFeatureOverrides(undefined)).toEqual({})
    expect(normalizeFeatureOverrides(42)).toEqual({})
    expect(normalizeFeatureOverrides('crm')).toEqual({})
    expect(normalizeFeatureOverrides([])).toEqual({})
    expect(normalizeFeatureOverrides(['crm'])).toEqual({})
  })

  it('keeps valid pairs and drops invalid keys and values', () => {
    expect(
      normalizeFeatureOverrides({
        crm: 'on',
        email: 'off',
        wormhole: 'on', // unknown feature
        docs: 'maybe', // unknown state
        flows: true, // wrong type
        projects: null,
      }),
    ).toEqual({ crm: 'on', email: 'off' })
  })

  it('drops an override on the locked core feature', () => {
    expect(normalizeFeatureOverrides({ core: 'off', crm: 'on' })).toEqual({ crm: 'on' })
  })

  it('returns a fresh object — never aliases the caller’s blob', () => {
    const raw = { crm: 'on' }
    const out = normalizeFeatureOverrides(raw)
    expect(out).not.toBe(raw)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// effectiveFeatureKeys — the tri-state merge
// ───────────────────────────────────────────────────────────────────────────

describe('effectiveFeatureKeys', () => {
  it('absent overrides follow the edition exactly', () => {
    expect(effectiveFeatureKeys(SCOPED.notes)).toEqual(['core', 'docs', 'boards'])
    expect(effectiveFeatureKeys(SCOPED.notes, {})).toEqual(['core', 'docs', 'boards'])
    expect(effectiveFeatureKeys(SCOPED.notes, null)).toEqual(['core', 'docs', 'boards'])
  })

  it('`on` adds a feature the edition omits', () => {
    const got = effectiveFeatureKeys(SCOPED.notes, { email: 'on' })
    expect(got).toContain('email')
    expect(got).toEqual(['core', 'docs', 'boards', 'email'])
  })

  it('`off` removes a feature the edition includes', () => {
    const got = effectiveFeatureKeys(SCOPED.brain, { knowledge: 'off' })
    expect(got).not.toContain('knowledge')
    expect(got).toEqual(['core', 'docs', 'flows'])
  })

  it('`off` on a feature the edition already omits is a no-op', () => {
    expect(effectiveFeatureKeys(SCOPED.notes, { crm: 'off' })).toEqual(
      effectiveFeatureKeys(SCOPED.notes),
    )
  })

  it('an `on` override cannot be re-disabled by the edition — overrides win', () => {
    const got = effectiveFeatureKeys(SCOPED.notes, { crm: 'on', sequences: 'on' })
    expect(got).toContain('crm')
    expect(got).toContain('sequences')
  })

  it('a core override is ignored — core is always on', () => {
    expect(effectiveFeatureKeys(SCOPED.notes, { core: 'off' } as never)).toContain('core')
  })

  it('CLOSES under requires — an `on` pulls its requirements into the LIST', () => {
    // Not merely into the composed surface. Every consumer that renders from
    // this list (the features API, the settings card) would otherwise show
    // Sequences on and CRM off in an app where CRM's pages and tools are live.
    const got = effectiveFeatureKeys(SCOPED.notes, { sequences: 'on' })
    expect(got).toContain('sequences')
    expect(got).toContain('crm')
  })

  it('the closed list agrees with the surface composeSurface builds from it', () => {
    // The invariant that makes closing at this layer safe: list and surface are
    // two views of one feature set, and can never disagree.
    const keys = effectiveFeatureKeys(SCOPED.notes, { sequences: 'on' })
    const surface = composeSurface(keys)
    expect(surface.views).toContain('contacts')
    expect(surface.toolCategories).toContain('contacts')
    expect(keys).toContain('crm')
  })

  it('an explicit `off` WINS over requires — dependents die with the dependency', () => {
    // DELIBERATE INVERSION of the earlier semantics, which resurrected `crm`
    // because `sequences` still wanted it. Resurrection made the user's stored
    // `crm: 'off'` a dead key: the effective set contained crm, so the card
    // showed no Custom badge and no Reset, and the key was stranded in the
    // settings blob forever (on a `full` workspace, silently freezing the tool
    // ceiling into an enumerated snapshot). Off wins, and the cascade keeps the
    // surface coherent — no outreach surface without contacts.
    const got = effectiveFeatureKeys(SCOPED.sales, { crm: 'off' })
    expect(got).not.toContain('crm')
    expect(got).not.toContain('sequences')
    // Naming both explicitly reaches the same place — the cascade is idempotent.
    const both = effectiveFeatureKeys(SCOPED.sales, { crm: 'off', sequences: 'off' })
    expect(both).toEqual(got)
  })

  it('the off-cascade is transitive and never touches core or unrelated features', () => {
    const got = effectiveFeatureKeys(SCOPED.sales, { crm: 'off' }) as string[]
    expect(got).toContain('core')
    // sales' other features are untouched: only crm's dependents go.
    expect(got).toContain('docs')
    expect(got).toContain('knowledge')
    expect(got).toContain('email')
  })

  it('`on` cannot revive a feature whose requirement is off — off still wins', () => {
    // The one remaining contradiction: sequences forced on while crm is off.
    // Resolved the same way, so no consumer can see sequences live without crm.
    const got = effectiveFeatureKeys(SCOPED.sales, { crm: 'off', sequences: 'on' })
    expect(got).not.toContain('crm')
    expect(got).not.toContain('sequences')
  })

  it('closure keeps FEATURE_KEYS order regardless of traversal', () => {
    const got = effectiveFeatureKeys(SCOPED.notes, { sequences: 'on' }) as string[]
    const positions = got.map((k) => (FEATURE_KEYS as readonly string[]).indexOf(k))
    expect(positions).toEqual([...positions].sort((x, y) => x - y))
  })

  it('full with NO off overrides stays the `all` sentinel', () => {
    expect(effectiveFeatureKeys(EDITIONS.full)).toBe('all')
    expect(effectiveFeatureKeys(EDITIONS.full, {})).toBe('all')
    // An `on` against `all` is a no-op — everything is already on.
    expect(effectiveFeatureKeys(EDITIONS.full, { crm: 'on' })).toBe('all')
  })

  it('full with ANY off override becomes an explicit list', () => {
    const got = effectiveFeatureKeys(EDITIONS.full, { email: 'off' })
    expect(got).not.toBe('all')
    expect(got).not.toContain('email')
    expect(got).toContain('crm')
    expect(got).toContain('core')
  })

  it('is ordered by FEATURE_KEYS, so the result is stable and comparable', () => {
    const a = effectiveFeatureKeys(SCOPED.notes, { email: 'on', crm: 'on' })
    const b = effectiveFeatureKeys(SCOPED.notes, { crm: 'on', email: 'on' })
    expect(a).toEqual(b)
    const positions = (a as string[]).map((k) => (FEATURE_KEYS as readonly string[]).indexOf(k))
    expect(positions).toEqual([...positions].sort((x, y) => x - y))
  })
})

// ───────────────────────────────────────────────────────────────────────────
// composeEffectiveSurface — overrides end to end
// ───────────────────────────────────────────────────────────────────────────

describe('composeEffectiveSurface', () => {
  it('with no overrides, every edition’s surface is its manifest surface', () => {
    for (const e of EDITION_LIST) {
      const s = composeEffectiveSurface(e)
      expect([...s.views]).toEqual([...e.views])
      expect(sorted(s.extraAllowedViews)).toEqual(sorted(e.extraAllowedViews))
      expect(s.toolCategories).toEqual(e.toolCategories)
      expect(s.autoCreateEntities).toEqual(e.autoCreateEntities)
    }
  })

  it('turning Email on in notes yields BOTH the Mail page and the email tools', () => {
    const s = composeEffectiveSurface(SCOPED.notes, { email: 'on' })
    expect(s.views).toContain('mail')
    expect(s.toolCategories).toContain('emails')
  })

  it('turning Sequences on drags CRM in — views, extras, tools, and auto-create', () => {
    const s = composeEffectiveSurface(SCOPED.notes, { sequences: 'on' })
    expect(s.views).toContain('sequences')
    expect(s.views).toContain('contacts')
    expect(s.extraAllowedViews).toContain('companies')
    expect(s.toolCategories).toContain('contacts')
    expect(s.autoCreateEntities).toContain('contact')
  })

  it('turning CRM off in sales takes SEQUENCES down with it — off wins', () => {
    // Flipped deliberately: `requires` is an auto-include for what a live
    // feature needs, never a licence to resurrect something the user switched
    // off. The whole outreach bundle goes, which is the coherent surface.
    const s = composeEffectiveSurface(SCOPED.sales, { crm: 'off' })
    expect(s.views).not.toContain('contacts')
    expect(s.views).not.toContain('sequences')
    expect(s.extraAllowedViews).not.toContain('companies')
    expect(s.toolCategories).not.toContain('contacts')
    expect(s.autoCreateEntities).not.toContain('contact')
  })

  it('naming both sequences and crm off lands in exactly the same place', () => {
    const one = composeEffectiveSurface(SCOPED.sales, { crm: 'off' })
    const both = composeEffectiveSurface(SCOPED.sales, { crm: 'off', sequences: 'off' })
    expect(both).toEqual(one)
  })

  it('carries the effective feature list for the settings UI', () => {
    expect(composeEffectiveSurface(EDITIONS.full).features).toBe('all')
    expect(composeEffectiveSurface(SCOPED.notes, { email: 'on' }).features).toContain('email')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// withEffectiveSurface — the write-back both consumers share
// ───────────────────────────────────────────────────────────────────────────

describe('withEffectiveSurface', () => {
  it('is the identity on every edition with no overrides', () => {
    for (const e of EDITION_LIST) {
      expect(withEffectiveSurface(e)).toEqual(e)
    }
  })

  it('projects exactly composeEffectiveSurface onto the definition fields', () => {
    const overrides = { email: 'on', boards: 'off' } as const
    for (const e of EDITION_LIST) {
      const s = composeEffectiveSurface(e, overrides)
      const projected = withEffectiveSurface(e, overrides)
      expect([...projected.views]).toEqual([...s.views])
      expect([...projected.extraAllowedViews]).toEqual([...s.extraAllowedViews])
      expect(projected.toolCategories).toEqual(s.toolCategories)
      expect(projected.autoCreateEntities).toEqual(s.autoCreateEntities)
    }
  })

  it('passes the edition-level fields through untouched', () => {
    const projected = withEffectiveSurface(EDITIONS.sales, { crm: 'off' })
    expect(projected.id).toBe('sales')
    expect(projected.label).toBe(EDITIONS.sales.label)
    expect(projected.description).toBe(EDITIONS.sales.description)
    expect(projected.features).toEqual(EDITIONS.sales.features)
    expect(projected.onboardingDefaultRoles).toEqual(EDITIONS.sales.onboardingDefaultRoles)
  })

  it('preserves the inherit-all sentinels for a pristine full workspace', () => {
    const projected = withEffectiveSurface(EDITIONS.full, {})
    expect(projected.toolCategories).toBe('all')
    expect(projected.autoCreateEntities).toBe('all')
  })

  it('does not mutate the manifest entry it projects from', () => {
    const before = JSON.stringify(EDITIONS.notes)
    withEffectiveSurface(EDITIONS.notes, { email: 'on', sequences: 'on' })
    expect(JSON.stringify(EDITIONS.notes)).toBe(before)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// The ceiling consequence — the reason `'all'` must stay a sentinel
// ───────────────────────────────────────────────────────────────────────────

describe('offFeatureDeniedToolNames — the MCP deny set', () => {
  it('denies exactly the tools of the features that are off, cascade included', () => {
    // crm off takes sequences and prospecting with it (they require it).
    const denied = offFeatureDeniedToolNames({ edition: EDITIONS.full, overrides: { crm: 'off' } })
    expect(denied.has('list_contacts')).toBe(true)
    expect(denied.has('create_sequence')).toBe(true)
    expect(denied.has('list_emails')).toBe(false)
    expect(denied.has('create_project')).toBe(false)
  })

  it('agrees with the edition ceiling: a denied tool is exactly one the ceiling withholds', () => {
    const overrides = { email: 'off', projects: 'off' } as const
    const denied = offFeatureDeniedToolNames({ edition: EDITIONS.full, overrides })
    const ceiling = computeEditionToolCeiling(withEffectiveSurface(EDITIONS.full, overrides))!
    for (const name of ALL_TOOL_NAMES) expect(denied.has(name), name).toBe(!ceiling.has(name))
  })

  it('never denies a core tool, whatever is off', () => {
    const denied = offFeatureDeniedToolNames({ edition: SCOPED.notes, overrides: { docs: 'off', boards: 'off' } })
    for (const name of ['list_actions', 'create_action', 'list_captures', 'get_calendar_events']) {
      expect(denied.has(name), name).toBe(false)
    }
  })
})

describe('tool ceiling under overrides', () => {
  // The `'all'` SENTINEL is what keeps a tool category added tomorrow from being
  // silently denied. With no hidden or opt-in feature, `'all'` covers every
  // category, so a workspace with nothing switched off has NO ceiling at all.
  it('every edition with no overrides is the null (inherit-all) ceiling', () => {
    for (const e of EDITION_LIST) {
      const s = composeEffectiveSurface(e)
      expect(s.toolCategories, e.id).toBe('all')
      expect(computeEditionToolCeiling({ ...e, ...s }), e.id).toBeNull()
    }
  })

  it('a scoped preset gets eval tools only with the override', () => {
    const off = computeEditionToolCeiling(SCOPED.sales)!
    expect(off.has('list_evals')).toBe(false)

    const s = composeEffectiveSurface(SCOPED.sales, { evals: 'on' })
    const on = computeEditionToolCeiling({ ...SCOPED.sales, ...s })!
    expect(on.has('list_evals')).toBe(true)
    expect(on.has('create_eval_suite')).toBe(true)
    // Nothing the preset already had is lost.
    for (const name of off) expect(on.has(name)).toBe(true)
  })

  it('isFeatureEnabled reads `all` as every feature, evals and browser included', () => {
    const full = { edition: EDITIONS.full, overrides: {} }
    expect(isFeatureEnabled(full, 'email')).toBe(true)
    expect(isFeatureEnabled(full, 'evals')).toBe(true)
    expect(isFeatureEnabled(full, 'browser')).toBe(true)
    expect(isFeatureEnabled({ edition: EDITIONS.full, overrides: { evals: 'off' } }, 'evals')).toBe(false)
    expect(isFeatureEnabled({ edition: SCOPED.sales, overrides: {} }, 'evals')).toBe(false)
    expect(isFeatureEnabled({ edition: SCOPED.sales, overrides: { evals: 'on' } }, 'evals')).toBe(true)
  })

  it('full with a feature off gets a REAL, narrowed ceiling', () => {
    const s = composeEffectiveSurface(EDITIONS.full, { email: 'off' })
    const ceiling = computeEditionToolCeiling({ ...EDITIONS.full, ...s })
    expect(ceiling).not.toBeNull()
    expect(ceiling!.has('list_emails')).toBe(false)
    // …while everything else it still has survives, evals included.
    expect(ceiling!.has('create_project')).toBe(true)
    expect(ceiling!.has('list_captures')).toBe(true)
    expect(ceiling!.has('list_evals')).toBe(true)
  })

  it('a scoped notes preset with Email on widens the ceiling to include email tools', () => {
    const base = computeEditionToolCeiling(SCOPED.notes)!
    const s = composeEffectiveSurface(SCOPED.notes, { email: 'on' })
    const widened = computeEditionToolCeiling({ ...SCOPED.notes, ...s })!
    expect(base.has('list_emails')).toBe(false)
    expect(widened.has('list_emails')).toBe(true)
    for (const name of base) expect(widened.has(name)).toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Evals and the Agent browser — opt-in until every feature went on for everyone
// ───────────────────────────────────────────────────────────────────────────

describe('evals and the agent browser are on by default', () => {
  const EDS = ['full', 'sales', 'notes', 'brain', 'service'] as const

  it('are ON in EVERY edition — views, gate, and tools together', () => {
    for (const id of EDS) {
      const resolved = { edition: EDITIONS[id], overrides: {} }
      expect(isFeatureEnabled(resolved, 'evals'), id).toBe(true)
      expect(isFeatureEnabled(resolved, 'browser'), id).toBe(true)
      expect(isOnByDefault('evals', id), id).toBe(true)
      expect(isOnByDefault('browser', id), id).toBe(true)
      expect(withEffectiveSurface(EDITIONS[id], {}).views, id).toContain('evals')
      // MCP's deny set (it is not edition-ceilinged) is empty: nothing is off.
      expect(offFeatureDeniedToolNames(resolved).size, id).toBe(0)
    }
  })

  it('an `on` is a no-op and is pruned; an `off` is load-bearing and survives', () => {
    for (const id of EDS) {
      expect(pruneNoOpOverrides(id, { evals: 'on' }), id).toEqual({})
      expect(pruneNoOpOverrides(id, { browser: 'on' }), id).toEqual({})
      expect(pruneNoOpOverrides(id, { evals: 'off' }), id).toEqual({ evals: 'off' })
    }
  })

  it('an `off` takes the feature’s tools out of MCP too', () => {
    const denied = offFeatureDeniedToolNames({ edition: EDITIONS.full, overrides: { evals: 'off', browser: 'off' } })
    expect(denied.has('list_evals')).toBe(true)
    expect(denied.has('create_eval_suite')).toBe(true)
    expect(denied.has('read_browser_page')).toBe(true)
    expect(denied.has('list_emails')).toBe(false)
  })

  it('an `off` takes the feature out of the surface and collapses the sentinel', () => {
    const keys = effectiveFeatureKeys(EDITIONS.full, { evals: 'off' })
    expect(keys).not.toBe('all')
    expect(keys).not.toContain('evals')
    expect(keys).toContain('browser')
    const ceiling = computeEditionToolCeiling(withEffectiveSurface(EDITIONS.full, { browser: 'off' }))!
    expect(ceiling).not.toBeNull()
    expect(ceiling.has('list_evals')).toBe(true)
  })
})

describe('feature-gated system recipes: prospecting', () => {
  const BUILD_PROSPECT_LIST = 'c4b81f6d-2a7e-4d39-b0c6-5e9a3f18d247' // migration 322
  const PROSPECTING_PLAYBOOK = '1b502445-3db0-4f04-bc4b-39505d2fe5ca' // migration 319

  it('a workspace with Prospecting off hides the build-prospect-list recipe and the playbook', () => {
    const hidden = featureGatedRecipeExclusions({ edition: EDITIONS.full, overrides: { prospecting: 'off' } })
    expect(hidden).toContain(BUILD_PROSPECT_LIST)
    expect(hidden).toContain(PROSPECTING_PLAYBOOK)
  })

  it('a workspace with Prospecting on lists them', () => {
    expect(isFeatureEnabled({ edition: EDITIONS.full, overrides: {} }, 'prospecting')).toBe(true)
    const hidden = featureGatedRecipeExclusions({ edition: EDITIONS.full, overrides: {} })
    expect(hidden).not.toContain(BUILD_PROSPECT_LIST)
    expect(hidden).not.toContain(PROSPECTING_PLAYBOOK)
  })
})

describe('feature-gated system recipes: the A1 recipes (migration 323)', () => {
  const KNOWLEDGE_RECIPES = [
    '46d24d23-ef85-48b9-b16d-4c912899459d', // what-do-we-know
    'dc51017f-b90b-485e-a701-806f9c7b9d18', // whats-changed
    '29b2a03c-a998-4133-b9c5-70b969f86a41', // everything-about
  ]
  const FIND_ANYTHING = '326b5c1f-552e-4e83-af87-8cbb960de47b'
  const PROJECT_STATUS_UPDATE = 'ca443e96-3c3f-419a-b1f4-4f444bbe8c5c'
  const ACTIONS_RECIPES = [
    '4fb68c47-22fb-4073-9600-c037f8ed993b', // my-todo-list
    '2cb64212-9dd5-42df-bede-3dc46313cc4a', // overdue-work
  ]

  it('Knowledge off hides its three recipes; Projects off hides project-status-update', () => {
    const noKnowledge = featureGatedRecipeExclusions({ edition: EDITIONS.full, overrides: { knowledge: 'off' } })
    for (const id of KNOWLEDGE_RECIPES) expect(noKnowledge).toContain(id)
    expect(noKnowledge).not.toContain(PROJECT_STATUS_UPDATE)
    const noProjects = featureGatedRecipeExclusions({ edition: EDITIONS.full, overrides: { projects: 'off' } })
    expect(noProjects).toContain(PROJECT_STATUS_UPDATE)
  })

  it('find-anything is the general front door: listed in every edition, Notes and Knowledge-off included', () => {
    expect(SCOPED.notes.features).not.toContain('knowledge')
    expect(featureGatedRecipeExclusions({ edition: SCOPED.notes, overrides: {} })).not.toContain(FIND_ANYTHING)
    expect(featureGatedRecipeExclusions({ edition: EDITIONS.full, overrides: { knowledge: 'off' } })).not.toContain(FIND_ANYTHING)
    expect(ALL_FEATURE_GATED_RECIPE_IDS).not.toContain(FIND_ANYTHING)
  })

  it('Flows off hides the Flows core and build-a-workflow (migration 324); Flows on lists them', () => {
    const FLOWS_PLAYBOOK = '1ef0c12f-5d78-41ef-ab12-714512fa03cd'
    const BUILD_A_WORKFLOW = 'a1c4ac7d-4b00-4af4-a97e-1c79abaed9b3'
    const noFlows = featureGatedRecipeExclusions({ edition: EDITIONS.full, overrides: { flows: 'off' } })
    expect(noFlows).toContain(FLOWS_PLAYBOOK)
    expect(noFlows).toContain(BUILD_A_WORKFLOW)
    const withFlows = featureGatedRecipeExclusions({ edition: EDITIONS.full, overrides: {} })
    expect(withFlows).not.toContain(FLOWS_PLAYBOOK)
    expect(withFlows).not.toContain(BUILD_A_WORKFLOW)
  })

  it('the Actions recipes are core: never hidden', () => {
    const allOff = featureGatedRecipeExclusions({ edition: SCOPED.notes, overrides: { knowledge: 'off', projects: 'off' } })
    for (const id of ACTIONS_RECIPES) expect(allOff).not.toContain(id)
    for (const id of ACTIONS_RECIPES) expect(ALL_FEATURE_GATED_RECIPE_IDS).not.toContain(id)
  })
})

// A1c docs-goals-tools
describe('feature-gated system recipes: Documents, Initiatives, Evals, Browser and Library (migration 327)', () => {
  const DOCUMENTS_PLAYBOOK = 'e8d88dec-0326-41b0-971e-f974c21cdefb'
  const WRITE_A_DOCUMENT = 'a4b9263b-eb4d-4c57-afcc-7f8cd40bf1bb'
  const INITIATIVES_PLAYBOOK = '1d277e63-8a44-4ca6-b743-322a812971a9'
  const INITIATIVE_REVIEW = '5472e163-15c1-4f7d-a263-55268a3825c3'
  const EVALS_PLAYBOOK = '8e08678d-1944-4a10-95ec-b9e73a7feea4'
  const BROWSER_PLAYBOOK = 'eec790ec-399f-416d-8189-c883859ba8c3'
  const LIBRARY_PLAYBOOK = '800dc79b-a55f-4ef5-802d-8a6945e38460'

  it('Documents off hides the Documents core and write-a-document; on lists them', () => {
    const off = featureGatedRecipeExclusions({ edition: EDITIONS.full, overrides: { docs: 'off' } })
    expect(off).toContain(DOCUMENTS_PLAYBOOK)
    expect(off).toContain(WRITE_A_DOCUMENT)
    const on = featureGatedRecipeExclusions({ edition: EDITIONS.full, overrides: {} })
    expect(on).not.toContain(DOCUMENTS_PLAYBOOK)
    expect(on).not.toContain(WRITE_A_DOCUMENT)
  })

  it('Projects off hides the Initiatives core and initiative-review; on lists them', () => {
    const off = featureGatedRecipeExclusions({ edition: EDITIONS.full, overrides: { projects: 'off' } })
    expect(off).toContain(INITIATIVES_PLAYBOOK)
    expect(off).toContain(INITIATIVE_REVIEW)
    const on = featureGatedRecipeExclusions({ edition: EDITIONS.full, overrides: {} })
    expect(on).not.toContain(INITIATIVES_PLAYBOOK)
    expect(on).not.toContain(INITIATIVE_REVIEW)
  })

  it('the Evals and Browser cores stay with their features; the Library core is core, never hidden', () => {
    expect(FEATURES.evals.systemRecipeIds).toContain(EVALS_PLAYBOOK)
    expect(FEATURES.browser.systemRecipeIds).toContain(BROWSER_PLAYBOOK)
    const on = featureGatedRecipeExclusions({ edition: EDITIONS.full, overrides: {} })
    expect(on).not.toContain(EVALS_PLAYBOOK)
    expect(on).not.toContain(BROWSER_PLAYBOOK)
    const off = featureGatedRecipeExclusions({ edition: EDITIONS.full, overrides: { evals: 'off', browser: 'off' } })
    expect(off).toContain(EVALS_PLAYBOOK)
    expect(off).toContain(BROWSER_PLAYBOOK)
    expect(ALL_FEATURE_GATED_RECIPE_IDS).not.toContain(LIBRARY_PLAYBOOK)
  })
})

// A1c crm-outreach
describe('feature-gated system recipes: CRM, Prospecting, Sequences and Campaigns (migration 326)', () => {
  const CRM_PLAYBOOK = 'e05a0562-a4a2-4700-8c7b-19435fa7430b'
  const STALE_RELATIONSHIPS = 'a7337d9e-1ec0-4ed8-b6f0-0311edd54335'
  const SEQUENCES_PLAYBOOK = '1438190a-646d-4709-ae89-22e24ddf340b'
  const LAUNCH_A_SEQUENCE = '287cbaef-c539-42b2-84be-3cbfef7a88ec'
  const PROSPECTING_PLAYBOOK = '1b502445-3db0-4f04-bc4b-39505d2fe5ca'
  const BUILD_PROSPECT_LIST = 'c4b81f6d-2a7e-4d39-b0c6-5e9a3f18d247'
  const CAMPAIGNS_PLAYBOOK = '48b8e8bd-2299-43b2-9a65-f9928a232b90'

  it('CRM off hides the CRM core and stale-relationships; on lists them', () => {
    const off = featureGatedRecipeExclusions({ edition: EDITIONS.full, overrides: { crm: 'off' } })
    expect(off).toContain(CRM_PLAYBOOK)
    expect(off).toContain(STALE_RELATIONSHIPS)
    const on = featureGatedRecipeExclusions({ edition: EDITIONS.full, overrides: {} })
    expect(on).not.toContain(CRM_PLAYBOOK)
    expect(on).not.toContain(STALE_RELATIONSHIPS)
  })

  it('Sequences off hides the Sequences core and launch-a-sequence, and leaves the CRM recipe listed', () => {
    const off = featureGatedRecipeExclusions({ edition: EDITIONS.full, overrides: { sequences: 'off' } })
    expect(off).toContain(SEQUENCES_PLAYBOOK)
    expect(off).toContain(LAUNCH_A_SEQUENCE)
    expect(off).not.toContain(STALE_RELATIONSHIPS)
    const on = featureGatedRecipeExclusions({ edition: EDITIONS.full, overrides: {} })
    expect(on).not.toContain(LAUNCH_A_SEQUENCE)
  })

  it('the rewritten Prospecting and Campaigns rows stay with their features', () => {
    expect(FEATURES.prospecting.systemRecipeIds).toEqual(expect.arrayContaining([PROSPECTING_PLAYBOOK, BUILD_PROSPECT_LIST]))
    expect(FEATURES.campaigns.systemRecipeIds).toContain(CAMPAIGNS_PLAYBOOK)
    const off = featureGatedRecipeExclusions({ edition: EDITIONS.full, overrides: { campaigns: 'off' } })
    expect(off).toContain(CAMPAIGNS_PLAYBOOK)
    expect(off).not.toContain(STALE_RELATIONSHIPS)
  })
})

// A1c meetings-mail
describe('feature-gated system recipes: meetings and mail (migration 325)', () => {
  const MAIL_ROWS = [
    '1534bd72-4cd1-4a53-b14a-a8fe8c4a0fb4', // mail-playbook
    '0c43b03b-480d-4f59-99d3-1fd522cc34d2', // write-in-your-tone
    '72cc7391-28bf-46ef-a0f2-6206bfb5de64', // clear-inbox
  ]
  const CORE_ROWS = [
    'b6024df5-6b85-40ce-9975-cb334bcfba18', // calendar-playbook
    'f67ca385-0771-4b55-8699-932b5de20117', // meeting-prep (the 159 row)
    '9d25caa6-0009-414c-88cb-6ba59cec2434', // find-a-time
    'f896062b-8182-4f94-8bca-40b53aee96ce', // captures-playbook
    '32d9773e-608d-49f3-a090-846aa9e651b3', // meeting-recap
    '6d18cf9f-9fab-496e-8780-4274071a865d', // meeting-follow-up
  ]

  it('Email off hides the Mail core and its two recipes; on lists them', () => {
    const off = featureGatedRecipeExclusions({ edition: EDITIONS.full, overrides: { email: 'off' } })
    for (const id of MAIL_ROWS) expect(off).toContain(id)
    const on = featureGatedRecipeExclusions({ edition: EDITIONS.full, overrides: {} })
    for (const id of MAIL_ROWS) expect(on).not.toContain(id)
  })

  it('the calendar and captures rows are core: never hidden, whatever is off', () => {
    const allOff = featureGatedRecipeExclusions({ edition: SCOPED.notes, overrides: { email: 'off', crm: 'off', knowledge: 'off' } })
    for (const id of CORE_ROWS) expect(allOff).not.toContain(id)
    for (const id of CORE_ROWS) expect(ALL_FEATURE_GATED_RECIPE_IDS).not.toContain(id)
  })
})
