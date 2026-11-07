/**
 * The eval tools reach a caller through FIVE independent name registries, and
 * a tool missing from any one of them fails SILENTLY — the model simply never
 * sees it, with no error anywhere.
 *
 * Three of the five are checked here because the other two already have their
 * own guards: `tool-registry-sync.test.ts` gates the build on the registry
 * itself, and `mcp/tools/__tests__/registration.test.ts` asserts every
 * executable chat tool has a `dial8_*` twin.
 *
 * The edition ceiling is the one that is easiest to get wrong and hardest to
 * notice: `computeEditionToolCeiling` INTERSECTS an edition's categories with
 * the agent allowlist, so a category reachable from no feature is quietly
 * dropped the moment a workspace switches any feature off. That would mean the
 * eval tools existing everywhere except in a workspace that has trimmed its
 * features, evals still on.
 */
import { describe, it, expect } from 'vitest'
import { TOOL_CATEGORIES, getToolNamesForCategories } from '@/lib/ai/tool-registry'
import { FEATURES, EDITION_LIST, withEffectiveSurface } from '@/lib/editions/manifest'
import { computeEditionToolCeiling } from '@/lib/editions/tool-ceiling'
import { SCOPED } from '@/test/editions'

const SIX = ['create_eval_suite','create_eval_case','list_evals','start_eval_run','get_eval_run','update_eval_case']

describe('the eval tool-name registries', () => {
  it('tool-registry has the evals category with all six', () => {
    const cat = TOOL_CATEGORIES.find((c) => c.id === 'evals')
    expect(cat).toBeDefined()
    for (const n of SIX) expect(cat!.tools.map((t: {name:string}) => t.name)).toContain(n)
  })
  it('getToolNamesForCategories resolves them', () => {
    const names = getToolNamesForCategories(['evals'])
    for (const n of SIX) expect(names).toContain(n)
  })
  it('the `evals` category belongs to the evals feature, and to it alone', () => {
    // Ownership matters twice over: a category reachable from no feature at all
    // would be silently ceilinged out everywhere, and a category ALSO owned by
    // another feature could not be switched off without taking that feature's
    // tools down with it.
    const owners = Object.values(FEATURES).filter((f) => f.toolCategories.includes('evals'))
    expect(owners.map((f) => f.id)).toEqual(['evals'])
    // A standard feature: on for everyone (manifest invariant 5), and the
    // workspace owner's to switch off.
    expect(owners[0].optIn).toBeFalsy()
    expect(owners[0].hidden).toBeFalsy()
  })

  it('EVERY edition grants the eval tools: no edition imposes a ceiling', () => {
    for (const edition of EDITION_LIST) {
      // Null is inherit-all: every tool, the six included.
      expect(computeEditionToolCeiling(edition), `edition ${edition.id}`).toBeNull()
    }
  })

  it('an `evals: off` override withholds all six in every edition', () => {
    for (const edition of EDITION_LIST) {
      const ceiling = computeEditionToolCeiling(
        withEffectiveSurface(edition, { evals: 'off' }),
      )
      expect(ceiling, `edition ${edition.id} + evals:off must impose a ceiling`).not.toBeNull()
      for (const n of SIX) {
        expect(ceiling!.has(n), `edition ${edition.id} + evals:off must not grant ${n}`).toBe(false)
      }
    }
  })

  it('an `evals: on` override grants all six even where the preset left evals out', () => {
    const ceiling = computeEditionToolCeiling(
      withEffectiveSurface(SCOPED.sales, { evals: 'on' }),
    )
    expect(ceiling).not.toBeNull()
    for (const n of SIX) {
      expect(ceiling!.has(n), `scoped sales + evals:on must grant ${n}`).toBe(true)
    }
  })
})
