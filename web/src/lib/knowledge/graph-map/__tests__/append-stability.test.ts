/**
 * What a layout rebuild does and does not preserve.
 *
 * This file used to assert the HARD version of §4.2 — appending rows moves
 * NOTHING that already existed — because hub placement was ordered by birth
 * time and discs were reserved from birth counts, both immutable under append.
 *
 * That was traded away deliberately. Hubs are now packed in DEGREE order, so
 * the middle of the map belongs to whatever is most connected right now rather
 * than to whatever happened to arrive first, and discs are sized from the
 * claims a hub actually holds. Connection counts change, so positions change
 * with them: a rebuild after a weaver run can legitimately re-arrange the map.
 *
 * The tests below therefore split into the two halves that remain true:
 *
 *  - WHAT IS STILL GUARANTEED. A rebuild is exactly deterministic; a claim
 *    stays on its own hub's spiral at its own slot; a dismissed row still
 *    leaves a hole; and an append that changes neither a hub's degree RANK nor
 *    its disc capacity still moves nothing at all — which is the common case,
 *    and why the map does not churn on every single claim.
 *
 *  - WHAT IS NOW ASSERTED INSTEAD. Degree drives radial position, and a hub
 *    overtaking another in connections is expected to swap places with it.
 *    That last test exists to make the cost of this trade explicit in code
 *    rather than only in a commit message.
 */

import { describe, expect, it } from 'vitest'

import { layoutMap } from '../layout'
import { generateSyntheticRows } from '../synthetic'
import type {
  SourceClaimRow,
  SourceHubRow,
  SourceLinkRow,
  SourceRows,
} from '../types'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 1)

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function claim(id: string, at: number, over: Partial<SourceClaimRow> = {}): SourceClaimRow {
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
    created_at: iso(at),
    event_at: null,
    last_verified_at: null,
    ...over,
  }
}

function link(
  sourceId: string,
  targetType: string,
  targetId: string,
  at: number,
  relation = 'mentions',
): SourceLinkRow {
  return {
    source_id: sourceId,
    target_type: targetType,
    target_id: targetId,
    relation,
    created_at: iso(at),
  }
}

function hub(type: string, id: string): SourceHubRow {
  return { type, id, label: `${type} ${id}` }
}

/** Every node's world position, keyed by node key. */
function positions(rows: SourceRows): Map<string, [number, number]> {
  const map = layoutMap(rows)
  const out = new Map<string, [number, number]>()
  for (let i = 0; i < map.count; i++) out.set(map.keys[i], [map.x[i], map.y[i]])
  return out
}

/** Keys present in `before` whose position changed (or which vanished). */
function moved(
  before: Map<string, [number, number]>,
  after: Map<string, [number, number]>,
): string[] {
  const out: string[] = []
  for (const [key, [x, y]] of before) {
    const next = after.get(key)
    if (!next) {
      out.push(`${key} (gone)`)
      continue
    }
    if (Math.abs(next[0] - x) > 1e-9 || Math.abs(next[1] - y) > 1e-9) {
      out.push(`${key} moved ${Math.hypot(next[0] - x, next[1] - y).toFixed(1)}`)
    }
  }
  return out
}

/**
 * 200 capture hubs, 3 claims each, born one day apart. Hub #2 in birth order is
 * the one the growth tests enlarge: hubs exist both before and after it, so a
 * cascade has somewhere to show up.
 */
function manyHubs(hubCount = 200, perHub = 3): SourceRows {
  const hubs: SourceHubRow[] = []
  const claims: SourceClaimRow[] = []
  const links: SourceLinkRow[] = []
  for (let h = 0; h < hubCount; h++) {
    const id = `H${String(h).padStart(4, '0')}`
    hubs.push(hub('capture', id))
    for (let i = 0; i < perHub; i++) {
      const at = T0 + h * DAY + i * 60_000
      const cid = `${id}-c${i}`
      claims.push(claim(cid, at))
      links.push(link(cid, 'capture', id, at))
    }
  }
  return { hubs, claims, links }
}

/** Append `n` claims to an existing hub, dated well after every other row. */
function growHub(rows: SourceRows, hubId: string, n: number, tag: string): SourceRows {
  const later = T0 + 10_000 * DAY
  const claims = rows.claims.slice()
  const links = rows.links.slice()
  for (let i = 0; i < n; i++) {
    const at = later + i * 60_000
    const cid = `${tag}-${i}`
    claims.push(claim(cid, at))
    links.push(link(cid, 'capture', hubId, at))
  }
  return { hubs: rows.hubs, claims, links }
}

