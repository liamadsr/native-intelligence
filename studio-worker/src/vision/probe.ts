/**
 * Whether this worker can see (macOS Vision), found once at start and told to
 * the app with every claim and progress report:
 *
 *   cutouts   subject-matte built and answered on a made-up clip, and FFmpeg
 *             merged its matte into a WebM that keeps an alpha channel
 *   faces     face-track and frame-subject built and answered on the same clip
 *
 * The self-test clip is a flat grey square half a second long (no person, no
 * face): it proves the helpers build, start, read video and answer well-formed,
 * not that they find a person. Off macOS, or without a Swift compiler, nothing
 * is built and neither capability is said. The worker asks for `cutout` jobs
 * (media work, heavy) in its media slots and `faces` jobs (quick) in the
 * provider slot as well, so a format's face check never waits behind an export.
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { StudioJobKind } from '../../../web/src/lib/studio/server/job-contract.ts'
import type { WorkerConfig } from '../config.ts'
import { run } from '../media.ts'
import { hasAlpha, mergeCutout } from './cutout.ts'
import { helperBinary, runHelper, swiftCompiler } from './native.ts'

export type VisionCapability = 'cutouts' | 'faces'

/** The Vision job kinds and the capability each needs. */
export const VISION_KINDS: Partial<Record<StudioJobKind, VisionCapability>> = { cutout: 'cutouts', faces: 'faces' }

/** What the start-up check found: what holds, and why the rest does not. */
export type VisionState = { on: ReadonlySet<VisionCapability>; reason: string | null }

let state: VisionState = { on: new Set(), reason: 'not checked yet' }

/** What the worker found at start. */
export const visionState = (): VisionState => state

/** The capabilities told to the app. */
export const visionCapabilityList = (): string[] => [...state.on]

/**
 * The kinds a slot may ask for, Vision's included: `cutout` and `faces` only
 * while their capability holds, and the provider slot also takes `faces` (when
 * this worker takes it at all). Pure.
 */
export function withVision(slot: 'media' | 'provider', kinds: readonly StudioJobKind[], configured: readonly StudioJobKind[], on: ReadonlySet<VisionCapability>): StudioJobKind[] {
  const out = kinds.filter((k) => !VISION_KINDS[k] || on.has(VISION_KINDS[k]!))
  if (slot === 'provider' && on.has('faces') && configured.includes('faces') && !out.includes('faces')) out.push('faces')
  return out
}

/** Run a helper and keep its lines. */
async function lines(binary: string, args: string[]): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  await runHelper(binary, args, (line) => out.push(line), { timeout: 120_000 })
  return out
}

/**
 * Build the helpers and run each once on a made-up clip, in the work folder.
 * Sets the state the worker reports; never throws. `platform` is for tests.
 */
export async function probeVision(config: Pick<WorkerConfig, 'workDir'>, opts: { platform?: NodeJS.Platform } = {}): Promise<VisionState> {
  const on = new Set<VisionCapability>()
  const problems: string[] = []
  const swiftc = await swiftCompiler(opts.platform)
  if (!swiftc) {
    state = { on, reason: (opts.platform ?? process.platform) === 'darwin' ? 'no Swift compiler answers (install the Xcode command-line tools)' : 'macOS Vision runs only on a Mac' }
    return state
  }
  const dir = join(config.workDir, 'native', 'self-test')
  try {
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const clip = join(dir, 'clip.mp4')
    const frame = join(dir, 'frame.png')
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=128x128:r=10:d=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip], { timeout: 60_000 })
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', clip, '-frames:v', '1', frame], { timeout: 60_000 })

    try {
      const track = await lines(await helperBinary(config.workDir, 'face-track', swiftc), [clip, '--every', '0.1'])
      const samples = track.filter((l) => typeof l.t === 'number' && Array.isArray(l.faces))
      if (!samples.length || !track.some((l) => l.done === true)) throw new Error('face-track answered no samples')
      const still = await lines(await helperBinary(config.workDir, 'frame-subject', swiftc), [frame])
      if (!still.some((l) => l.file === frame && Array.isArray(l.faces))) throw new Error('frame-subject answered no frame')
      on.add('faces')
    } catch (err) {
      problems.push(`faces: ${err instanceof Error ? err.message : String(err)}`)
    }

    try {
      const matte = join(dir, 'matte.mov')
      const made = await lines(await helperBinary(config.workDir, 'subject-matte', swiftc), [clip, matte, '--mode', 'person'])
      if (!made.some((l) => l.done === true && typeof l.frames === 'number' && l.frames > 0)) throw new Error('subject-matte made no frames')
      const cut = join(dir, 'cutout.webm')
      await mergeCutout(clip, matte, cut, { w: 128, h: 128 }, { seconds: 1 })
      if (!(await hasAlpha(cut))) throw new Error('FFmpeg wrote the cut-out without an alpha channel (it needs libvpx-vp9)')
      on.add('cutouts')
    } catch (err) {
      problems.push(`cutouts: ${err instanceof Error ? err.message : String(err)}`)
    }
  } catch (err) {
    problems.push(`self-test clip: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
  state = { on, reason: problems.length ? problems.join('; ') : null }
  return state
}
