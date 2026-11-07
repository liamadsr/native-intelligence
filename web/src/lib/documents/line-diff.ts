/**
 * Line diffs and a three-way merge for document bodies. Client-safe (no
 * imports): the document panel uses the merge when its save loses a
 * compare-and-swap (migration 364), and the history view shows the diff.
 *
 * The diff is Myers' O(ND) on lines, after trimming the common head and tail,
 * so an edit to one section of a long document stays cheap. Past
 * MAX_EDIT_DISTANCE line edits it stops looking for matches and calls the whole
 * middle changed (a rewrite reads as one block either way).
 */

const MAX_EDIT_DISTANCE = 1000

/** Pairs [i, j]: line i of `a` is line j of `b`, in order. */
export function matchLines(a: string[], b: string[]): Array<[number, number]> {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++

  const pairs: Array<[number, number]> = []
  for (let i = 0; i < head; i++) pairs.push([i, i])
  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  for (const [i, j] of myers(midA, midB)) pairs.push([i + head, j + head])
  for (let t = tail; t > 0; t--) pairs.push([a.length - t, b.length - t])
  return pairs
}

function myers(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return []
  const max = Math.min(n + m, MAX_EDIT_DISTANCE)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d++) {
    // Only the diagonals step d reads back (-d-1 .. d+1): O(D^2) memory.
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1]
      else x = v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, a, b, d)
    }
  }
  // Too far apart: no matches in the middle.
  return []
}

function backtrack(trace: Int32Array[], a: string[], b: string[], dEnd: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = []
  let x = a.length
  let y = b.length
  for (let d = dEnd; d > 0; d--) {
    const row = trace[d]
    const at = (k: number) => row[k + d + 1]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
      pairs.push([x, y])
    }
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    x--
    y--
    pairs.push([x, y])
  }
  return pairs.reverse()
}

export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string; oldLine?: number; newLine?: number }

/** The diff from `before` to `after`, line by line. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  for (const [pi, pj] of [...matchLines(a, b), [a.length, b.length] as [number, number]]) {
    while (i < pi) out.push({ kind: 'removed', text: a[i], oldLine: ++i })
    while (j < pj) out.push({ kind: 'added', text: b[j], newLine: ++j })
    if (pi < a.length && pj < b.length) {
      out.push({ kind: 'same', text: a[pi], oldLine: pi + 1, newLine: pj + 1 })
      i = pi + 1
      j = pj + 1
    }
  }
  return out
}

/** Lines added and removed. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.kind === 'added') added++
    else if (l.kind === 'removed') removed++
  }
  return { added, removed }
}

/**
 * The diff with unchanged runs folded to `context` lines either side of a
 * change; a fold is `{ kind: 'fold', count }`.
 */
export function foldDiff(lines: DiffLine[], context = 3): Array<DiffLine | { kind: 'fold'; count: number }> {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((l, idx) => {
    if (l.kind === 'same') return
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = true
  })
  const out: Array<DiffLine | { kind: 'fold'; count: number }> = []
  let folded = 0
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      if (folded) out.push({ kind: 'fold', count: folded })
      folded = 0
      out.push(l)
    } else {
      folded++
    }
  })
  if (folded) out.push({ kind: 'fold', count: folded })
  return out
}

export type MergeResult = { ok: true; text: string } | { ok: false }

/**
 * Three-way merge by lines (diff3): the changes from `base` to `mine` and
 * from `base` to `theirs`, both kept when they touch different lines; the
 * same change made on both sides kept once. Two different changes to the
 * same lines are a conflict ({ ok: false }): nothing is guessed.
 */
export function merge3(base: string, mine: string, theirs: string): MergeResult {
  if (mine === theirs) return { ok: true, text: mine }
  if (mine === base) return { ok: true, text: theirs }
  if (theirs === base) return { ok: true, text: mine }
  const o = base.split('\n')
  const a = mine.split('\n')
  const b = theirs.split('\n')
  const inA = new Int32Array(o.length).fill(-1)
  const inB = new Int32Array(o.length).fill(-1)
  for (const [i, j] of matchLines(o, a)) inA[i] = j
  for (const [i, j] of matchLines(o, b)) inB[i] = j

  const out: string[] = []
  let io = 0
  let ia = 0
  let ib = 0
  const resolve = (oEnd: number, aEnd: number, bEnd: number): boolean => {
    const co = o.slice(io, oEnd)
    const ca = a.slice(ia, aEnd)
    const cb = b.slice(ib, bEnd)
    const same = (x: string[], y: string[]) => x.length === y.length && x.every((l, k) => l === y[k])
    if (same(ca, co)) out.push(...cb)
    else if (same(cb, co)) out.push(...ca)
    else if (same(ca, cb)) out.push(...ca)
    else return false
    return true
  }
  for (let i = 0; i < o.length; i++) {
    // A stable line: matched on both sides, past where each side is.
    if (inA[i] < ia || inB[i] < ib) continue
    if (!resolve(i, inA[i], inB[i])) return { ok: false }
    out.push(o[i])
    io = i + 1
    ia = inA[i] + 1
    ib = inB[i] + 1
  }
  if (!resolve(o.length, a.length, b.length)) return { ok: false }
  return { ok: true, text: out.join('\n') }
}
