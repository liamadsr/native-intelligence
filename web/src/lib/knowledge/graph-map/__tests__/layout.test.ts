/**
 * Layout invariants — determinism and stability under appends.
 *
 * These are the properties the whole design rests on: the client never
 * simulates, so if a recompute moved a node the map would visibly jump.
 */

import { describe, expect, it } from 'vitest'

import { layoutMap } from '../layout'
import { tileMap } from '../tiling'
import {
  generateSyntheticRows,
} from '../synthetic'
import type {
  SourceClaimRow,
  SourceHubRow,
  SourceLinkRow,
  SourceRows,
} from '../types'

const NOW = Date.UTC(2026, 8, 21)

function build(rows: SourceRows) {
  return tileMap(layoutMap(rows), { filters: {}, version: 'v1', nowMs: NOW })
}

/** World position of every node, from tile origin + tile-local offset. */
function worldPositions(built: ReturnType<typeof build>): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>()
  for (const tile of built.tiles.values()) {
    for (let i = 0; i < tile.nodes.key.length; i++) {
      out.set(tile.nodes.key[i], [tile.ox + tile.nodes.x[i], tile.oy + tile.nodes.y[i]])
    }
  }
  return out
}

function claim(
  id: string,
  createdAt: string,
  over: Partial<SourceClaimRow> = {},
): SourceClaimRow {
  return {
    id,
    text: `claim ${id}`,
    type: 'fact',
    confidence: 0.5,
    confirmation: 'suggested',
    status: 'active',
    scope: 'workspace',
    auto_accepted: false,
    created_by: null,
    created_at: createdAt,
    event_at: null,
    last_verified_at: null,
    ...over,
  }
}

function link(
  sourceId: string,
  targetType: string,
  targetId: string,
  createdAt: string,
  relation = 'mentions',
): SourceLinkRow {
  return {
    source_id: sourceId,
    target_type: targetType,
    target_id: targetId,
    relation,
    created_at: createdAt,
  }
}

function hub(type: string, id: string, label = `${type} ${id}`): SourceHubRow {
  return { type, id, label }
}

