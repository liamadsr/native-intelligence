/**
 * The filter WIRE.
 *
 * The class of bug guarded here: a filter payload that reaches the mask without
 * having been validated. The parsed value becomes a cache key and then decides
 * which claims a viewer sees, so anything that gets through unchecked either
 * churns the build LRU, collides with another filter set's entry, or draws a
 * map nobody asked for. The second class: a malformed payload escaping as an
 * exception, which the route would answer 500 — telling the client the map is
 * broken when the request was.
 *
 * Also locked in here: filtering re-ranks tiles without ever moving a node.
 */

import { describe, expect, it } from 'vitest'

import { MAX_FILTER_PAYLOAD_BYTES, MAX_PREDICATES } from '../filter-model'
import {
  FILTER_PARAM,
  filtersKey,
  filtersToParam,
  filtersToParams,
  parseFilters,
} from '../filters'
import { layoutMap } from '../layout'
import { generateSyntheticRows } from '../synthetic'
import { tileMap } from '../tiling'
import type { MapFilters } from '../types'

const NOW = Date.UTC(2026, 8, 21)
const PROJECT_A = '0194b2c1-0000-7000-8000-00000000000a'

/** The parsed filters, or a failure the test did not expect. */
function parse(params: Record<string, string>): MapFilters {
  const result = parseFilters(new URLSearchParams(params))
  if (!result.ok) throw new Error(`expected a valid payload, got: ${result.error}`)
  return result.filters
}

/** The rejection reason, or a failure to reject. */
function reject(raw: string): string {
  const result = parseFilters(new URLSearchParams({ [FILTER_PARAM]: raw }))
  if (result.ok) throw new Error('expected the payload to be rejected')
  return result.error
}

function wire(...predicates: unknown[]): Record<string, string> {
  return { [FILTER_PARAM]: JSON.stringify(predicates) }
}

describe('parseFilters', () => {
  it('reads an empty filter set from a missing or blank param', () => {
    expect(parse({})).toEqual({})
    expect(parse({ [FILTER_PARAM]: '' })).toEqual({})
    expect(parse({ [FILTER_PARAM]: '  ' })).toEqual({})
    expect(parse({ [FILTER_PARAM]: '[]' })).toEqual({})
  })

  it('round-trips a filter set of every kind', () => {
    const filters: MapFilters = {
      where: [
        { field: 'type', op: 'is_any_of', value: ['fact', 'inference'] },
        { field: 'confidence', op: 'gte', value: 0.6 },
        { field: 'auto_accepted', op: 'is', value: true },
        { field: 'project_ids', op: 'is_any_of', value: [PROJECT_A] },
        { field: 'text', op: 'contains', value: 'revenue' },
        { field: 'event_at', op: 'is_empty' },
        {
          field: 'created_at',
          op: 'is_relative',
          value: { unit: 'day', direction: 'past', count: 30 },
        },
      ],
    }
    const reparsed = parseFilters(filtersToParams(filters))
    expect(reparsed.ok).toBe(true)
    // Compared through the cache key: that is the identity the whole build
    // cache is keyed on, so a round trip that changes it is the bug.
    expect(filtersKey((reparsed as { filters: MapFilters }).filters)).toBe(filtersKey(filters))
  })

  it('emits no param at all for an empty filter set', () => {
    expect(filtersToParam({})).toBe('')
    expect(filtersToParams({}).toString()).toBe('')
  })

  it('leaves a relative window unresolved on the wire', () => {
    // Resolving client-side is what would let the list and the canvas answer
    // one saved view with two different windows.
    const encoded = filtersToParam({
      where: [
        {
          field: 'created_at',
          op: 'is_relative',
          value: { unit: 'week', direction: 'past', count: 2 },
        },
      ],
    })
    expect(encoded).toContain('is_relative')
    expect(encoded).not.toMatch(/20\d\d-\d\d-\d\dT/)
  })
})

