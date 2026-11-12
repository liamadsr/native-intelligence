/**
 * Where the person is in a picture, for measurements such as "does this
 * overlay cover the face?" (the visual check). macOS only: check
 * `visionState().on.has('faces')` (./probe.ts) first; elsewhere these throw a
 * JobError saying so.
 *
 *   facesAndPersonAt(file, times, opts)   moments of a recording: each time's
 *                                         face boxes, the box around the person,
 *                                         and the person mask
 *   subjectsOfFrames(frames, opts)        the same for PNG frames already drawn
 *   maskAt(mask, w, h)                    a mask at a frame's own size (the
 *                                         visual check's Subject.mask)
 *
 * Every box is in fractions of the frame, top-left origin. The mask is
 * Vision's person segmentation (0–255, 255 = person) at Vision's own size.
 */
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from '../media.ts'
import { JobError } from '../jobs/context.ts'
import { helperBinary, runHelper, swiftCompiler } from './native.ts'

export type Box = { x: number; y: number; w: number; h: number }
export type FaceBox = Box & { confidence: number }
/** A greyscale mask, row by row, one byte a pixel. */
export type Mask = { w: number; h: number; data: Uint8Array }
export type FrameSubject = { file: string; faces: FaceBox[]; person: Box | null; mask: Mask | null }
export type SubjectAt = { t: number; faces: FaceBox[]; person: Box | null; mask: Mask | null }

/** A binary PGM (P5, 8-bit) as a mask, or null when it is not one. Pure. */
export function readPgm(buf: Uint8Array): Mask | null {
  // Header: "P5", width, height, maxval, separated by whitespace, then exactly one whitespace byte.
  let i = 0
  const tokens: string[] = []
  while (tokens.length < 4 && i < buf.length) {
    while (i < buf.length && /\s/.test(String.fromCharCode(buf[i]!))) i++
    let token = ''
    while (i < buf.length && !/\s/.test(String.fromCharCode(buf[i]!))) token += String.fromCharCode(buf[i++]!)
    if (token) tokens.push(token)
  }
  const [magic, ws, hs, maxs] = tokens
  const w = Number(ws), h = Number(hs)
  if (magic !== 'P5' || !(w > 0) || !(h > 0) || Number(maxs) !== 255) return null
  const start = i + 1
  if (buf.length < start + w * h) return null
  return { w, h, data: buf.subarray(start, start + w * h) }
}

/** The box around the mask's pixels at or above `threshold`, in fractions, or null when there are none. Pure. */
export function personBox(mask: Mask, threshold = 128): Box | null {
  let x0 = mask.w, y0 = mask.h, x1 = -1, y1 = -1
  for (let y = 0; y < mask.h; y++) {
    const row = y * mask.w
    for (let x = 0; x < mask.w; x++) {
      if (mask.data[row + x]! < threshold) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) return null
  const r = (v: number) => Math.round(v * 1000) / 1000
  return { x: r(x0 / mask.w), y: r(y0 / mask.h), w: r((x1 - x0 + 1) / mask.w), h: r((y1 - y0 + 1) / mask.h) }
}

/** The mask at another size (nearest pixel), e.g. a frame's own for the visual check. Pure. */
export function maskAt(mask: Mask, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(mask.h - 1, Math.floor(((y + 0.5) * mask.h) / h))
    for (let x = 0; x < w; x++) out[y * w + x] = mask.data[sy * mask.w + Math.min(mask.w - 1, Math.floor(((x + 0.5) * mask.w) / w))]!
  }
  return out
}

/** One frame-subject line as a FrameSubject (its mask read from the file it wrote). */
async function toSubject(line: Record<string, unknown>): Promise<FrameSubject | null> {
  if (typeof line.file !== 'string' || !Array.isArray(line.faces)) return null
  const faces = line.faces.flatMap((raw) => {
    const f = (raw ?? {}) as Record<string, unknown>
    return [f.x, f.y, f.w, f.h, f.confidence].every((v) => typeof v === 'number' && Number.isFinite(v))
      ? [{ x: f.x as number, y: f.y as number, w: f.w as number, h: f.h as number, confidence: f.confidence as number }]
      : []
  })
  let mask: Mask | null = null
  if (typeof line.mask === 'string') {
    mask = readPgm(new Uint8Array(await readFile(line.mask)))
    await rm(line.mask, { force: true }).catch(() => undefined)
  }
  return { file: line.file, faces, person: mask ? personBox(mask) : null, mask }
}

/** Where the person is in each PNG frame (in the order given). */
export async function subjectsOfFrames(frames: string[], opts: { workDir: string; signal?: AbortSignal }): Promise<FrameSubject[]> {
  if (!frames.length) return []
  const swiftc = await swiftCompiler()
  if (!swiftc) throw new JobError('Finding the person needs the Studio worker running on a Mac (macOS Vision)')
  const helper = await helperBinary(opts.workDir, 'frame-subject', swiftc)
  const lines: Record<string, unknown>[] = []
  await runHelper(helper, frames, (line) => lines.push(line), { signal: opts.signal, timeout: 60_000 + frames.length * 5_000 })
  const found = new Map<string, FrameSubject>()
  for (const line of lines) {
    const subject = await toSubject(line)
    if (subject) found.set(subject.file, subject)
  }
  return frames.map((file) => found.get(file) ?? { file, faces: [], person: null, mask: null })
}

/**
 * Where the person is at these moments (seconds, on the file's own clock) of a
 * video: a frame is drawn at each time with FFmpeg into `scratch`, then read
 * with Vision. Answers one entry per time, in the order given.
 */
export async function facesAndPersonAt(file: string, times: number[], opts: { workDir: string; scratch: string; signal?: AbortSignal }): Promise<SubjectAt[]> {
  const frames: string[] = []
  try {
    for (const [i, t] of times.entries()) {
      const frame = join(opts.scratch, `subject-${i}.png`)
      await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', frame], { timeout: 60_000, signal: opts.signal })
      frames.push(frame)
    }
    const subjects = await subjectsOfFrames(frames, opts)
    return subjects.map((s, i) => ({ t: times[i]!, faces: s.faces, person: s.person, mask: s.mask }))
  } finally {
    for (const frame of frames) await rm(frame, { force: true }).catch(() => undefined)
  }
}