/** Fisher-Yates with a fixed seed — reproducible shuffles. */
function shuffled<T>(items: T[], seed: number): T[] {
  const out = items.slice()
  let s = seed >>> 0
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

describe('determinism', () => {
  it('produces a deep-equal BuiltMap for the same rows twice', () => {
    const rows = generateSyntheticRows({ claims: 600 })
    expect(build(rows)).toEqual(build(rows))
  })

  it('is independent of the ORDER of rows in the input arrays', () => {
    const rows = generateSyntheticRows({ claims: 600 })
    const scrambled: SourceRows = {
      claims: shuffled(rows.claims, 7),
      links: shuffled(rows.links, 11),
      hubs: shuffled(rows.hubs, 13),
    }
    expect(build(scrambled)).toEqual(build(rows))
  })
})

describe('append stability', () => {
  // Hubs sized so appending claims cannot double any capacity bucket:
  // capacity = max(16, nextPow2(ceil(1.5n))), so n = 2 → 16 and n = 6 → 16.
  const base: SourceRows = {
    hubs: [hub('capture', 'A'), hub('capture', 'B'), hub('project', 'P')],
    claims: [
      claim('c1', '2026-01-01T00:00:00Z'),
      claim('c2', '2026-01-02T00:00:00Z'),
      claim('c3', '2026-01-03T00:00:00Z'),
      claim('c4', '2026-01-04T00:00:00Z'),
    ],
    links: [
      link('c1', 'capture', 'A', '2026-01-01T00:00:00Z'),
      link('c2', 'capture', 'A', '2026-01-02T00:00:00Z'),
      link('c3', 'capture', 'B', '2026-01-03T00:00:00Z'),
      link('c4', 'capture', 'B', '2026-01-04T00:00:00Z'),
    ],
  }

  it('keeps every existing node at the identical world position', () => {
    const before = worldPositions(build(base))

    // Append 2 claims per hub: rowCount 2 → 4, still capacity 16. No doubling.
    const after = worldPositions(
      build({
        hubs: base.hubs,
        claims: [
          ...base.claims,
          claim('c5', '2026-02-01T00:00:00Z'),
          claim('c6', '2026-02-02T00:00:00Z'),
        ],
        links: [
          ...base.links,
          link('c5', 'capture', 'A', '2026-02-01T00:00:00Z'),
          link('c6', 'capture', 'B', '2026-02-02T00:00:00Z'),
        ],
      }),
    )

    expect(after.size).toBeGreaterThan(before.size)
    for (const [key, [x, y]] of before) {
      const next = after.get(key)
      expect(next, `${key} disappeared`).toBeDefined()
      expect(Math.abs((next as [number, number])[0] - x)).toBeLessThan(1e-3)
      expect(Math.abs((next as [number, number])[1] - y)).toBeLessThan(1e-3)
    }
  })

  it('keeps existing nodes when a LATER hub is appended', () => {
    const before = worldPositions(build(base))
    const after = worldPositions(
      build({
        hubs: [...base.hubs, hub('capture', 'Z')],
        claims: [...base.claims, claim('c9', '2026-06-01T00:00:00Z')],
        links: [...base.links, link('c9', 'capture', 'Z', '2026-06-01T00:00:00Z')],
      }),
    )
    for (const [key, [x, y]] of before) {
      const next = after.get(key) as [number, number]
      expect(next, `${key} disappeared`).toBeDefined()
      expect(Math.abs(next[0] - x)).toBeLessThan(1e-3)
      expect(Math.abs(next[1] - y)).toBeLessThan(1e-3)
    }
  })

  it('moves NOTHING when a hub grows, however far past its reserved disc', () => {
    // A hub's disc is reserved from its BIRTH count, so growth never resizes
    // it and nothing placed after it can be pushed. (The exhaustive version of
    // this — growing a hub in the middle of 200 and checking every node — is
    // in append-stability.test.ts; this keeps the small fixture honest.)
    const grown: SourceRows = {
      hubs: base.hubs,
      claims: [
        ...base.claims,
        ...Array.from({ length: 8 }, (_, i) =>
          claim(`g${i}`, `2026-03-0${i + 1}T00:00:00Z`),
        ),
      ],
      links: [
        ...base.links,
        ...Array.from({ length: 8 }, (_, i) =>
          link(`g${i}`, 'capture', 'A', `2026-03-0${i + 1}T00:00:00Z`),
        ),
      ],
    }
    const before = worldPositions(build(base))
    const after = worldPositions(build(grown))

    // Every pre-existing node — hub A, the hubs born after it, and all their
    // claims — keeps its exact position.
    for (const [key, [x, y]] of before) {
      const next = after.get(key)
      expect(next, `${key} disappeared`).toBeDefined()
      const [nx, ny] = next as [number, number]
      expect(Math.abs(nx - x), `${key} moved in x`).toBeLessThan(1e-9)
      expect(Math.abs(ny - y), `${key} moved in y`).toBeLessThan(1e-9)
    }
  })
})

describe('dismissal stability', () => {
  it('removes exactly the dismissed claim and moves nothing else', () => {
    const rows: SourceRows = {
      hubs: [hub('capture', 'A')],
      claims: [
        claim('c1', '2026-01-01T00:00:00Z'),
        claim('c2', '2026-01-02T00:00:00Z'),
        claim('c3', '2026-01-03T00:00:00Z'),
      ],
      links: [
        link('c1', 'capture', 'A', '2026-01-01T00:00:00Z'),
        link('c2', 'capture', 'A', '2026-01-02T00:00:00Z'),
        link('c3', 'capture', 'A', '2026-01-03T00:00:00Z'),
      ],
    }
    const before = worldPositions(build(rows))
    const after = worldPositions(
      build({
        ...rows,
        claims: [
          rows.claims[0],
          { ...rows.claims[1], confirmation: 'dismissed' },
          rows.claims[2],
        ],
      }),
    )

    expect(after.has('claim:c2')).toBe(false)
    expect(after.size).toBe(before.size - 1)
    // c3 keeps slot 2 — the dismissal leaves a hole rather than shifting it.
    for (const key of ['claim:c1', 'claim:c3', 'capture:A']) {
      const b = before.get(key) as [number, number]
      const a = after.get(key) as [number, number]
      expect(Math.abs(a[0] - b[0])).toBeLessThan(1e-3)
      expect(Math.abs(a[1] - b[1])).toBeLessThan(1e-3)
    }
  })
})

describe('primary hub stickiness', () => {
  it('does not move a claim when a LATER anchor link is added', () => {
    const rows: SourceRows = {
      hubs: [hub('capture', 'A'), hub('project', 'P')],
      claims: [claim('c1', '2026-01-01T00:00:00Z')],
      links: [link('c1', 'capture', 'A', '2026-01-01T00:00:00Z')],
    }
    const before = worldPositions(build(rows))
    const after = worldPositions(
      build({
        ...rows,
        // The weaver adds an anchor link months later.
        links: [...rows.links, link('c1', 'project', 'P', '2026-06-01T00:00:00Z', 'about')],
      }),
    )
    const b = before.get('claim:c1') as [number, number]
    const a = after.get('claim:c1') as [number, number]
    expect(Math.abs(a[0] - b[0])).toBeLessThan(1e-3)
    expect(Math.abs(a[1] - b[1])).toBeLessThan(1e-3)
  })

  it('uses the EARLIEST link as the primary hub, readable or not', () => {
    const rows: SourceRows = {
      hubs: [hub('capture', 'A'), hub('document', 'D')],
      claims: [claim('c1', '2026-01-01T00:00:00Z')],
      links: [
        link('c1', 'document', 'D', '2026-05-01T00:00:00Z'),
        link('c1', 'capture', 'A', '2026-01-01T00:00:00Z'),
      ],
    }
    const map = layoutMap(rows)
    // The claim's primary hub is the capture, not the later document.
    expect(map.keys[map.claimHub[0]]).toBe('capture:A')
  })
})

describe('visibility rule', () => {
  it('drops links to hubs absent from rows.hubs, creating no node or edge', () => {
    const rows: SourceRows = {
      // 'email:E' is deliberately NOT in hubs — the viewer cannot read it.
      hubs: [hub('capture', 'A')],
      claims: [claim('c1', '2026-01-01T00:00:00Z')],
      links: [
        link('c1', 'capture', 'A', '2026-01-01T00:00:00Z'),
        link('c1', 'email', 'E', '2026-01-02T00:00:00Z'),
      ],
    }
    const built = build(rows)
    const keys = new Set<string>()
    let edgeCount = 0
    for (const tile of built.tiles.values()) {
      for (const k of tile.nodes.key) keys.add(k)
      edgeCount += tile.edges.s.length
    }
    expect(keys.has('email:E')).toBe(false)
    expect(keys).toEqual(new Set(['claim:c1', 'capture:A']))
    // Only the capture link survives.
    expect(edgeCount).toBe(1)
  })

  it('sends a claim with no resolvable hub to its unfiled month hub', () => {
    const rows: SourceRows = {
      hubs: [],
      claims: [claim('c1', '2026-09-15T12:00:00Z')],
      links: [link('c1', 'email', 'E', '2026-09-15T12:00:00Z')],
    }
    const built = build(rows)
    const keys = new Set<string>()
    for (const tile of built.tiles.values()) for (const k of tile.nodes.key) keys.add(k)
    expect(keys.has('unfiled:2026-09')).toBe(true)

    // ...and it is labelled for humans.
    for (const tile of built.tiles.values()) {
      const i = tile.nodes.key.indexOf('unfiled:2026-09')
      if (i >= 0) expect(tile.nodes.label[i]).toBe('Unfiled · Sep 2026')
    }
  })

  it('keeps a claim→claim link only when both claims are included', () => {
    const rows: SourceRows = {
      hubs: [hub('capture', 'A')],
      claims: [
        claim('c1', '2026-01-01T00:00:00Z'),
        claim('c2', '2026-01-02T00:00:00Z', { confirmation: 'dismissed' }),
      ],
      links: [
        link('c1', 'capture', 'A', '2026-01-01T00:00:00Z'),
        link('c2', 'capture', 'A', '2026-01-02T00:00:00Z'),
        link('c1', 'claim', 'c2', '2026-01-03T00:00:00Z', 'supports'),
      ],
    }
    let edgeCount = 0
    for (const tile of build(rows).tiles.values()) edgeCount += tile.edges.s.length
    // c2 is dismissed, so the claim→claim edge is dropped; only c1→A survives.
    expect(edgeCount).toBe(1)
  })
})

describe('slots', () => {
  it('ranks claims among ALL rows of the hub, including dismissed ones', () => {
    // c2 is dismissed but still consumes slot 1, so c3 sits at slot 2.
    const withDismissed: SourceRows = {
      hubs: [hub('capture', 'A')],
      claims: [
        claim('c1', '2026-01-01T00:00:00Z'),
        claim('c2', '2026-01-02T00:00:00Z', { confirmation: 'dismissed' }),
        claim('c3', '2026-01-03T00:00:00Z'),
      ],
      links: [
        link('c1', 'capture', 'A', '2026-01-01T00:00:00Z'),
        link('c2', 'capture', 'A', '2026-01-02T00:00:00Z'),
        link('c3', 'capture', 'A', '2026-01-03T00:00:00Z'),
      ],
    }
    // Same map with c2's row removed entirely: c3 would slide down to slot 1.
    const without: SourceRows = {
      hubs: withDismissed.hubs,
      claims: [withDismissed.claims[0], withDismissed.claims[2]],
      links: [withDismissed.links[0], withDismissed.links[2]],
    }

    const a = worldPositions(build(withDismissed)).get('claim:c3') as [number, number]
    const b = worldPositions(build(without)).get('claim:c3') as [number, number]
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThan(1)
  })

  it('counts superseded rows as slots too', () => {
    const map = layoutMap({
      hubs: [hub('capture', 'A')],
      claims: [
        claim('c1', '2026-01-01T00:00:00Z', { status: 'superseded' }),
        claim('c2', '2026-01-02T00:00:00Z'),
      ],
      links: [
        link('c1', 'capture', 'A', '2026-01-01T00:00:00Z'),
        link('c2', 'capture', 'A', '2026-01-02T00:00:00Z'),
      ],
    })
    // Only c2 is a node, and its hub disc sizing counted both rows.
    expect(map.claimCount).toBe(1)
    expect(map.keys[0]).toBe('claim:c2')
  })
})

describe('importance', () => {
  it('ranks every hub above every claim so parents load first', () => {
    const map = layoutMap(generateSyntheticRows({ claims: 400 }))
    let maxClaim = -Infinity
    let minHub = Infinity
    for (let i = 0; i < map.count; i++) {
      if (i < map.claimCount) maxClaim = Math.max(maxClaim, map.importance[i])
      else minHub = Math.min(minHub, map.importance[i])
    }
    expect(maxClaim).toBeLessThan(1000)
    expect(minHub).toBeGreaterThanOrEqual(1000)
  })
})
