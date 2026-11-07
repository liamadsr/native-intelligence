/**
 * Tests for src/lib/tasks/task-lens.ts — the lens PATCH body parser and the
 * shared normalization helpers.
 *
 * The invariant this file exists to protect above all others is the THREE-STATE
 * READING, lifted from push-overrides.ts's clearable readers: ABSENT means "do not
 * touch", `null` means "clear", and a value means "set". Those three must stay
 * distinguishable all the way through the parser, because folding null to absent
 * is the exact bug that leaves the old assignee on the ticket while the chip shows
 * nobody.
 *
 * Everything else here is about rejecting junk LOUDLY rather than dropping it — a
 * silently ignored field surfaces days later as "the priority didn't stick".
 */
import { describe, it, expect } from 'vitest'
import {
  isLensProvider,
  LENS_MAX_LABELS,
  lensDateOnly,
  lensRef,
  lensText,
  linearPriorityInput,
  linearPriorityRef,
  noneEditable,
  parseLensUpdate,
} from '../task-lens'

/** `{ fields: … }` — the shape the lens PATCH takes. */
function body(fields: unknown): unknown {
  return { fields }
}

// ---- The three-state reading ----------------------------------------------

describe('parseLensUpdate — absent vs null vs value', () => {
  it('omits a field the body never named', () => {
    const res = parseLensUpdate(body({ assignee_id: 'u-1' }), 'jira')
    expect(res).toEqual({ ok: true, value: { assignee_id: 'u-1' } })
    // The distinction that matters: `due_date` is not a key at all, so the write
    // payload cannot mention it and the provider cannot clear it.
    if (res.ok) expect('due_date' in res.value).toBe(false)
  })

  it('keeps an explicit null as null — the CLEAR', () => {
    const res = parseLensUpdate(
      body({ assignee_id: null, priority_id: null, due_date: null }),
      'jira',
    )
    expect(res).toEqual({
      ok: true,
      value: { assignee_id: null, priority_id: null, due_date: null },
    })
  })

  it('distinguishes a cleared field from an untouched one by KEY PRESENCE', () => {
    const cleared = parseLensUpdate(body({ due_date: null }), 'linear')
    const untouched = parseLensUpdate(body({ assignee_id: 'u-1' }), 'linear')
    expect(cleared.ok && 'due_date' in cleared.value).toBe(true)
    expect(untouched.ok && 'due_date' in untouched.value).toBe(false)
  })

  it('trims a value rather than passing whitespace through', () => {
    const res = parseLensUpdate(body({ assignee_id: '  u-1  ' }), 'jira')
    expect(res).toEqual({ ok: true, value: { assignee_id: 'u-1' } })
  })

  it('rejects an EMPTY STRING — `null` is how a clear is spelled', () => {
    const res = parseLensUpdate(body({ assignee_id: '' }), 'jira')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/use null to clear/)
  })

  it('rejects a whitespace-only value for the same reason', () => {
    expect(parseLensUpdate(body({ priority_id: '   ' }), 'jira').ok).toBe(false)
  })
})

// ---- Envelope + unknown keys ----------------------------------------------

describe('parseLensUpdate — envelope', () => {
  it.each([[null], [7], ['str'], [[1, 2]]])('rejects the non-object body %s', (raw) => {
    expect(parseLensUpdate(raw, 'jira').ok).toBe(false)
  })

  it('rejects unknown TOP-LEVEL body fields', () => {
    const res = parseLensUpdate({ fields: { assignee_id: 'u-1' }, overrides: {} }, 'jira')
    expect(res).toEqual({ ok: false, error: 'Unknown body field(s): overrides' })
  })

  it.each([[undefined], [null], [7], [[1]]])('rejects `fields` = %s', (fields) => {
    expect(parseLensUpdate({ fields }, 'jira').ok).toBe(false)
  })

  it('rejects an EMPTY fields object — a PATCH that changes nothing is a bug', () => {
    const res = parseLensUpdate(body({}), 'jira')
    expect(res).toEqual({
      ok: false,
      error: '`fields` must name at least one field to change',
    })
  })

  /**
   * The push-override spellings are the most likely wrong keys, because the
   * compose panel already sends them to a DIFFERENT endpoint — so a copy-paste
   * lands here. Named in the error rather than dropped.
   */
  it.each([['assignee_account_id'], ['assignee_gid'], ['labels'], ['priority'], ['due_on']])(
    'rejects the unknown field %s by name',
    (key) => {
      const res = parseLensUpdate(body({ [key]: 'x' }), 'jira')
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toContain(key)
    },
  )
})

// ---- due_date -------------------------------------------------------------

