/**
 * EVAL-capture exclusion in the shared capture-visibility helpers.
 *
 * An eval capture (`captures.is_eval`, migration 252) is a synthetic mock
 * meeting stored as a real `captures` row so the unmodified live-agent engine
 * can run against it. These helpers are what keep it out of the product: they
 * run on SERVICE-ROLE clients on the MCP / unattended paths, so this predicate
 * — not RLS — is the enforcement (docs/plans/evals.md §5.2).
 *
 * The property under test is DEFAULT-EXCLUDE. A forgotten flag has to fail
 * CLOSED: an Evals screen that renders nothing is loud and gets fixed, whereas
 * a mock sales call sitting in the Captures list is silent and does not.
 *
 * Companion to captures.visibility.test.ts, which covers the orthogonal
 * private/workspace axis on the same helpers.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  applyCaptureVisibility,
  applyEmbeddedCaptureVisibility,
  captureVisibleToRequester,
  isCaptureVisible,
} from '../_shared'

const USER_ID = 'user-mine'
const OTHER_USER_ID = 'user-theirs'
const WORKSPACE_ID = 'ws-1'

/** Records every filter the helper applies, and stays chainable throughout. */
function recordingQuery() {
  const eq: Array<[string, unknown]> = []
  const neq: Array<[string, unknown]> = []
  const or: Array<[string, unknown]> = []
  const chain = {
    eq: vi.fn((col: string, val: unknown) => {
      eq.push([col, val])
      return chain
    }),
    neq: vi.fn((col: string, val: unknown) => {
      neq.push([col, val])
      return chain
    }),
    or: vi.fn((filter: string, opts?: unknown) => {
      or.push([filter, opts])
      return chain
    }),
  }
  return { chain, eq, neq, or }
}

describe('applyCaptureVisibility — eval fence', () => {
  it('excludes eval captures by default, for a real requester', () => {
    const { chain, neq } = recordingQuery()
    applyCaptureVisibility(chain, USER_ID)
    expect(neq).toContainEqual(['is_eval', true])
  })

  it('excludes eval captures by default, for a null requester too', () => {
    const { chain, neq } = recordingQuery()
    applyCaptureVisibility(chain, null)
    expect(neq).toContainEqual(['is_eval', true])
  })

  it('drops the fence ONLY when includeEvalCaptures is explicitly true', () => {
    const { chain, neq } = recordingQuery()
    applyCaptureVisibility(chain, USER_ID, true)
    expect(neq).toEqual([])
  })

  it('treats a falsy flag as exclude — undefined and false both fence', () => {
    for (const flag of [undefined, false] as const) {
      const { chain, neq } = recordingQuery()
      applyCaptureVisibility(chain, USER_ID, flag)
      expect(neq, `includeEvalCaptures=${String(flag)} must still fence`).toContainEqual([
        'is_eval',
        true,
      ])
    }
  })

  it('keeps the private/workspace predicate intact alongside the fence', () => {
    const { chain, or } = recordingQuery()
    applyCaptureVisibility(chain, USER_ID)
    expect(or).toContainEqual([`visibility.eq.workspace,user_id.eq.${USER_ID}`, undefined])

    const anon = recordingQuery()
    applyCaptureVisibility(anon.chain, null)
    expect(anon.eq).toContainEqual(['visibility', 'workspace'])
  })

  it("uses neq.true rather than eq.false, so a pre-migration NULL row still lists", () => {
    const { chain, eq } = recordingQuery()
    applyCaptureVisibility(chain, USER_ID)
    expect(eq.filter(([col]) => col === 'is_eval')).toEqual([])
  })
})

describe('applyEmbeddedCaptureVisibility — eval fence', () => {
  it('qualifies the fence with the embed alias', () => {
    const { chain, neq } = recordingQuery()
    applyEmbeddedCaptureVisibility(chain, USER_ID, 'capture')
    expect(neq).toContainEqual(['capture.is_eval', true])
  })

  it('drops the fence only on an explicit true', () => {
    const { chain, neq } = recordingQuery()
    applyEmbeddedCaptureVisibility(chain, USER_ID, 'capture', true)
    expect(neq).toEqual([])
  })

  it('still applies the embedded private/workspace predicate', () => {
    const { chain, or } = recordingQuery()
    applyEmbeddedCaptureVisibility(chain, USER_ID, 'capture')
    expect(or).toContainEqual([
      `visibility.eq.workspace,user_id.eq.${USER_ID}`,
      { referencedTable: 'capture' },
    ])
  })
})

describe('isCaptureVisible — eval fence', () => {
  const evalCapture = { visibility: 'workspace', user_id: USER_ID, is_eval: true }
  const realCapture = { visibility: 'workspace', user_id: OTHER_USER_ID, is_eval: false }

  it('hides an eval capture even from its own creator', () => {
    expect(isCaptureVisible(evalCapture, USER_ID)).toBe(false)
  })

  it('hides an eval capture that is also private to the requester', () => {
    expect(isCaptureVisible({ visibility: 'private', user_id: USER_ID, is_eval: true }, USER_ID)).toBe(
      false,
    )
  })

  it('shows it only under an explicit includeEvalCaptures', () => {
    expect(isCaptureVisible(evalCapture, USER_ID, true)).toBe(true)
  })

  it('leaves non-eval rows exactly as they were', () => {
    expect(isCaptureVisible(realCapture, USER_ID)).toBe(true)
    expect(isCaptureVisible(realCapture, null)).toBe(true)
    expect(isCaptureVisible(null, USER_ID)).toBe(false)
  })

  it('passes a row whose is_eval was not SELECTed — the query predicate is the real fence', () => {
    // Defence-in-depth re-check, not the primary gate: an absent column reads
    // as undefined, which must not silently blank out every existing caller.
    expect(isCaptureVisible({ visibility: 'workspace', user_id: OTHER_USER_ID }, USER_ID)).toBe(true)
  })
})

describe('captureVisibleToRequester — eval fence', () => {
  function supabaseReturning(row: Record<string, unknown> | null) {
    const selected: string[] = []
    const chain: Record<string, unknown> = {}
    const self = () => chain
    chain.select = vi.fn((cols: string) => {
      selected.push(cols)
      return chain
    })
    chain.eq = vi.fn(self)
    chain.maybeSingle = vi.fn(async () => ({ data: row, error: null }))
    return { supabase: { from: vi.fn(() => chain) } as never, selected }
  }

  it('selects is_eval so the row-level re-check can actually see it', async () => {
    const { supabase, selected } = supabaseReturning({
      visibility: 'workspace',
      user_id: USER_ID,
      is_eval: false,
    })
    await captureVisibleToRequester(supabase, 'cap-1', WORKSPACE_ID, USER_ID)
    expect(selected[0].split(',').map((c) => c.trim())).toContain('is_eval')
  })

  it('refuses an eval capture by default and allows it on an explicit flag', async () => {
    const row = { visibility: 'workspace', user_id: USER_ID, is_eval: true }
    const a = supabaseReturning(row)
    expect(await captureVisibleToRequester(a.supabase, 'cap-1', WORKSPACE_ID, USER_ID)).toBe(false)

    const b = supabaseReturning(row)
    expect(await captureVisibleToRequester(b.supabase, 'cap-1', WORKSPACE_ID, USER_ID, true)).toBe(
      true,
    )
  })
})