/**
 * Hubs with DISTINCT, widely-spaced claim counts: hub h holds `step·(h+1)`.
 *
 * Spacing matters. `manyHubs` gives every hub the same count, so every hub is
 * tied on degree and the tie-break — birth order — decides the whole map;
 * adding a single claim anywhere then re-ranks that hub against 200 others and
 * moves everything. Real workspaces are not ties, and these tests are about
 * the ordinary case: a hub gaining a few claims without overtaking anyone.
 */
function spacedHubs(hubCount = 20, step = 10): SourceRows {
  const hubs: SourceHubRow[] = []
  const claims: SourceClaimRow[] = []
  const links: SourceLinkRow[] = []
  for (let h = 0; h < hubCount; h++) {
    const id = `H${String(h).padStart(4, '0')}`
    hubs.push(hub('capture', id))
    for (let i = 0; i < step * (h + 1); i++) {
      const at = T0 + h * DAY + i * 60_000
      const cid = `${id}-c${i}`
      claims.push(claim(cid, at))
      links.push(link(cid, 'capture', id, at))
    }
  }
  return { hubs, claims, links }
}

/** Distance of each hub from the world origin, by hub id. */
function hubDistances(rows: SourceRows): Map<string, number> {
  const map = layoutMap(rows)
  const out = new Map<string, number>()
  for (let i = 0; i < map.count; i++) {
    const key = map.keys[i]
    if (key.startsWith('capture:')) out.set(key.slice('capture:'.length), Math.hypot(map.x[i], map.y[i]))
  }
  return out
}

describe('what a rebuild still guarantees', () => {
  it('moves nothing when an append changes neither degree RANK nor disc capacity', () => {
    // H0009 holds 100 claims, between H0008's 90 and H0010's 110, so +3 keeps
    // its rank. discCapacity is nextPow2(2·n) ≥ 32, so 100 and 103 both land
    // in the 256 band and its reserved disc is byte-identical too. Nothing
    // upstream of a position has changed, so nothing may move.
    const base = spacedHubs(20, 10)
    const before = positions(base)
    const after = positions(growHub(base, 'H0009', 3, 'g3'))

    expect(moved(before, after)).toEqual([])
    expect(after.size).toBe(before.size + 3)
  })

  it('keeps every claim on its own hub, at its own slot offset', () => {
    // The hub may move; the claim moves WITH it. This is the relationship the
    // map is actually drawn from, and it survives any re-ranking.
    const base = spacedHubs(12, 10)
    const offsets = (rows: SourceRows) => {
      const map = layoutMap(rows)
      const hubAt = new Map<string, [number, number]>()
      for (let i = 0; i < map.count; i++) {
        if (map.keys[i].startsWith('capture:')) hubAt.set(map.keys[i], [map.x[i], map.y[i]])
      }
      const out = new Map<string, number>()
      for (let i = 0; i < map.count; i++) {
        const key = map.keys[i]
        if (!key.startsWith('claim:')) continue
        const h = hubAt.get(`capture:${key.slice('claim:'.length).split('-c')[0]}`)
        if (h) out.set(key, Math.hypot(map.x[i] - h[0], map.y[i] - h[1]))
      }
      return out
    }

    const before = offsets(base)
    // Grow a DIFFERENT hub hard enough to re-rank the map, then check that
    // every untouched claim still sits exactly where it did relative to its
    // own hub.
    const after = offsets(growHub(base, 'H0000', 400, 'boom'))
    expect(before.size).toBeGreaterThan(0)
    for (const [key, d] of before) {
      expect(after.get(key)).toBeCloseTo(d, 9)
    }
  })

  it('still removes a dismissed claim and leaves its slot as a hole', () => {
    // Dismissing drops the hub's degree by one. H0009 goes 100 → 99, still
    // clear of H0008's 90, so its rank holds and the rest of the map is
    // untouched — and the surviving claims keep their ORIGINAL slot offsets,
    // which is what "leaves a hole" means geometrically.
    const base = spacedHubs(20, 10)
    const victim = 'H0009-c50'
    const before = positions(base)
    const after = positions({
      ...base,
      claims: base.claims.map((c) =>
        c.id === victim ? { ...c, confirmation: 'dismissed' as const } : c,
      ),
    })

    expect(after.has(`claim:${victim}`)).toBe(false)
    before.delete(`claim:${victim}`)
    expect(moved(before, after)).toEqual([])
  })

  it('is exactly reproducible: the same rows build the same map twice', () => {
    const rows = spacedHubs(16, 10)
    expect(moved(positions(rows), positions(rows))).toEqual([])
  })
})