describe('parseLensUpdate — due_date', () => {
  it('accepts a YYYY-MM-DD date', () => {
    expect(parseLensUpdate(body({ due_date: '2026-08-01' }), 'jira')).toEqual({
      ok: true,
      value: { due_date: '2026-08-01' },
    })
  })

  it.each([['2026-8-1'], ['01/08/2026'], ['2026-08-01T09:00:00Z'], ['tomorrow']])(
    'rejects the malformed date %s',
    (value) => {
      expect(parseLensUpdate(body({ due_date: value }), 'jira').ok).toBe(false)
    },
  )

  /** A shape-valid date that is not a real one — the calendar check, not a regex. */
  it('rejects 2026-02-31, which matches the pattern but is not a date', () => {
    expect(parseLensUpdate(body({ due_date: '2026-02-31' }), 'jira').ok).toBe(false)
  })

  it('rejects a non-string, non-null due_date', () => {
    expect(parseLensUpdate(body({ due_date: 20260801 }), 'jira').ok).toBe(false)
  })
})

// ---- label_ids: full replacement, never null ------------------------------

describe('parseLensUpdate — label_ids', () => {
  it('accepts an array of ids', () => {
    expect(parseLensUpdate(body({ label_ids: ['a', 'b'] }), 'linear')).toEqual({
      ok: true,
      value: { label_ids: ['a', 'b'] },
    })
  })

  /**
   * `[]` IS the clear. Preserved rather than folded to absent, because a
   * full-replacement array already expresses "no labels" and a second encoding
   * would give the UI two ways to say one thing.
   */
  it('preserves an EMPTY array as the clear', () => {
    const res = parseLensUpdate(body({ label_ids: [] }), 'linear')
    expect(res).toEqual({ ok: true, value: { label_ids: [] } })
  })

  it('rejects null — `[]` is the clear, not null', () => {
    expect(parseLensUpdate(body({ label_ids: null }), 'linear').ok).toBe(false)
  })

  it.each([[[1, 2]], [['a', '']], [['a', null]], ['a']])(
    'rejects the malformed label_ids %s',
    (value) => {
      expect(parseLensUpdate(body({ label_ids: value }), 'linear').ok).toBe(false)
    },
  )

  it('trims each id', () => {
    expect(parseLensUpdate(body({ label_ids: [' a ', 'b'] }), 'linear')).toEqual({
      ok: true,
      value: { label_ids: ['a', 'b'] },
    })
  })
})

// ---- The label cap --------------------------------------------------------

/**
 * `label_ids` is the only lens field whose COST is linear in its own length, and
 * Asana is why: its tags are not a field on the task, they are `addTag`/`removeTag`
 * endpoints at ONE HTTP CALL PER TAG, issued sequentially and each subject to the
 * transport's retry-with-sleep. So a body naming 500 tags is 500 serial Asana calls
 * inside one request with a panel waiting on it.
 *
 * The cap lives in the PARSER rather than in the Asana collector so the caller
 * learns the limit before anything is written, instead of from a request that
 * half-applied a tag diff and then timed out.
 */
describe('parseLensUpdate — label cap', () => {
  /** `n` distinct ids — distinct so the cap is tested on COUNT, not on duplicates. */
  function labels(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `label-${i}`)
  }

  it('accepts exactly LENS_MAX_LABELS', () => {
    const res = parseLensUpdate(body({ label_ids: labels(LENS_MAX_LABELS) }), 'asana')
    expect(res.ok).toBe(true)
    expect(res.ok && res.value.label_ids).toHaveLength(LENS_MAX_LABELS)
  })

  it('rejects one over the cap with the too_many_labels code', () => {
    const res = parseLensUpdate(body({ label_ids: labels(LENS_MAX_LABELS + 1) }), 'asana')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('too_many_labels')
  })

  it('names both the count and the limit, so the panel can say what to do', () => {
    const res = parseLensUpdate(body({ label_ids: labels(500) }), 'asana')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toContain('500')
      expect(res.error).toContain(String(LENS_MAX_LABELS))
    }
  })

  /**
   * ALL THREE providers, even though only Asana pays per-tag: one lens contract
   * with one limit beats three that differ, and no real ticket carries 50 labels.
   */
  it.each([['asana'], ['jira'], ['linear']] as const)('caps %s too', (provider) => {
    expect(parseLensUpdate(body({ label_ids: labels(51) }), provider).ok).toBe(false)
  })

  /**
   * The COUNT is checked before the CONTENTS. Validating 5000 entries only to
   * reject the array on its length would be the very work the cap exists to avoid —
   * so an oversized array full of junk still fails on the cap, not on the junk.
   */
  it('rejects on the cap rather than walking an oversized array', () => {
    const oversized: unknown[] = labels(LENS_MAX_LABELS + 1)
    oversized[LENS_MAX_LABELS] = 42 // would fail the per-entry check, if reached
    const res = parseLensUpdate(body({ label_ids: oversized }), 'asana')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('too_many_labels')
  })

  /** Every OTHER parse failure stays uncoded — a code is for what the UI can act on. */
  it('leaves an ordinary malformed-array failure uncoded', () => {
    const res = parseLensUpdate(body({ label_ids: ['ok', ''] }), 'asana')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBeUndefined()
  })
})

// ---- Asana has no priority ------------------------------------------------

