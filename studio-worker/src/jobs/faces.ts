/**
 * faces: where the faces are in recordings, macOS only.
 *
 * For each recording: it is staged (cached, checked against its sha256) and
 * face-track (../vision/native.ts) reads it, finding the face boxes every
 * `every` seconds (0.2 by default): each box in fractions of the frame
 * (top-left origin), which way the face is turned (yaw, pitch) and how sure
 * Vision is. The app caches each track by the recording's bytes, so a
 * recording is tracked once; the director pass and a narrower format's crops
 * read it.
 */
import type { FaceSample } from '../../../web/src/lib/studio/engine/director.ts'
import { stageAssets } from '../assets.ts'
import { mediaTimeout } from '../media.ts'
import { helperBinary, runHelper, swiftCompiler } from '../vision/native.ts'
import { JobError, type JobHandler } from './context.ts'

/** A number rounded to 3 places, or undefined when it is not one. Pure. */
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : undefined)

/** One line of face-track as a sample, or null when it is not one (the closing `done` line). Pure. */
export function faceSample(line: Record<string, unknown>): FaceSample | null {
  const t = num(line.t)
  if (t === undefined || t < 0 || !Array.isArray(line.faces)) return null
  const faces = line.faces.flatMap((raw) => {
    const f = (raw ?? {}) as Record<string, unknown>
    const [x, y, w, h, confidence] = [num(f.x), num(f.y), num(f.w), num(f.h), num(f.confidence)]
    if (x === undefined || y === undefined || w === undefined || h === undefined || confidence === undefined) return []
    const yaw = num(f.yaw)
    const pitch = num(f.pitch)
    return [{ x, y, w, h, confidence: Math.max(0, Math.min(1, confidence)), ...(yaw !== undefined ? { yaw } : {}), ...(pitch !== undefined ? { pitch } : {}) }]
  })
  return { t, faces: faces.slice(0, 20) }
}

export const runFaces: JobHandler<'faces'> = async (ctx) => {
  const { assets } = ctx.job.input
  if (!Array.isArray(assets) || !assets.length) throw new JobError('Name at least one recording to find faces in')
  const every = Math.max(0.05, Math.min(2, Number(ctx.job.input.every) || 0.2))
  const swiftc = await swiftCompiler()
  if (!swiftc) throw new JobError('Finding faces needs the Studio worker running on a Mac (macOS Vision)')
  const helper = await helperBinary(ctx.config.workDir, 'face-track', swiftc)
  const tracks: { assetId: string; sha256: string; every: number; samples: FaceSample[] }[] = []
  for (const [index, asset] of assets.entries()) {
    if (asset.kind !== 'video') throw new JobError(`Faces are found in videos (${asset.name} is not one)`)
    const share = (f: number) => ctx.progress((index + Math.max(0, Math.min(1, f))) / assets.length)
    const seconds = asset.durationSeconds ?? 600
    const release = await stageAssets(ctx, [asset], (f) => share(f * 0.1))
    try {
      ctx.log(`Finding the face in ${asset.name}`)
      const samples: FaceSample[] = []
      await runHelper(helper, [ctx.cache.pathOf(asset.file), '--every', String(every)], (line) => {
        const sample = faceSample(line)
        if (!sample) return
        samples.push(sample)
        share(0.1 + 0.9 * Math.min(1, sample.t / Math.max(0.1, seconds)))
      }, { signal: ctx.signal, timeout: mediaTimeout(seconds, 2) })
      const found = samples.filter((s) => s.faces.length).length
      ctx.log(`${asset.name}: ${samples.length} samples, a face in ${found}`)
      tracks.push({ assetId: asset.id, sha256: asset.sha256, every, samples: samples.slice(0, 40_000) })
    } finally {
      release()
    }
  }
  ctx.progress(1)
  return { tracks }
}