describe('degree drives radial position', () => {
  it('puts the most-connected hub nearest the origin and the least-connected furthest', () => {
    const d = hubDistances(spacedHubs(20, 10))
    // H0019 holds 200 claims, H0000 holds 10.
    expect(d.get('H0019')).toBeLessThan(d.get('H0000') as number)
  })

  it('sorts the map radially by connection count, not by age', () => {
    // Birth order is H0000 first — the exact OPPOSITE of degree order here, so
    // a map still packed by age would fail this outright rather than by a
    // margin. Compare cohort means so one awkwardly-packed hub cannot flip it.
    const d = hubDistances(spacedHubs(20, 10))
    const mean = (ids: string[]) => ids.reduce((s, id) => s + (d.get(id) as number), 0) / ids.length
    const ids = [...d.keys()].sort()
    const leastConnected = ids.slice(0, 5)
    const mostConnected = ids.slice(-5)
    expect(mean(mostConnected)).toBeLessThan(mean(leastConnected))
  })

  it('re-arranges when a hub overtakes another in connections', () => {
    // THE COST OF THE TRADE, pinned deliberately. A hub that climbs the
    // ranking takes a more central spot, which means the hub it passed gives
    // one up. If this test ever starts passing with an empty `moved()`, the
    // ordering has quietly gone back to something immutable.
    const base = spacedHubs(6, 10)
    const before = positions(base)
    // H0000 holds 10 claims, the fewest; +100 makes it the most connected.
    const after = positions(growHub(base, 'H0000', 100, 'surge'))

    expect(moved(before, after).length).toBeGreaterThan(0)
    const d = hubDistances(growHub(base, 'H0000', 100, 'surge'))
    expect(d.get('H0000')).toBeLessThan(d.get('H0005') as number)
  })
})

describe('later links', () => {
  it('moves nothing when a LATER anchor link is added to an existing claim', () => {
    const base = manyHubs(40)
    const rows: SourceRows = {
      hubs: [...base.hubs, hub('project', 'P')],
      claims: base.claims,
      links: base.links,
    }
    const before = positions(rows)
    const after = positions({
      ...rows,
      links: [
        ...rows.links,
        link(base.claims[7].id, 'project', 'P', T0 + 9_000 * DAY, 'about'),
      ],
    })
    // The project hub is new, so it appears; nothing that existed may move.
    expect(moved(before, after)).toEqual([])
  })

  it('gives a same-instant provenance+anchor pair to the PROVENANCE hub', () => {
    // Extraction writes both links in one transaction, so they share a
    // timestamp. Alphabetically 'campaign:' beats 'capture:', so a tie-break on
    // the key alone would hand the claim's home to the anchor.
    const at = T0
    const map = layoutMap({
      hubs: [hub('capture', 'A'), hub('campaign', 'C')],
      claims: [claim('c1', at)],
      links: [
        link('c1', 'campaign', 'C', at, 'about'),
        link('c1', 'capture', 'A', at, 'cites'),
      ],
    })
    expect(map.keys[map.claimHub[0]]).toBe('capture:A')
  })

  it('does not re-point a claim when a link is BACKDATED before the incumbent', () => {
    const at = T0 + 100 * DAY
    const rows: SourceRows = {
      hubs: [hub('capture', 'A'), hub('project', 'P')],
      claims: [claim('c1', at)],
      links: [link('c1', 'capture', 'A', at, 'cites')],
    }
    const before = positions(rows)
    // The weaver stamps its anchor link with the meeting date, months earlier.
    const after = positions({
      ...rows,
      links: [...rows.links, link('c1', 'project', 'P', T0, 'about')],
    })
    expect(moved(before, after)).toEqual([])
  })
})