describe('parseLensUpdate — Asana priority', () => {
  /**
   * Rejected BY NAME rather than sent and refused: Asana has no native priority
   * field at all (only per-project enum custom fields), so the provider's own
   * error would name neither the panel nor the field.
   */
  it('rejects priority_id for asana', () => {
    const res = parseLensUpdate(body({ priority_id: '3' }), 'asana')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/Asana has no priority field/)
  })

  it('rejects a CLEARED priority for asana too — there is nothing to clear', () => {
    expect(parseLensUpdate(body({ priority_id: null }), 'asana').ok).toBe(false)
  })

  it('still accepts the other three fields for asana', () => {
    expect(
      parseLensUpdate(
        body({ assignee_id: 'g-1', due_date: '2026-08-01', label_ids: ['t-1'] }),
        'asana',
      ),
    ).toEqual({
      ok: true,
      value: { assignee_id: 'g-1', due_date: '2026-08-01', label_ids: ['t-1'] },
    })
  })

  it('accepts priority_id for jira and linear', () => {
    expect(parseLensUpdate(body({ priority_id: '3' }), 'jira').ok).toBe(true)
    expect(parseLensUpdate(body({ priority_id: '3' }), 'linear').ok).toBe(true)
  })
})

// ---- Linear's priority scale ---------------------------------------------

describe('linearPriorityRef', () => {
  it.each([
    [1, 'Urgent'],
    [2, 'High'],
    [3, 'Medium'],
    [4, 'Low'],
  ])('maps %i to %s', (priority, name) => {
    expect(linearPriorityRef(priority)).toEqual({ id: String(priority), name })
  })

  /**
   * 0 is a REAL value Linear stores ("No priority") but is indistinguishable from
   * unset as a chip, and the write path clears with 0 anyway — so it normalizes to
   * null and "no priority" stays ONE state in the UI rather than two that look
   * identical and behave differently.
   */
  it('normalizes 0 (No priority) to null', () => {
    expect(linearPriorityRef(0)).toBeNull()
  })

  it.each([[null], [undefined], [5], [-1], [2.5]])('returns null for %s', (value) => {
    expect(linearPriorityRef(value as number)).toBeNull()
  })
})

describe('linearPriorityInput', () => {
  it.each([['0', 0], ['1', 1], ['4', 4]])('maps "%s" to %i', (id, expected) => {
    expect(linearPriorityInput(id)).toEqual({ ok: true, value: expected })
  })

  /** Linear cannot UNSET priority — a clear is priority 0. */
  it('maps a clear (null) to 0', () => {
    expect(linearPriorityInput(null)).toEqual({ ok: true, value: 0 })
  })

  it.each([['5'], ['-1'], ['high'], ['1.0'], ['']])('rejects "%s"', (id) => {
    expect(linearPriorityInput(id).ok).toBe(false)
  })
})

// ---- Shared helpers ------------------------------------------------------

describe('lensDateOnly', () => {
  it('slices a date off a datetime rather than round-tripping it', () => {
    // Round-tripping through Date shifts an all-day date across a timezone
    // boundary, which is how a due date lands a day early for half the world.
    expect(lensDateOnly('2026-08-01T23:30:00Z')).toBe('2026-08-01')
  })

  it('passes a date-only string through', () => {
    expect(lensDateOnly('2026-08-01')).toBe('2026-08-01')
  })

  it.each([[null], [undefined], [''], ['nope'], [20260801]])('returns null for %s', (v) => {
    expect(lensDateOnly(v)).toBeNull()
  })
})

describe('lensText', () => {
  it('trims', () => {
    expect(lensText('  hi ')).toBe('hi')
  })
  it.each([[''], ['   '], [null], [undefined], [7]])('returns null for %s', (v) => {
    expect(lensText(v)).toBeNull()
  })
})

describe('lensRef', () => {
  it('takes the first non-empty name', () => {
    expect(lensRef('id-1', null, '  ', 'Jane')).toEqual({ id: 'id-1', name: 'Jane' })
  })

  it('falls back to the id when no name is usable', () => {
    expect(lensRef('id-1', null, undefined)).toEqual({ id: 'id-1', name: 'id-1' })
  })

  /**
   * A ref with no id is DROPPED rather than rendered: the chip would be
   * unselectable and a write could not name it, so showing it promises an edit
   * that cannot happen.
   */
  it.each([[null], [undefined], [''], ['   '], [7]])('returns null for the id %s', (id) => {
    expect(lensRef(id, 'Jane')).toBeNull()
  })
})

describe('isLensProvider', () => {
  it.each([['jira'], ['asana'], ['linear']])('accepts %s', (p) => {
    expect(isLensProvider(p)).toBe(true)
  })
  it.each([['hubspot'], ['JIRA'], [''], [null], [7]])('rejects %s', (p) => {
    expect(isLensProvider(p)).toBe(false)
  })
})

describe('noneEditable', () => {
  it('is all false — the read-only lens', () => {
    expect(noneEditable()).toEqual({
      assignee: false,
      priority: false,
      due_date: false,
      labels: false,
    })
  })
})
