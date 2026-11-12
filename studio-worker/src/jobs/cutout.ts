/**
 * cutout: recordings with the person (or any main subject) cut out, macOS only.
 *
 * For each recording asked for: it is staged (cached, checked against its
 * sha256), subject-matte (../vision/native.ts) finds the subject in every frame
 * and writes a greyscale matte frame for frame with it, and FFmpeg merges the
 * two into a transparent VP9 WebM (../vision/cutout.ts). The WebM is measured
 * as the editor imports media, must match the recording frame for frame (±1)
 * and keep its alpha channel, and is stored as a library asset
 * (`assets/<sha256>.webm`). The app registers the cut-outs and attaches them to
 * the video when the job completes.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { buildAsset, inspectFile, publishAsset, stageAssets } from '../assets.ts'
import { fileSha256 } from '../app-client.ts'
import { mediaTimeout } from '../media.ts'
import { cutoutSize, hasAlpha, mergeCutout } from '../vision/cutout.ts'
import { helperBinary, runHelper, swiftCompiler } from '../vision/native.ts'
import { checkAborted, JobError, type JobHandler } from './context.ts'
import type { CutoutMade } from '../../../web/src/lib/studio/server/job-contract.ts'

/** The matte is found at up to this many pixels on the long side, then scaled to the cut-out's size. */
export const MATTE_MAX_SIDE = 1280

/** The cut-out's name in the library: the recording's, marked. Pure. */
export const cutoutName = (name: string) => `${name.replace(/\.[a-z0-9]+$/i, '')} — cut-out.webm`.slice(0, 250)

export const runCutout: JobHandler<'cutout'> = async (ctx) => {
  const { assets, mode } = ctx.job.input
  if (!Array.isArray(assets) || !assets.length) throw new JobError('Name at least one recording to cut out')
  if (mode !== 'person' && mode !== 'subject') throw new JobError('A cut-out isolates the person or any subject')
  const swiftc = await swiftCompiler()
  if (!swiftc) throw new JobError('Cut-outs need the Studio worker running on a Mac (macOS Vision)')
  const matteHelper = await helperBinary(ctx.config.workDir, 'subject-matte', swiftc)
  const cutouts: CutoutMade[] = []
  for (const [index, asset] of assets.entries()) {
    if (asset.kind !== 'video' || !asset.width || !asset.height) throw new JobError(`Only videos can be cut out (${asset.name} is not one)`)
    const share = (f: number) => ctx.progress((index + Math.max(0, Math.min(1, f))) / assets.length)
    const seconds = asset.durationSeconds ?? 600
    ctx.log(`Cutting out ${asset.name}`)
    const release = await stageAssets(ctx, [asset], (f) => share(f * 0.05))
    try {
      const input = ctx.cache.pathOf(asset.file)
      const matte = join(ctx.scratch, `matte-${index}.mov`)
      const out = join(ctx.scratch, `cutout-${index}.webm`)
      ctx.log(`Finding the ${mode === 'person' ? 'person' : 'subject'} in every frame (Vision)`)
      await runHelper(matteHelper, [input, matte, '--mode', mode, '--max-side', String(MATTE_MAX_SIDE)], (line) => {
        if (typeof line.progress === 'number') share(0.05 + line.progress * 0.7)
      }, { signal: ctx.signal, timeout: mediaTimeout(seconds, 6) })
      checkAborted(ctx.signal)
      ctx.log('Encoding the transparent cut-out')
      share(0.76)
      await mergeCutout(input, matte, out, cutoutSize(asset.width, asset.height), { seconds, signal: ctx.signal })
      share(0.95)
      const name = cutoutName(asset.name)
      const { measured } = await inspectFile(out, name, ctx.signal)
      if (Math.abs((measured.sourceFrames ?? 0) - (asset.sourceFrames ?? 0)) > 1)
        throw new JobError(`The cut-out of ${asset.name} has ${measured.sourceFrames} frames against the recording's ${asset.sourceFrames}`)
      if (!(await hasAlpha(out, ctx.signal))) throw new JobError('The cut-out came out without transparency (FFmpeg needs libvpx-vp9)')
      const sha256 = await fileSha256(out)
      const bytes = (await stat(out)).size
      const made = buildAsset(measured, { sha256, bytes }, { name, provenance: { cutoutOf: asset.id, mode } })
      ctx.log(`Storing ${made.file} (${(bytes / 1024 / 1024).toFixed(1)} MB)`)
      await publishAsset(ctx, made, out)
      cutouts.push({ assetId: asset.id, cutoutAssetId: made.id, mode, asset: made })
    } finally {
      release()
    }
    share(1)
  }
  ctx.log(`Cut out ${cutouts.length} recording${cutouts.length === 1 ? '' : 's'}`)
  return { cutouts }
}
