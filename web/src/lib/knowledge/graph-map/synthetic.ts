/**
 * Synthetic maps — the only way to exercise multi-tile paths.
 *
 * Real workspaces are 10³–10⁴ nodes (one tile), so the benchmark page and the
 * tiling tests need generated data (§7 step 2). Two entry points:
 *
 *   generateSyntheticRows  — real SourceRows through the real pipeline.
 *   generateSyntheticMap   — the 1M-node fast path: builds the LaidOutMap
 *                            directly in typed arrays, no row objects at all.
 */

import { hash01, hashInt01 } from './hash'
import {
  claimRadius,
  discRadius,
  hubRadius,
  slotOffset,
  worldBounds,
  NO_CONFIDENCE,
  NO_INDEX,
  SCOPE_CODE,
  type LaidOutMap,
} from './layout'
import {
  CLAIM_TYPES,
  DISC_PAD,
  HUB_R0,
  NODE_KIND,
  SPACING,
  SLOT_JITTER,
  type NodeKey,
  type SourceClaimRow,
  type SourceHubRow,
  type SourceLinkRow,
  type SourceRows,
} from './types'

/** Shape constants — the hub-and-spoke feel of a real workspace. */
const DEFAULT_CLAIMS_PER_HUB = 10
/** Fraction of claims carrying a second link to an anchor (project/company) hub. */
const DEFAULT_ANCHOR_RATIO = 0.12
/** Fraction of claims carrying a claim→claim link. */
const DEFAULT_CLAIM_CLAIM_RATIO = 0.03

const HUB_TYPES = ['capture', 'document', 'contact', 'campaign'] as const

/** Relation lookup table, sorted — `rel` indexes into this (see MapMeta). */
const SYNTH_RELATIONS = ['about', 'mentions', 'supports'] as const
const SYNTH_REL = { about: 0, mentions: 1, supports: 2 } as const
const ANCHOR_TYPES = ['project', 'company'] as const

const EPOCH = Date.UTC(2025, 0, 1)
/** One claim every ~7 minutes keeps a 1M-claim map inside ~13 years. */
const STEP_MS = 7 * 60_000

/**
 * A handful of synthetic authors.
 *
 * Deliberately a SMALL pool: `created_by` is held as an index into a string
 * table, and a generator that gave every claim a unique author would make the
 * benchmark's memory profile unlike any real workspace's.
 */
const SYNTH_AUTHORS = 8
/** Fraction of claims with no author / no event time / no verification. */
const NO_AUTHOR_RATIO = 0.1
const NO_EVENT_AT_RATIO = 0.15
const VERIFIED_RATIO = 0.2
/** Fraction of claims scoped to a member rather than the workspace. */
const PERSONAL_RATIO = 0.12

