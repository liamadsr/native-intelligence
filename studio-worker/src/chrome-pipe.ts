/**
 * The export without Remotion's FFmpeg (STUDIO_COMPOSITOR=off; the desktop app's local runner, which does not carry
 * Remotion's compositor package and its GPL FFmpeg). Remotion still draws every frame (renderFrames, in Chrome); what
 * renderMedia did with its own FFmpeg is done here with ours:
 *
 * - the picture: each frame, as the JPEG Chrome made of it (renderMedia's own default: quality 80), piped in order into
 *   our FFmpeg, made BT.709 by the scaler as renderMedia's override does (render.ts, bt709WithSwscale), encoded with the
 *   machine's encoder (encoders.ts) and labelled as every export is;
 * - the sound: Remotion's own mix, from the layers' WAVs renderFrames writes (remotion-sound.ts), joined to the picture
 *   as AAC at renderMedia's rate (48 kHz, 320 kb/s).
 *
 * A sound Remotion would extract with its own FFmpeg (NeedsCompositor) cannot be made this way: the export fails with
 * that reason, and the person's Studio sends it to the server.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { fenceInputs, run } from './media.ts'
import { toolPath } from './platform.ts'
import { BT709_SWSCALE } from './render.ts'
import { inlineTracks, mergeInline, type AssetsInfo } from './remotion-sound.ts'

type RenderFrames = typeof import('@remotion/renderer').renderFrames
type RenderFramesOptions = Parameters<RenderFrames>[0]
type Common = Pick<RenderFramesOptions, 'browserExecutable' | 'chromiumOptions' | 'puppeteerInstance' | 'timeoutInMilliseconds' | 'logLevel'> & { cancelSignal?: RenderFramesOptions['cancelSignal'] }

/**
 * renderFrames, holding its server (and so the layers' sound files it wrote) until `use` has read them. The public
 * renderFrames closes the server it opened as it returns, and that removes those files; renderMedia keeps them by
 * passing its own server. Here the same, through Remotion's own internals (RenderInternals.prepareServer and
 * internalRenderFrames, with the arguments its public renderFrames gives them: @remotion/renderer 4.0.534, pinned).
 */
export async function framesHeld<T>(o: {
  serveUrl: string; composition: RenderFramesOptions['composition']; inputProps: Record<string, unknown>; common: Common; frameRange: [number, number] | null
  imageFormat: 'none' | 'jpeg'; concurrency: number; onFrameBuffer: ((buffer: Buffer, frame: number) => Promise<void>) | null
}, use: (info: AssetsInfo) => Promise<T>): Promise<T> {
  const { RenderInternals } = await import('@remotion/renderer')
  const { NoReactInternals } = await import('remotion/no-react')
  const internals = RenderInternals as unknown as Record<string, (...args: unknown[]) => Promise<unknown>> & { findRemotionRoot: () => string }
  const logLevel = o.common.logLevel ?? 'warn'
  const server = await internals.prepareServer!({ webpackConfigOrServeUrl: o.serveUrl, port: null, remotionRoot: internals.findRemotionRoot(), offthreadVideoThreads: 1, logLevel,
    indent: false, offthreadVideoCacheSizeInBytes: null, binariesDirectory: null, forceIPv4: false, sampleRate: 48000 }) as { closeServer: (force: boolean) => Promise<unknown> }
  try {
    const serialize = (data: unknown) => NoReactInternals.serializeJSONWithSpecialTypes({ indent: undefined, staticBase: null, data: data as Record<string, unknown> }).serializedString
    const result = await internals.internalRenderFrames!({
      browserExecutable: o.common.browserExecutable ?? null, cancelSignal: o.common.cancelSignal, chromiumOptions: o.common.chromiumOptions ?? {}, composition: o.composition,
      concurrency: o.concurrency, envVariables: {}, everyNthFrame: 1, frameRange: o.frameRange, frames: null, outputFramesInSequence: false, imageFormat: o.imageFormat, indent: false,
      jpegQuality: JPEG_QUALITY, onDownload: null, serializedInputPropsWithCustomSchema: serialize(o.inputProps), serializedResolvedPropsWithCustomSchema: serialize(o.composition.props),
      puppeteerInstance: o.common.puppeteerInstance, muted: false, onBrowserLog: null, onFrameBuffer: o.onFrameBuffer, onFrame: null, remotionSharedMemory: null,
      onFrameUpdate: () => {}, onStart: () => {}, outputDir: null, port: null, scale: 1, logLevel, timeoutInMilliseconds: o.common.timeoutInMilliseconds ?? 30_000,
      webpackBundleOrServeUrl: o.serveUrl, server, offthreadVideoCacheSizeInBytes: null, parallelEncodingEnabled: false, binariesDirectory: null, compositionStart: 0,
      forSeamlessAacConcatenation: false, onBrowserDownload: () => ({ version: null, onProgress: () => undefined }), onArtifact: null, chromeMode: 'headless-shell',
      offthreadVideoThreads: null, imageSequencePattern: null, mediaCacheSizeInBytes: null, onLog: () => undefined, sampleRate: 48000,
    }) as { assetsInfo: AssetsInfo }
    return await use(result.assetsInfo)
  } finally {
    // Removes Remotion's scratch folders (the layers' files with them).
    await server.closeServer(true).catch(() => undefined)
  }
}