describe('parseFilters — a bad payload is a 400, never a throw or a silent drop', () => {
  it('rejects a payload that is not JSON', () => {
    expect(reject('{definitely not json')).toMatch(/not valid JSON/)
  })

  it('rejects a payload that is not a list', () => {
    expect(reject('{"where":[]}')).toMatch(/must be a list/)
    expect(reject('"fact"')).toMatch(/must be a list/)
    expect(reject('null')).toMatch(/must be a list/)
  })

  it('rejects an entry that is not [field, operator, value?]', () => {
    expect(reject('[{"field":"type"}]')).toMatch(/filter 0/)
    expect(reject('[["type"]]')).toMatch(/filter 0/)
    expect(reject('[["type","is","fact","extra"]]')).toMatch(/filter 0/)
    expect(reject('[[1,2,3]]')).toMatch(/filter 0/)
  })

  it('rejects a field the map cannot mask', () => {
    // `status` is deliberately absent from the vocabulary: the map bakes
    // `status = active` into its layout, so a status filter would describe a
    // list the graph could never draw.
    expect(reject(JSON.stringify([['status', 'is', 'archived']]))).toMatch(
      /not a knowledge field/,
    )
  })

  it('rejects an operator the field does not implement', () => {
    expect(reject(JSON.stringify([['type', 'contains', 'fact']]))).toMatch(
      /cannot be applied/,
    )
  })

  it('rejects a value that means nothing for its field', () => {
    expect(reject(JSON.stringify([['type', 'is', 'not-a-claim-type']]))).toBeTruthy()
    expect(reject(JSON.stringify([['confidence', 'gte', 'quite sure']]))).toBeTruthy()
    expect(reject(JSON.stringify([['created_at', 'gt', 'yesterday']]))).toBeTruthy()
    // `@me` must be resolved to a concrete member before the wire, or one
    // cache key would mean different claims for different people.
    expect(reject(JSON.stringify([['created_by', 'is', '@me']]))).toBeTruthy()
  })

  it('names WHICH filter was refused, so a client bug is diagnosable', () => {
    const error = reject(
      JSON.stringify([
        ['type', 'is', 'fact'],
        ['confidence', 'gte', 0.5],
        ['type', 'is', 'nonsense'],
      ]),
    )
    expect(error).toMatch(/^filter 2:/)
  })

  it('refuses more predicates than the cap, rather than tiling per chip', () => {
    const many = Array.from({ length: MAX_PREDICATES + 1 }, (_u, i) => [
      'text',
      'contains',
      `term${i}`,
    ])
    expect(reject(JSON.stringify(many))).toMatch(/at most/)
  })

  it('refuses an oversized payload BEFORE parsing it', () => {
    // The cap has to bound the work, not just the result: `JSON.parse` on a
    // multi-megabyte param is itself the denial of service.
    const huge = `["${'x'.repeat(MAX_FILTER_PAYLOAD_BYTES * 4)}"]`
    expect(reject(huge)).toMatch(/exceed/)
  })

  it('counts BYTES, not UTF-16 units, so multi-byte text cannot slip past', () => {
    // Each of these is one JS char and three UTF-8 bytes, so a length-only
    // check would let a payload three times the cap through.
    const multibyte = JSON.stringify([['text', 'contains', '公'.repeat(3500)]])
    expect(multibyte.length).toBeLessThan(MAX_FILTER_PAYLOAD_BYTES)
    expect(new TextEncoder().encode(multibyte).length).toBeGreaterThan(
      MAX_FILTER_PAYLOAD_BYTES,
    )
    expect(reject(multibyte)).toMatch(/exceed/)
  })

  it('cannot be forged by a value that contains the encoding\'s own syntax', () => {
    // The key is the ONLY thing keying the built tiling, so a value that could
    // synthesize another filter set's key would be served that set's map.
    const forged = parse(wire(['text', 'contains', '","confidence","gte",0.9]]']))
    const real = parse(wire(['confidence', 'gte', 0.9]))
    expect(filtersKey(forged)).not.toBe(filtersKey(real))
  })
})

describe('filters never move a node', () => {
  it('keeps identical world positions under every filter', () => {
    const map = layoutMap(generateSyntheticRows({ claims: 1500 }))
    const positionsFor = (filters: MapFilters) => {
      const built = tileMap(map, { filters, version: 'v', nowMs: NOW })
      const out = new Map<string, [number, number]>()
      for (const t of built.tiles.values()) {
        for (let i = 0; i < t.nodes.key.length; i++) {
          out.set(t.nodes.key[i], [t.ox + t.nodes.x[i], t.oy + t.nodes.y[i]])
        }
      }
      return out
    }

    const all = positionsFor({})
    const cases: MapFilters[] = [
      { where: [{ field: 'confirmation', op: 'is', value: ['confirmed'] }] },
      { where: [{ field: 'confidence', op: 'gte', value: 0.7 }] },
      { where: [{ field: 'type', op: 'is_any_of', value: ['fact'] }] },
      { where: [{ field: 'scope', op: 'is', value: ['personal'] }] },
      { where: [{ field: 'text', op: 'contains', value: 'synthetic claim 1' }] },
    ]
    for (const filters of cases) {
      const some = positionsFor(filters)
      expect(some.size, filtersKey(filters)).toBeGreaterThan(0)
      expect(some.size, filtersKey(filters)).toBeLessThan(all.size)
      for (const [key, [x, y]] of some) {
        const [ax, ay] = all.get(key) as [number, number]
        expect(Math.abs(x - ax)).toBeLessThan(1e-3)
        expect(Math.abs(y - ay)).toBeLessThan(1e-3)
      }
    }
  })
})