/** Author id for slot `a`, or null for the un-attributed share. */
function synthAuthor(c: number, seed: number): string | null {
  if (hashInt01(c, seed ^ 0x3f) < NO_AUTHOR_RATIO) return null
  return synthId('member', Math.floor(hashInt01(c, seed ^ 0x77) * SYNTH_AUTHORS) % SYNTH_AUTHORS)
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

/** Deterministic pseudo-uuid — stable across runs, no crypto, no allocation churn. */
function synthId(prefix: string, i: number): string {
  return `${prefix}-${pad(i, 10)}`
}

export interface SyntheticRowOptions {
  claims: number
  seed?: number
  claimsPerHub?: number
  anchorRatio?: number
  claimClaimRatio?: number
  /**
   * Fraction of ALL claims that additionally link to ONE anchor hub.
   *
   * Real workspaces have a heavy tail: the largest observed has a single
   * project carrying 1,614 linked claims. Without this the generated anchors
   * are all roughly equal, so the benchmark never exercises the one hub whose
   * disc and degree dwarf every other.
   */
  megaAnchorRatio?: number
}

/** Hub-and-spoke SourceRows: `claims/claimsPerHub` hubs plus a few anchors. */
export function generateSyntheticRows(opts: SyntheticRowOptions): SourceRows {
  const claimCount = Math.max(0, Math.floor(opts.claims))
  const seed = opts.seed ?? 1
  const perHub = Math.max(1, Math.floor(opts.claimsPerHub ?? DEFAULT_CLAIMS_PER_HUB))
  const anchorRatio = opts.anchorRatio ?? DEFAULT_ANCHOR_RATIO
  const claimClaimRatio = opts.claimClaimRatio ?? DEFAULT_CLAIM_CLAIM_RATIO
  const megaAnchorRatio = opts.megaAnchorRatio ?? 0

  const hubCount = Math.max(1, Math.ceil(claimCount / perHub))
  // Anchors are the shared spine: roughly one per 40 hubs, at least one.
  const anchorCount = Math.max(1, Math.round(hubCount / 40))

  const hubs: SourceHubRow[] = []
  for (let h = 0; h < hubCount; h++) {
    const type = HUB_TYPES[h % HUB_TYPES.length]
    hubs.push({ type, id: synthId('hub', h), label: `${type} ${h}` })
  }
  for (let a = 0; a < anchorCount; a++) {
    const type = ANCHOR_TYPES[a % ANCHOR_TYPES.length]
    hubs.push({ type, id: synthId('anchor', a), label: `${type} ${a}` })
  }

  const claims: SourceClaimRow[] = new Array(claimCount)
  const links: SourceLinkRow[] = []
  for (let c = 0; c < claimCount; c++) {
    const id = synthId('claim', c)
    const t = EPOCH + c * STEP_MS
    const iso = new Date(t).toISOString()
    const rnd = hashInt01(c, seed)
    claims[c] = {
      id,
      text: `Synthetic claim ${c} — hub ${Math.floor(c / perHub)}`,
      type: CLAIM_TYPES[Math.floor(hashInt01(c, seed ^ 0x51) * CLAIM_TYPES.length)],
      confidence: rnd < 0.1 ? null : Math.round(rnd * 100) / 100,
      // ~8% dismissed so slot holes are exercised; ~35% confirmed.
      confirmation: rnd < 0.08 ? 'dismissed' : rnd < 0.43 ? 'confirmed' : 'suggested',
      status: rnd > 0.97 ? 'superseded' : 'active',
      scope: hashInt01(c, seed ^ 0x2b) < PERSONAL_RATIO ? 'personal' : 'workspace',
      // Auto-acceptance tracks the confidence policy, so it correlates with a
      // high confidence rather than being independently random.
      auto_accepted: rnd >= 0.08 && rnd < 0.43 && rnd > 0.3,
      created_by: synthAuthor(c, seed),
      created_at: iso,
      // Claims are extracted AFTER the meeting they describe, so the event
      // time trails creation. A share have none at all.
      event_at:
        hashInt01(c, seed ^ 0x4d) < NO_EVENT_AT_RATIO
          ? null
          : new Date(t - 3 * 3600_000).toISOString(),
      last_verified_at:
        hashInt01(c, seed ^ 0x6e) < VERIFIED_RATIO
          ? new Date(t + 24 * 3600_000).toISOString()
          : null,
    }

    const hub = Math.floor(c / perHub) % hubCount
    links.push({
      source_id: id,
      target_type: HUB_TYPES[hub % HUB_TYPES.length],
      target_id: synthId('hub', hub),
      relation: 'mentions',
      created_at: iso,
    })

    if (hashInt01(c, seed ^ 0xa5) < anchorRatio) {
      const a = Math.floor(hashInt01(c, seed ^ 0xb7) * anchorCount) % anchorCount
      links.push({
        source_id: id,
        target_type: ANCHOR_TYPES[a % ANCHOR_TYPES.length],
        target_id: synthId('anchor', a),
        relation: 'about',
        // Later than the hub link, so the primary hub stays the hub.
        created_at: new Date(t + 1000).toISOString(),
      })
    }

    // The heavy tail: anchor 0 (a project) collects a large share of the map.
    if (megaAnchorRatio > 0 && hashInt01(c, seed ^ 0x1d) < megaAnchorRatio) {
      links.push({
        source_id: id,
        target_type: ANCHOR_TYPES[0],
        target_id: synthId('anchor', 0),
        relation: 'about',
        // Later than the provenance link, so the primary hub stays the hub.
        created_at: new Date(t + 1500).toISOString(),
      })
    }

    if (c > 0 && hashInt01(c, seed ^ 0xc3) < claimClaimRatio) {
      const other = Math.floor(hashInt01(c, seed ^ 0xd9) * c)
      links.push({
        source_id: id,
        target_type: 'claim',
        target_id: synthId('claim', other),
        relation: 'supports',
        created_at: new Date(t + 2000).toISOString(),
      })
    }
  }

  return { claims, links, hubs }
}

export interface SyntheticMapOptions {
  nodes: number
  seed?: number
}

/**
 * FAST PATH for the 1M-node benchmark: the same hub-and-spoke shape, written
 * straight into the LaidOutMap's typed arrays.
 *
 * Hubs are laid on a phyllotaxis of their own rather than through the spiral
 * packer — the packer's job is stability under appends, which a throwaway
 * benchmark map does not need, and this keeps 1M nodes at a few seconds.
 */
export function generateSyntheticMap(opts: SyntheticMapOptions): LaidOutMap {
  const total = Math.max(1, Math.floor(opts.nodes))
  const seed = opts.seed ?? 1
  const perHub = DEFAULT_CLAIMS_PER_HUB

  // total = claims + hubs + anchors, with hubs ≈ claims/perHub. `hubCount` is
  // then re-derived from the claim count, because claims are dealt out as
  // `floor(c / perHub)` — deriving it any other way leaves trailing hubs with
  // no claims at all, which the visibility rule would (correctly) drop, making
  // the generated node count smaller than the caller asked for.
  const approxHubs = Math.max(1, Math.round(total / (perHub + 1)))
  const anchorCount = Math.max(1, Math.round(approxHubs / 40))
  const claimCount = Math.max(0, total - approxHubs - anchorCount)
  const hubCount = Math.max(1, Math.ceil(claimCount / perHub))
  const hubTotal = hubCount + anchorCount
  const count = claimCount + hubTotal

  const keys: NodeKey[] = new Array(count)
  const labels: string[] = new Array(count)
  const kind = new Uint8Array(count)
  const etype = new Int16Array(count)
  const x = new Float64Array(count)
  const y = new Float64Array(count)
  const r = new Float32Array(count)
  const importance = new Float32Array(count)
  const degree = new Uint32Array(count)
  const flags = new Uint8Array(count)

  const claimIds: string[] = new Array(claimCount)
  const claimConfidence = new Float32Array(claimCount)
  const claimCreatedAt = new Float64Array(claimCount)
  const claimTypeIdx = new Uint8Array(claimCount)
  const claimConfirmed = new Uint8Array(claimCount)
  const claimScope = new Uint8Array(claimCount)
  const claimAutoAccepted = new Uint8Array(claimCount)
  const claimCreatedBy = new Int32Array(claimCount)
  const claimEventAt = new Float64Array(claimCount)
  const claimLastVerifiedAt = new Float64Array(claimCount)
  const claimHub = new Uint32Array(claimCount)

  // The same small author pool the row generator uses, written straight into
  // the string table the real layout would have built.
  const claimCreators = Array.from({ length: SYNTH_AUTHORS }, (_u, a) =>
    synthId('member', a),
  )

  // ── Hub positions: one global phyllotaxis, spaced by the largest disc so
  // discs never overlap. ──
  const hubRowCount = new Int32Array(hubTotal)
  for (let c = 0; c < claimCount; c++) hubRowCount[Math.floor(c / perHub) % hubCount]++
  // Anchors collect the ~12% second links.
  const perAnchor = Math.ceil((claimCount * DEFAULT_ANCHOR_RATIO) / anchorCount)
  for (let a = 0; a < anchorCount; a++) hubRowCount[hubCount + a] = perAnchor

  // A synthetic hub gets every one of its claims at once, so its row count IS
  // its birth count — the number `discRadius` reserves against.
  let maxDisc = 0
  const hubR = new Float64Array(hubTotal)
  for (let h = 0; h < hubTotal; h++) {
    hubR[h] = discRadius(hubRowCount[h])
    if (hubR[h] > maxDisc) maxDisc = hubR[h]
  }
  const hubSpacing = 2 * maxDisc
  const goldenAngle = Math.PI * (3 - Math.sqrt(5))

  const hubX = new Float64Array(hubTotal)
  const hubY = new Float64Array(hubTotal)
  for (let h = 0; h < hubTotal; h++) {
    const rad = hubSpacing * Math.sqrt(h + 0.5)
    const th = h * goldenAngle
    hubX[h] = rad * Math.cos(th)
    hubY[h] = rad * Math.sin(th)
  }

  // ── Degrees (analytic — no edge list is materialised for the hub side). ──
  const hubDegree = new Uint32Array(hubTotal)
  for (let c = 0; c < claimCount; c++) hubDegree[Math.floor(c / perHub) % hubCount]++

  // ── Edges: one per claim to its hub, plus the anchor and claim→claim links.
  const edgeSourceArr: number[] = []
  const edgeTargetArr: number[] = []
  const edgeRelArr: number[] = []

  const entityTypes = ['campaign', 'capture', 'company', 'contact', 'document', 'project'].sort()
  const etypeIdx = new Map(entityTypes.map((t, i) => [t, i]))

  for (let c = 0; c < claimCount; c++) {
    const h = Math.floor(c / perHub) % hubCount
    const slot = c % perHub
    const key = `claim:${synthId('claim', c)}`
    const phase = 2 * Math.PI * hash01(`${HUB_TYPES[h % HUB_TYPES.length]}:${synthId('hub', h)}`)
    const off = slotOffset(slot, key, phase)
    keys[c] = key
    labels[c] = `Synthetic claim ${c}`
    kind[c] = NODE_KIND.claim
    etype[c] = -1
    x[c] = hubX[h] + off.dx
    y[c] = hubY[h] + off.dy

    const rnd = hashInt01(c, seed)
    const confirmed = rnd >= 0.08 && rnd < 0.43 ? 1 : 0
    const conf = rnd < 0.1 ? NO_CONFIDENCE : Math.round(rnd * 100) / 100
    const typeIdx = Math.floor(hashInt01(c, seed ^ 0x51) * CLAIM_TYPES.length) % CLAIM_TYPES.length

    let deg = 1
    edgeSourceArr.push(c)
    edgeTargetArr.push(claimCount + h)
    edgeRelArr.push(SYNTH_REL.mentions)

    if (hashInt01(c, seed ^ 0xa5) < DEFAULT_ANCHOR_RATIO) {
      const a = Math.floor(hashInt01(c, seed ^ 0xb7) * anchorCount) % anchorCount
      edgeSourceArr.push(c)
      edgeTargetArr.push(claimCount + hubCount + a)
      edgeRelArr.push(SYNTH_REL.about)
      hubDegree[hubCount + a]++
      deg++
    }
    if (c > 0 && hashInt01(c, seed ^ 0xc3) < DEFAULT_CLAIM_CLAIM_RATIO) {
      const other = Math.floor(hashInt01(c, seed ^ 0xd9) * c)
      edgeSourceArr.push(c)
      edgeTargetArr.push(other)
      edgeRelArr.push(SYNTH_REL.supports)
      deg++
      degree[other]++
    }

    degree[c] += deg
    const createdAt = EPOCH + c * STEP_MS
    claimIds[c] = synthId('claim', c)
    claimConfidence[c] = conf
    claimCreatedAt[c] = createdAt
    claimTypeIdx[c] = typeIdx
    claimConfirmed[c] = confirmed
    claimScope[c] =
      hashInt01(c, seed ^ 0x2b) < PERSONAL_RATIO ? SCOPE_CODE.personal : SCOPE_CODE.workspace
    claimAutoAccepted[c] = confirmed && rnd > 0.3 ? 1 : 0
    claimCreatedBy[c] =
      hashInt01(c, seed ^ 0x3f) < NO_AUTHOR_RATIO
        ? NO_INDEX
        : Math.floor(hashInt01(c, seed ^ 0x77) * SYNTH_AUTHORS) % SYNTH_AUTHORS
    // NaN, not 0: an unset date must fail every ordered comparison, and 0
    // would be a real 1970 timestamp the mask would happily match.
    claimEventAt[c] =
      hashInt01(c, seed ^ 0x4d) < NO_EVENT_AT_RATIO ? Number.NaN : createdAt - 3 * 3600_000
    claimLastVerifiedAt[c] =
      hashInt01(c, seed ^ 0x6e) < VERIFIED_RATIO ? createdAt + 24 * 3600_000 : Number.NaN
    claimHub[c] = claimCount + h
    flags[c] = (confirmed ? 0 : 1) | (typeIdx << 1)
  }

  // Radii and importance need the final degrees, so run a second pass.
  for (let c = 0; c < claimCount; c++) {
    r[c] = claimRadius(degree[c])
    importance[c] =
      (claimConfirmed[c] ? 2 : 1) +
      (claimConfidence[c] < 0 ? 0.5 : claimConfidence[c]) +
      Math.log2(1 + degree[c])
  }

  for (let h = 0; h < hubTotal; h++) {
    const n = claimCount + h
    const isAnchor = h >= hubCount
    const type = isAnchor
      ? ANCHOR_TYPES[(h - hubCount) % ANCHOR_TYPES.length]
      : HUB_TYPES[h % HUB_TYPES.length]
    const id = isAnchor ? synthId('anchor', h - hubCount) : synthId('hub', h)
    keys[n] = `${type}:${id}`
    labels[n] = `${type} ${isAnchor ? h - hubCount : h}`
    kind[n] = NODE_KIND.entity
    etype[n] = etypeIdx.get(type) ?? -1
    x[n] = hubX[h]
    y[n] = hubY[h]
    degree[n] = hubDegree[h]
    r[n] = hubRadius(hubDegree[h], false)
    const weight = type === 'project' || type === 'company' || type === 'contact' || type === 'campaign' ? 3 : 2
    importance[n] = 1000 + weight + Math.log2(1 + hubDegree[h])
    flags[n] = 0
  }

  // ── CSR adjacency (claim → hub targets) for the project filter. ──
  const counts = new Uint32Array(claimCount + 1)
  for (let i = 0; i < edgeSourceArr.length; i++) {
    if (edgeTargetArr[i] >= claimCount) counts[edgeSourceArr[i] + 1]++
  }
  for (let c = 0; c < claimCount; c++) counts[c + 1] += counts[c]
  const claimHubOffsets = counts
  const claimHubTargets = new Uint32Array(claimHubOffsets[claimCount])
  const cursor = new Uint32Array(claimCount)
  for (let i = 0; i < edgeSourceArr.length; i++) {
    const t = edgeTargetArr[i]
    if (t < claimCount) continue
    const s = edgeSourceArr[i]
    claimHubTargets[claimHubOffsets[s] + cursor[s]++] = t
  }

  const projects: Array<{ id: string; label: string }> = []
  for (let a = 0; a < anchorCount; a++) {
    if (ANCHOR_TYPES[a % ANCHOR_TYPES.length] !== 'project') continue
    projects.push({ id: synthId('anchor', a), label: `project ${a}` })
  }
  projects.sort((p, q) => (p.label < q.label ? -1 : p.label > q.label ? 1 : 0))

  return {
    count,
    claimCount,
    keys,
    labels,
    kind,
    etype,
    x,
    y,
    r,
    importance,
    degree,
    flags,
    claimIds,
    claimConfidence,
    claimCreatedAt,
    claimTypeIdx,
    claimConfirmed,
    claimScope,
    claimAutoAccepted,
    claimCreatedBy,
    claimCreators,
    claimEventAt,
    claimLastVerifiedAt,
    claimHub,
    claimHubOffsets,
    claimHubTargets,
    edgeSource: Uint32Array.from(edgeSourceArr),
    edgeTarget: Uint32Array.from(edgeTargetArr),
    edgeRel: Uint8Array.from(edgeRelArr),
    entityTypes,
    relations: SYNTH_RELATIONS.slice(),
    projects,
    world: worldBounds(hubX, hubY, hubR, hubTotal),
  }
}

/** Exported for tests that assert the synthetic shape matches the real layout. */
export const SYNTHETIC_SHAPE = {
  claimsPerHub: DEFAULT_CLAIMS_PER_HUB,
  anchorRatio: DEFAULT_ANCHOR_RATIO,
  claimClaimRatio: DEFAULT_CLAIM_CLAIM_RATIO,
  hubGeometry: { HUB_R0, SPACING, DISC_PAD, SLOT_JITTER },
} as const
