/**
 * Where a day's timed events sit across the column, so every one stays
 * readable when they overlap.
 *
 * Written from scratch for this app. The behaviour it aims for is the one
 * common to calendar apps (a later event is drawn offset on top of the earlier
 * one, instead of the column being cut into equal slivers); no code was taken
 * from another project.
 *
 * The rules:
 *
 *  1. Two events that overlap and start within `SIDE_BY_SIDE_MINUTES` of each
 *     other can't be layered: one's title would cover the other's. They go
 *     side by side, in lanes. Events chained that way form one "side group".
 *  2. A side group that starts later than a group it overlaps is drawn on top
 *     of it, one indent step further in. The earlier group keeps its full
 *     width underneath, so its title row (the time before the later one
 *     starts) and its left edge stay visible.
 *  3. Inside a side group an event widens to the right over lanes nothing in
 *     its group occupies during its time.
 *  4. A very short event counts as `MIN_VISUAL_MINUTES` long, the height it is
 *     drawn at, so two back-to-back five-minute events don't draw over each
 *     other.
 *
 * Pure: minutes in, fractions of the column out.
 */

/** Starts closer than this (and overlapping) sit side by side; further apart, the later one is layered on top. */
export const SIDE_BY_SIDE_MINUTES = 15
/** The shortest an event is drawn, and so the shortest it counts as for overlap. */
export const MIN_VISUAL_MINUTES = 15
/** How far each layer is indented, as a fraction of the column. */
export const LAYER_INDENT = 0.1
/** However deep the layers go, the indents together never take more than this much of the column. */
export const MAX_TOTAL_INDENT = 0.4

export interface LayoutInput {
  id: string
  /** Minutes from the start of the day (any consistent origin works). */
  start: number
  end: number
}

export interface LayoutBox {
  /** Left edge, 0-1 of the column. */
  left: number
  /** Width, 0-1 of the column. */
  width: number
  /** How many groups this one is layered over (0 = on the grid). */
  depth: number
  /** Its lane in its side group, and how many lanes that group has. */
  lane: number
  lanes: number
  /** Paint order: higher is on top. */
  zIndex: number
}

interface Item extends LayoutInput {
  /** The end it is drawn to (rule 4). */
  visualEnd: number
  group: number
  lane: number
}

const overlaps = (a: Item, b: Item) => a.start < b.visualEnd && b.start < a.visualEnd

/** Lay out one day column's events. Returns a box per input id. */
export function layoutDayEvents(inputs: readonly LayoutInput[]): Map<string, LayoutBox> {
  const items: Item[] = inputs
    .map((e) => {
      const end = Math.max(e.end, e.start)
      return { ...e, end, visualEnd: Math.max(end, e.start + MIN_VISUAL_MINUTES), group: -1, lane: 0 }
    })
    // Earliest first; of two that start together the longer one first, so it takes the left lane.
    .sort((a, b) => a.start - b.start || b.visualEnd - a.visualEnd || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  // Rule 1: side groups, the chains of events that overlap and start close together.
  const parent = items.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      // Sorted by start: nothing after this one is close enough either.
      if (items[j].start - items[i].start >= SIDE_BY_SIDE_MINUTES) break
      if (overlaps(items[i], items[j])) parent[find(j)] = find(i)
    }
  }

  // Groups in order of their first event (the union keeps the earliest index as the root).
  const groupIndexOfRoot = new Map<number, number>()
  const groups: Item[][] = []
  items.forEach((item, i) => {
    const root = find(i)
    let g = groupIndexOfRoot.get(root)
    if (g === undefined) {
      g = groups.length
      groupIndexOfRoot.set(root, g)
      groups.push([])
    }
    item.group = g
    groups[g].push(item)
  })

  // Lanes inside each group: the first lane whose events are all over by the time this one starts.
  const laneCounts = groups.map((group) => {
    const laneEnds: number[] = []
    for (const item of group) {
      let lane = laneEnds.findIndex((end) => end <= item.start)
      if (lane === -1) lane = laneEnds.length
      laneEnds[lane] = item.visualEnd
      item.lane = lane
    }
    return laneEnds.length
  })

  // Rule 2: a group sits one layer above the deepest earlier group it overlaps.
  const depths: number[] = []
  groups.forEach((group, g) => {
    let depth = 0
    for (let h = 0; h < g; h++) {
      if (groups[h].some((a) => group.some((b) => overlaps(a, b)))) depth = Math.max(depth, depths[h] + 1)
    }
    depths[g] = depth
  })

  const maxDepth = depths.reduce((m, d) => Math.max(m, d), 0)
  const indent = maxDepth === 0 ? 0 : Math.min(LAYER_INDENT, MAX_TOTAL_INDENT / maxDepth)

  const boxes = new Map<string, LayoutBox>()
  groups.forEach((group, g) => {
    const lanes = laneCounts[g]
    const regionLeft = depths[g] * indent
    const laneWidth = (1 - regionLeft) / lanes
    for (const item of group) {
      // Rule 3: widen over the lanes to the right that are free during this event.
      let span = 1
      while (item.lane + span < lanes && !group.some((other) => other.lane === item.lane + span && overlaps(item, other))) span++
      boxes.set(item.id, {
        left: regionLeft + item.lane * laneWidth,
        width: laneWidth * span,
        depth: depths[g],
        lane: item.lane,
        lanes,
        zIndex: depths[g] + 1,
      })
    }
  })
  return boxes
}