/** renderMedia's JPEG quality (its default), so the frames are the ones renderMedia would encode. */
export const JPEG_QUALITY = 80

/** The arguments of our FFmpeg taking Chrome's JPEGs on standard input and writing the picture. Pure. */
export function pipeArgs(fps: number, encoder: string[], out: string): string[] {
  return ['-nostdin', '-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', 'pipe:0',
    // Labelled as every export (and as renderMedia's file is), without the ICC profile Chrome's JPEGs carry (renderMedia's has none).
    '-vf', `${BT709_SWSCALE},format=yuv420p,setsar=1,sidedata=mode=delete:type=ICC_PROFILE,setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709:range=tv`, '-an', ...encoder, '-r', String(fps), '-video_track_timescale', '90000', '-f', 'mp4', out]
}

/**
 * Remotion's mix of frames [a, b] of `composition`'s sound (renderFrames drawing no picture), as a WAV at `out`: the
 * frames' samples, longer when the last piece runs past them (as renderMedia's WAV).
 */
export async function soundFrames(o: { serveUrl: string; composition: RenderFramesOptions['composition']; inputProps: Record<string, unknown>; common: Common; frameRange: [number, number]; out: string }): Promise<number> {
  const perFrame = 48000 / o.composition.fps
  return framesHeld({ ...o, imageFormat: 'none', concurrency: 1, onFrameBuffer: null },
    (info) => mergeInline(inlineTracks(info), (o.frameRange[1] - o.frameRange[0] + 1) * perFrame, o.out))
}

/**
 * The whole video through Chrome and our FFmpeg, written to `out` (an MP4 with its sound when it has one). `frameDrawn`
 * after the first frame, `progress` 0..1 as frames come.
 */
export async function renderThroughPipe(o: {
  serveUrl: string; composition: RenderFramesOptions['composition']; inputProps: Record<string, unknown>; common: Common; concurrency: number
  encoder: string[]; scratch: string; out: string; signal: AbortSignal; progress: (f: number) => void; frameDrawn: () => void
}): Promise<{ sound: boolean }> {
  const { composition: c } = o
  const picture = join(o.scratch, 'pipe-picture.mp4')
  const ff = spawn(toolPath('ffmpeg'), fenceInputs('ffmpeg', pipeArgs(c.fps, o.encoder, picture)), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, signal: o.signal })
  let stderr = ''
  ff.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000) })
  ff.on('error', () => {})
  ff.stdin.on('error', () => {})
  const exited = new Promise<number | null>((r) => ff.once('close', (code) => r(code)))
  // Frames come in any order from several tabs; FFmpeg takes them in order.
  const pending = new Map<number, Buffer>()
  let next = 0, written = 0
  const flush = async () => {
    while (pending.has(next)) {
      const buf = pending.get(next)!
      pending.delete(next)
      next++
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r))
      written++
      if (written === 1) o.frameDrawn()
      o.progress(written / c.durationInFrames)
    }
  }
  try {
    return await framesHeld({ serveUrl: o.serveUrl, composition: c, inputProps: o.inputProps, common: o.common, frameRange: null, imageFormat: 'jpeg', concurrency: o.concurrency,
      onFrameBuffer: async (buffer, frame) => { pending.set(frame, buffer); await flush() } }, async (info) => {
    await flush()
    ff.stdin.end()
    const code = await exited
    if (code !== 0) throw new Error(`ffmpeg failed encoding the picture: ${stderr.trim().split('\n').slice(-2).join(' | ')}`)
    if (written !== c.durationInFrames) throw new Error(`Chrome drew ${written} frames, not ${c.durationInFrames}`)
    const tracks = inlineTracks(info)
    if (tracks.length === 0) {
      await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', picture, '-c', 'copy', '-movflags', '+faststart', o.out], { signal: o.signal, timeout: 600_000 })
      return { sound: false }
    }
    const wav = join(o.scratch, 'pipe-sound.wav')
    await mergeInline(tracks, c.durationInFrames * (48000 / c.fps), wav)
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', picture, '-i', wav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', '-ar', '48000',
      '-movflags', '+faststart', o.out], { signal: o.signal, timeout: Math.max(600_000, (await stat(wav)).size / 100) })
    return { sound: true }
    })
  } finally {
    if (ff.exitCode === null) ff.kill('SIGKILL')
  }
}