describe('viewer visibility', () => {
  /** Same rows; the second viewer additionally reads `contact:C`. */
  function twoViewers() {
    const at = T0
    const claims = [claim('c1', at), claim('c2', at + 60_000), claim('c3', at + 120_000)]
    const links = [
      // c1's earliest link is to a contact; c2 and c3 are plain capture claims.
      // Both of c1's links are written after c1 itself, so neither is backdated.
      link('c1', 'contact', 'C', at + 1000, 'about'),
      link('c1', 'capture', 'A', at + 2000, 'cites'),
      link('c2', 'capture', 'A', at + 60_000, 'cites'),
      link('c3', 'capture', 'A', at + 120_000, 'cites'),
    ]
    return {
      narrow: { hubs: [hub('capture', 'A')], claims, links },
      wide: { hubs: [hub('capture', 'A'), hub('contact', 'C')], claims, links },
    }
  }

  it("sends a hidden hub's claims to unfiled, never to another hub", () => {
    const { narrow, wide } = twoViewers()
    const narrowMap = layoutMap(narrow)
    const wideMap = layoutMap(wide)

    // The viewer who cannot read contact:C does NOT get c1 re-homed on
    // capture:A — it falls to unfiled, so capture:A's membership is the same
    // for both viewers.
    const homeOf = (m: ReturnType<typeof layoutMap>, id: string) =>
      m.keys[m.claimHub[m.claimIds.indexOf(id)]]
    expect(homeOf(narrowMap, 'c1')).toBe('unfiled:2026-01')
    expect(homeOf(wideMap, 'c1')).toBe('contact:C')
    for (const id of ['c2', 'c3']) {
      expect(homeOf(narrowMap, id)).toBe('capture:A')
      expect(homeOf(wideMap, id)).toBe('capture:A')
    }
  })

  it('gives two viewers who share a hub the same slots on it', () => {
    // capture:A is born BEFORE the visibility-gated contact, so it is placed
    // first in both views and its slots must agree exactly. (A shared hub born
    // AFTER the gated one may sit somewhere else — see the bound below.)
    const at = T0
    const claims = [claim('c1', at), claim('c2', at + 120_000), claim('c3', at + 180_000)]
    const links = [
      // capture:A is born first in both views, so it takes the same place.
      link('c1', 'capture', 'A', at, 'cites'),
      link('c2', 'capture', 'A', at + 120_000, 'cites'),
      // c3's earliest link is to the contact, which only the wide viewer reads.
      link('c3', 'contact', 'C', at + 181_000, 'about'),
      link('c3', 'capture', 'A', at + 182_000, 'cites'),
    ]
    const a = positions({ hubs: [hub('capture', 'A')], claims, links })
    const b = positions({ hubs: [hub('capture', 'A'), hub('contact', 'C')], claims, links })

    // c1 and c2 keep slots 0 and 1 on capture:A in BOTH views: c3 was never a
    // candidate for capture:A, so gaining access to the contact cannot
    // renumber the claims that were already there.
    for (const key of ['capture:A', 'claim:c1', 'claim:c2']) {
      expect(a.get(key), key).toEqual(b.get(key))
    }
    // c3 itself is the one node that legitimately moves: unfiled → its contact.
    expect(a.get('claim:c3')).not.toEqual(b.get('claim:c3'))
  })

  it('does not renumber a hub\'s cohort when another hub becomes readable', () => {
    // The reproduced defect: c1's earliest link is to a contact the viewer
    // cannot read, so c1 used to fall through to capture:A and take slot 0.
    // Gaining access to the contact pulled c1 off capture:A, which renumbered
    // c2 and c3 (slot 1→0, 2→1) and resized capture:A — moving the hub and
    // every one of its claims.
    const at = T0
    const claims = [claim('c1', at + 1000), claim('c2', at + 2000), claim('c3', at + 3000)]
    const links = [
      // capture:A is born first, so its own placement is fixed in both views.
      link('c0', 'capture', 'A', at, 'cites'),
      link('c1', 'contact', 'C', at + 1100, 'about'),
      link('c1', 'capture', 'A', at + 1200, 'cites'),
      link('c2', 'capture', 'A', at + 2000, 'cites'),
      link('c3', 'capture', 'A', at + 3000, 'cites'),
    ]
    const withC0 = [claim('c0', at), ...claims]
    const narrow = positions({ hubs: [hub('capture', 'A')], claims: withC0, links })
    const wide = positions({
      hubs: [hub('capture', 'A'), hub('contact', 'C')],
      claims: withC0,
      links,
    })

    // c1 lives on the contact in both views (unfiled when hidden), so the
    // claims that were really on capture:A never renumber.
    for (const key of ['capture:A', 'claim:c0', 'claim:c2', 'claim:c3']) {
      expect(wide.get(key), key).toEqual(narrow.get(key))
    }
  })

  it('does not move hubs born BEFORE a hub that becomes readable', () => {
    // 40 capture hubs; the contact is born between hub 20 and 21.
    const base = manyHubs(40)
    const contactAt = T0 + 20 * DAY + 30_000
    const links = [...base.links, link(base.claims[0].id, 'contact', 'C', contactAt)]
    const narrow: SourceRows = { hubs: base.hubs, claims: base.claims, links }
    const wide: SourceRows = {
      hubs: [...base.hubs, hub('contact', 'C')],
      claims: base.claims,
      links,
    }

    const before = positions(narrow)
    const after = positions(wide)
    const earlier = [...before.keys()].filter((k) => k <= 'capture:H0020')
    expect(earlier.length).toBeGreaterThan(20)
    for (const key of earlier) {
      if (!key.startsWith('capture:')) continue
      expect(after.get(key), key).toEqual(before.get(key))
    }
    // Hubs born AFTER the newly-readable one MAY move: it takes a place in the
    // packing that was not reserved for it in the narrow view. That is the
    // documented bound (§4.2) — per-viewer, never per-append.
  })
})

