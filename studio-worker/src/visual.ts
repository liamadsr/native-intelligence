/**
 * The visual check's measurements (the look job, ./jobs/checks.ts). The agent
 * can't watch the film, so it measures it: each frame is rendered twice, with
 * and without the overlays (text, cards, anything drawn on top of the picture).
 * The difference between the two is exactly what the overlays put on screen,
 * so for every overlay we know where it really lands, and for every text how
 * much contrast its letters have against what is really behind them, how big
 * it is and whether it runs off the frame. With a person finder (a mask of the
 * person and face boxes per frame) it also says how much of an overlay lands
 * on the person or their face; without one that part is not measured.
 *
 * Pure: frames come in as raw RGB.
 */
import type { EditorLayer } from '../../web/src/lib/studio/engine/layers.ts'
import type { VisualIssue, VisualIssueKind } from '../../web/src/lib/studio/engine/server-types.ts'

export type Box = { x: number; y: number; w: number; h: number }
/** A frame as raw RGB, 3 bytes a pixel, row by row. */
export type Rgb = { w: number; h: number; data: Uint8Array }
/** Where the person is in a frame: a mask (0–255, the frame's size) and face boxes (fractions). */
export type Subject = { mask: Uint8Array | null; faces: Box[] }
/** Where an overlay really lands (fractions), as the engine's VisualIssue keeps it. */
export type IssueBox = VisualIssue['box']
export type Finding = { t: number; kind: VisualIssueKind; layerId: string; name: string; value: number; box: IssueBox }

const channel = (c: number) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of an sRGB colour. */
export const luminance = ([r, g, b]: readonly number[]) => 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!)