describe('duplicate links', () => {
  it('counts one (claim, hub) pair once toward degree, and still ships both relations', () => {
    const at = T0
    const map = layoutMap({
      hubs: [hub('capture', 'A'), hub('project', 'P')],
      claims: [claim('c1', at)],
      links: [
        link('c1', 'capture', 'A', at, 'cites'),
        link('c1', 'project', 'P', at + 1000, 'about'),
        link('c1', 'project', 'P', at + 2000, 'mentions'),
      ],
    })

    const projectNode = map.keys.indexOf('project:P')
    expect(map.degree[projectNode]).toBe(1)
    // The CSR the project filter scans lists the hub once.
    const targets = Array.from(
      map.claimHubTargets.slice(map.claimHubOffsets[0], map.claimHubOffsets[1]),
    )
    expect(targets).toEqual([map.keys.indexOf('capture:A'), projectNode])
    // Both relations still ship as edges — the relation is drawn and inspected.
    let toProject = 0
    for (let i = 0; i < map.edgeTarget.length; i++) {
      if (map.edgeTarget[i] === projectNode) toProject++
    }
    expect(toProject).toBe(2)
  })

  it('does not let double-linked claims outrank a hub with more distinct claims', () => {
    const claims: SourceClaimRow[] = []
    const links: SourceLinkRow[] = []
    // Project A: 10 claims, each linked twice. Project B: 15 claims, once each.
    for (let i = 0; i < 10; i++) {
      const id = `a${i}`
      const at = T0 + i * 60_000
      claims.push(claim(id, at))
      links.push(link(id, 'capture', 'HA', at, 'cites'))
      links.push(link(id, 'project', 'A', at + 1000, 'about'))
      links.push(link(id, 'project', 'A', at + 2000, 'mentions'))
    }
    for (let i = 0; i < 15; i++) {
      const id = `b${i}`
      const at = T0 + 1000 * 60_000 + i * 60_000
      claims.push(claim(id, at))
      links.push(link(id, 'capture', 'HB', at, 'cites'))
      links.push(link(id, 'project', 'B', at + 1000, 'about'))
    }
    const map = layoutMap({
      hubs: [hub('capture', 'HA'), hub('capture', 'HB'), hub('project', 'A'), hub('project', 'B')],
      claims,
      links,
    })

    const a = map.keys.indexOf('project:A')
    const b = map.keys.indexOf('project:B')
    expect(map.degree[a]).toBe(10)
    expect(map.degree[b]).toBe(15)
    // Same type weight, so B — genuinely the better-connected hub — must rank
    // higher and therefore reach the shallower tile.
    expect(map.importance[b]).toBeGreaterThan(map.importance[a])
    expect(map.r[b]).toBeGreaterThan(map.r[a])
  })
})

describe('determinism under the new rules', () => {
  it('is unchanged by the ORDER of rows in the input arrays', () => {
    const rows = generateSyntheticRows({ claims: 800, seed: 5, megaAnchorRatio: 0.3 })
    const shuffle = <T,>(items: T[], seed: number): T[] => {
      const out = items.slice()
      let s = seed >>> 0
      for (let i = out.length - 1; i > 0; i--) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0
        const j = s % (i + 1)
        ;[out[i], out[j]] = [out[j], out[i]]
      }
      return out
    }
    const a = positions(rows)
    const b = positions({
      claims: shuffle(rows.claims, 3),
      links: shuffle(rows.links, 9),
      hubs: shuffle(rows.hubs, 17),
    })
    expect(moved(a, b)).toEqual([])
    expect(b.size).toBe(a.size)
  })

  it('keeps every node inside the world box, including disc overflow', () => {
    // 400 claims on a hub that reserved room for 3 — the overflow spirals out
    // past its own disc, and the world box has to cover it.
    const rows = growHub(manyHubs(30), 'H0001', 400, 'big')
    const map = layoutMap(rows)
    const { minX, minY, size } = map.world
    for (let i = 0; i < map.count; i++) {
      expect(map.x[i]).toBeGreaterThanOrEqual(minX)
      expect(map.y[i]).toBeGreaterThanOrEqual(minY)
      expect(map.x[i]).toBeLessThanOrEqual(minX + size)
      expect(map.y[i]).toBeLessThanOrEqual(minY + size)
    }
  })
})