/** WCAG contrast ratio (1 to 21) between two sRGB colours. */
export function contrastRatio(a: readonly number[], b: readonly number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

/** A #rrggbb colour (alpha ignored) as [r, g, b], or null. */
export function hexRgb(hex: string): [number, number, number] | null {
  const m = /^#?([\da-f]{6})/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** A layer's box on screen (fractions), from its centre and size, grown a little so strokes and shadows count. */
export function layerBox(layer: Pick<EditorLayer, 'x' | 'y' | 'width' | 'height'>, grow = 0.04): Box {
  const w = Math.min(1, layer.width * (1 + grow))
  const h = Math.min(1, layer.height * (1 + grow))
  const x = Math.max(0, layer.x - w / 2)
  const y = Math.max(0, layer.y - h / 2)
  return { x, y, w: Math.min(1 - x, w), h: Math.min(1 - y, h) }
}

/** The contrast a text needs: 4.5:1, or 3:1 for large text (at least 5 % of the frame height). */
export const contrastNeeded = (sizeFraction: number) => (sizeFraction >= 0.05 ? 3 : 4.5)

/** Layers that are the picture itself (a full-frame scene or backdrop), not something drawn over it. */
export const fullFrame = (l: Pick<EditorLayer, 'kind' | 'x' | 'y' | 'width' | 'height'>) =>
  l.kind !== 'text' && l.width >= 0.95 && l.height >= 0.95 && Math.abs(l.x - 0.5) < 0.03 && Math.abs(l.y - 0.5) < 0.03

/** Springy eases run past their frames (the engine lets them settle for 1.8 times as long). */
const springy = (ease: unknown) => ease === 'spring' || ease === 'bouncy'

/**
 * Whether a layer is on screen and done arriving and not yet leaving at `frame`: an overlay is measured only then
 * (mid-animation it is faint, blurred or moving, which is not how it reads).
 */
export function settled(l: Pick<EditorLayer, 'startFrame' | 'endFrame' | 'enter' | 'exit'>, frame: number): boolean {
  const enter = l.enter.preset === 'none' ? 0 : Math.ceil(l.enter.frames * (springy(l.enter.ease) ? 1.8 : 1))
  const exit = l.exit.preset === 'none' ? 0 : l.exit.frames
  return frame >= l.startFrame + enter && frame < l.endFrame - exit
}

/** The times (seconds) to look at: every `step` from step/2, where at least one overlay is settled on screen. */
export function lookTimes(overlays: Pick<EditorLayer, 'startFrame' | 'endFrame' | 'enter' | 'exit'>[], totalSeconds: number, fps: number, step: number): number[] {
  const times: number[] = []
  for (let t = step / 2; t < totalSeconds; t += step) {
    const f = Math.round(t * fps)
    if (overlays.some((l) => settled(l, f))) times.push(Math.round(t * 1000) / 1000)
  }
  return times
}

const RANK: Record<VisualIssueKind, number> = { 'covers-face': 0, 'low-contrast': 1, 'covers-person': 2, 'off-frame': 3, 'small-text': 4 }
/** Kinds where a lower value is worse. */
const LOWER_IS_WORSE = new Set<VisualIssueKind>(['low-contrast', 'small-text'])

/** What an issue says, from its worst value. */
export function issueDetail(kind: VisualIssueKind, worst: number): string {
  switch (kind) {
    case 'covers-face':
      return `covers ${Math.round(worst * 100)}% of the face`
    case 'covers-person':
      return `sits on ${Math.round(worst * 100)}% of the person`
    case 'low-contrast':
      return `contrast ${worst.toFixed(1)}:1 against what is behind it (needs 4.5:1, or 3:1 for big text)`
    case 'small-text':
      return `${Math.round(worst)} px tall at 1080p: too small on a phone`
    case 'off-frame':
      return 'runs off the edge of the frame'
  }
}

/**
 * Per-frame findings of the same layer and kind become spans (frames up to 1.5
 * steps apart join), each with its worst value and that frame's box; worst
 * kinds first (face, contrast, person, off-frame, small text), then by time.
 */
export function mergeFindings(findings: Finding[], step: number): VisualIssue[] {
  const out: VisualIssue[] = []
  const sorted = [...findings].sort((a, b) => a.layerId.localeCompare(b.layerId) || a.kind.localeCompare(b.kind) || a.t - b.t)
  for (const f of sorted) {
    const last = out.at(-1)
    const worse = (a: number, b: number) => (LOWER_IS_WORSE.has(f.kind) ? a < b : a > b)
    if (last && last.layerId === f.layerId && last.kind === f.kind && f.t - last.to <= step * 1.5 + 1e-6) {
      last.to = f.t
      if (worse(f.value, last.worst)) {
        last.worst = f.value
        last.box = f.box
      }
    } else out.push({ kind: f.kind, layerId: f.layerId, name: f.name, from: f.t, to: f.t, worst: f.value, box: f.box, detail: '' })
  }
  for (const issue of out) issue.detail = issueDetail(issue.kind, issue.worst)
  return out.sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.from - b.from)
}

const px = (img: Rgb, i: number) => [img.data[i * 3]!, img.data[i * 3 + 1]!, img.data[i * 3 + 2]!]
const median = (values: number[]) => {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

/** The largest channel difference per pixel between two frames of the same size. */
export function difference(a: Rgb, b: Rgb): Uint8Array {
  const n = a.w * a.h
  const diff = new Uint8Array(n)
  for (let p = 0; p < n; p++) {
    diff[p] = Math.max(Math.abs(a.data[p * 3]! - b.data[p * 3]!), Math.abs(a.data[p * 3 + 1]! - b.data[p * 3 + 1]!), Math.abs(a.data[p * 3 + 2]! - b.data[p * 3 + 2]!))
  }
  return diff
}

/** The share of pixels that differ by more than `threshold` (a scene that replaces the picture changes most of them). */
export function changedShare(a: Rgb, b: Rgb, threshold = 24): number {
  const diff = difference(a, b)
  let changed = 0
  for (const d of diff) if (d > threshold) changed++
  return changed / Math.max(1, diff.length)
}

/**
 * One frame's findings: `full` with the overlays, `base` without; `active` the
 * overlays on screen at this frame; `subject` the person finder's answer, or
 * null when there is none (then nothing is said about covering anyone).
 */
export function measureFrame(t: number, full: Rgb, base: Rgb, active: EditorLayer[], subject: Subject | null): Finding[] {
  const W = full.w
  const H = full.h
  const diff = difference(full, base)
  const person = subject?.mask ?? null
  let personPx = 0
  if (person) for (const v of person) if (v > 127) personPx++
  const faces = subject?.faces ?? []
  const findings: Finding[] = []
  for (const l of active) {
    const box = layerBox(l)
    const x0 = Math.floor(box.x * W)
    const y0 = Math.floor(box.y * H)
    const x1 = Math.ceil((box.x + box.w) * W)
    const y1 = Math.ceil((box.y + box.h) * H)
    let visible = 0
    let onPerson = 0
    let edge = 0
    let minX = W
    let minY = H
    let maxX = 0
    let maxY = 0
    const faceHits = faces.map(() => 0)
    const seen: number[] = []
    let peak = 0
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = y * W + x
        if (diff[p]! <= 24) continue
        visible++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        if (person && person[p]! > 127) onPerson++
        // A face box also holds a little background beside the head: only pixels on the person count.
        if (!person || person[p]! > 127) faces.forEach((fc, k) => {
          if (x >= fc.x * W && x < (fc.x + fc.w) * W && y >= fc.y * H && y < (fc.y + fc.h) * H) faceHits[k]! += 1
        })
        if (x <= 1 || y <= 1 || x >= W - 2 || y >= H - 2) edge++
        seen.push(p)
        if (diff[p]! > peak) peak = diff[p]!
      }
    }
    // Not on screen (hidden behind something, or gone). A text may be a few dozen pixels of small print.
    if (visible < (l.kind === 'text' ? 20 : W * H * 0.0015)) continue
    // The letters' cores: the pixels the overlay changed most (faint text changes little anywhere, so relative to its peak).
    const strong = seen.filter((p) => diff[p]! >= Math.max(25, 0.6 * peak))
    // The box is what the overlay really puts on screen, not its whole frame.
    const drawn: IssueBox = { x: minX / W, y: minY / H, width: (maxX - minX + 1) / W, height: (maxY - minY + 1) / H }
    const item = { layerId: l.id, name: l.name ?? l.id, box: drawn, t }
    // The main person is the biggest face: any real overlap there counts; a face in the background only when mostly hidden.
    const sizes = faces.map((fc) => fc.w * fc.h)
    const main = sizes.indexOf(Math.max(...sizes))
    faceHits.forEach((hits, k) => {
      const fc = faces[k]!
      const area = fc.w * W * fc.h * H
      const share = area > 0 ? hits / area : 0
      if (k === main ? share > 0.08 : share > 0.5) findings.push({ ...item, kind: 'covers-face', value: share })
    })
    if (person && personPx > W * H * 0.03 && onPerson / personPx > 0.12) findings.push({ ...item, kind: 'covers-person', value: onPerson / personPx })
    if (l.kind === 'text') {
      const style = l.style as { size?: number; background?: string; color?: string; fit?: boolean }
      const size = Number(style.size ?? 0.06)
      const own = style.background ? hexRgb(String(style.background)) : null
      const ink = hexRgb(String(style.color ?? '#ffffff'))
      let ratio: number | null = null
      if (own && ink) ratio = contrastRatio(ink, own) // a label on its own panel
      else {
        const sample = strong.length > 4000 ? strong.filter((_, k) => k % Math.ceil(strong.length / 4000) === 0) : strong
        if (sample.length >= 30) {
          const lf = median(sample.map((p) => luminance(px(full, p))))
          const lb = median(sample.map((p) => luminance(px(base, p))))
          ratio = (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05)
        }
      }
      if (ratio !== null && ratio < contrastNeeded(size)) findings.push({ ...item, kind: 'low-contrast', value: ratio })
      if (size * 1080 < 30) findings.push({ ...item, kind: 'small-text', value: size * 1080 })
      if (edge > visible * 0.01 && !style.fit) findings.push({ ...item, kind: 'off-frame', value: edge / visible })
    }
  }
  return findings
}
