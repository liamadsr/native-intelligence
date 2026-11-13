/**
 * Remotion: the engine's composition (web/src/lib/studio/engine/remotion.tsx,
 * composition `EditorVideo`, props `{project, fonts}`) bundled once per process
 * and reused for every render while the engine's files are unchanged, and the
 * Chrome headless shell it renders in.
 *
 * Bundling takes 20 to 40 s, so the bundle is kept in the work folder under a key
 * made from the engine files' names, sizes and mtimes (a restarted worker finds
 * it again). Its public folder holds one thing: `assets`, a link to the asset
 * cache, so `staticFile('assets/<sha256>.<ext>')` in the composition reads the
 * cached file itself and nothing is copied per render. The app's preview loads
 * the same paths by URL.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import type { EditorProject } from '../../web/src/lib/studio/engine/contracts.ts'
import type { WorkerConfig } from './config.ts'
import { buildSceneRuntime, RUNTIME_PATH } from './engine.ts'
import { projectScenes } from './scenes.ts'
import { linkDir, removeQuietly, unlinkDir } from './platform.ts'
import { prebuiltBundle } from './bundle-dir.ts'

/**
 * The engine's render version (web/src/lib/studio/engine/render-version.ts), which a local export and a bundle built
 * ahead are held to; null while the engine has none.
 */
export function engineRenderVersion(): string | null {
  try {
    const m = createRequire(import.meta.url)('../../web/src/lib/studio/engine/render-version.ts') as Record<string, unknown>
    const v = m.RENDER_VERSION ?? m.STUDIO_RENDER_VERSION ?? m.renderVersion
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

export const COMPOSITION_ID = 'EditorVideo'
const ENGINE_FILE = /\.(tsx?|css|json)$/

/** The engine's files, as names with size and mtime, in a stable order. */
export async function engineFingerprint(engineDir: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      const path = join(dir, e.name)
      if (e.isDirectory()) await walk(path, `${rel}${e.name}/`)
      else if (ENGINE_FILE.test(e.name)) {
        const s = await stat(path)
        hash.update(`${rel}${e.name}\0${s.size}\0${Math.round(s.mtimeMs)}\n`)
      }
    }
  }
  await walk(engineDir, '')
  // The Remotion version the bundle is made with is part of what it is.
  hash.update(String((createRequire(import.meta.url)('@remotion/bundler/package.json') as { version: string }).version))
  return hash.digest('hex').slice(0, 16)
}

/** The executable inside a folder that holds a Chrome headless shell (as Remotion lays one out), or null. */
export async function findChromeIn(dir: string, depth = 4): Promise<string | null> {
  const names = new Set(['chrome-headless-shell', 'chrome-headless-shell.exe'])
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) if (e.isFile() && names.has(e.name)) return join(dir, e.name)
  if (depth <= 0) return null
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const found = await findChromeIn(join(dir, e.name), depth - 1)
    if (found) return found
  }
  return null
}

export interface RenderedComposition {
  width: number
  height: number
  fps: number
  durationInFrames: number
}

type Log = (line: string) => void

export class Renderer {
  private readonly config: WorkerConfig
  private readonly assetsDir: string
  private bundling: { key: string; promise: Promise<string> } | null = null
  private browser: Promise<string | null> | null = null
  /** Bundles a render is using now (so a newer bundle does not delete them under it). */
  private readonly inUse = new Map<string, number>()
  /** Software compositing failed once (withGlFallback): every later render in this process asks for `swangle`. */
  private glFellBack = false

  private readonly platform: NodeJS.Platform

  /** `platform`: the system Chrome runs on (a test's stand-in; glFor). */
  constructor(config: WorkerConfig, assetsDir: string, platform: NodeJS.Platform = process.platform) {
    this.config = config
    this.assetsDir = assetsDir
    this.platform = platform
  }

  /** The Chrome to render in: STUDIO_CHROME when set (a file, or a folder it is inside), else Remotion's own, fetched once. */
  chrome(log: Log): Promise<string | null> {
    this.browser ??= (async () => {
      const set = this.config.chrome
      if (set) {
        const s = await stat(set).catch(() => null)
        if (s?.isFile()) return set
        const found = s?.isDirectory() ? await findChromeIn(set) : null
        if (found) return found
        throw new Error(`STUDIO_CHROME is set but no Chrome headless shell is there (${set})`)
      }
      const { ensureBrowser } = await import('@remotion/renderer')
      log('Making sure Remotion has its Chrome headless shell (a download the first time)')
      await ensureBrowser()
      return null // Remotion finds its own
    })()
    this.browser.catch(() => {
      this.browser = null
    })
    return this.browser
  }

  /** The bundle for the engine as it is now: the one already made, or a new one (one at a time). */
  async bundle(log: Log): Promise<{ serveUrl: string; release: () => void }> {
    const prebuilt = this.config.bundleDir
    const key = prebuilt ? `prebuilt:${prebuilt}` : await engineFingerprint(this.config.engineDir)
    if (!this.bundling || this.bundling.key !== key) {
      const promise = prebuilt ? this.usePrebuilt(prebuilt, log) : this.make(key, log)
      this.bundling = { key, promise }
      promise.catch(() => {
        if (this.bundling?.promise === promise) this.bundling = null
      })
    }
    const serveUrl = await this.bundling.promise
    this.inUse.set(serveUrl, (this.inUse.get(serveUrl) ?? 0) + 1)
    let released = false
    return {
      serveUrl,
      release: () => {
        if (released) return
        released = true
        const left = (this.inUse.get(serveUrl) ?? 1) - 1
        if (left > 0) this.inUse.set(serveUrl, left)
        else this.inUse.delete(serveUrl)
      },
    }
  }

  /** A bundle built ahead (STUDIO_BUNDLE_DIR; bundle-dir.ts), from its copy here, the asset cache linked into it. */
  private async usePrebuilt(dir: string, log: Log): Promise<string> {
    const remotion = (createRequire(import.meta.url)('@remotion/renderer/package.json') as { version: string }).version
    const outDir = await prebuiltBundle(dir, this.config.workDir, { renderVersion: engineRenderVersion(), remotion })
    if (!existsSync(join(outDir, 'public', RUNTIME_PATH))) throw new Error('STUDIO_BUNDLE_DIR: the bundle has no code scene runtime')
    const link = join(outDir, 'public', 'assets')
    await unlinkDir(link)
    await linkDir(this.assetsDir, link)
    log(`Using the render bundle built ahead (${dir})`)
    return outDir
  }

  private async make(key: string, log: Log): Promise<string> {
    const outDir = resolve(this.config.workDir, `bundle-${key}`)
    if (!existsSync(join(outDir, 'index.html'))) {
      const started = Date.now()
      log('Bundling the composition (once per engine version)')
      const staging = resolve(this.config.workDir, `bundling-${key}-${process.pid}`)
      const emptyPublic = resolve(this.config.workDir, 'empty-public')
      await rm(staging, { recursive: true, force: true })
      await mkdir(emptyPublic, { recursive: true })
      const { bundle } = await import('@remotion/bundler')
      await bundle({
        entryPoint: resolve(this.config.engineDir, 'remotion.tsx'),
        publicDir: emptyPublic,
        outDir: staging,
        // Webpack's cache would be written next to node_modules, which is read-only in the container; the bundle itself is kept instead.
        enableCaching: false,
        webpackOverride: (config) => ({
          ...config,
          resolve: { ...config.resolve, extensionAlias: { ...config.resolve?.extensionAlias, '.js': ['.ts', '.tsx', '.js'] } },
        }),
      })
      await rm(outDir, { recursive: true, force: true })
      await rename(staging, outDir)
      log(`Bundled in ${((Date.now() - started) / 1000).toFixed(1)} s`)
    }
    // The code scene frame's runtime (the same script the app serves to the editor), made once per bundle.
    const runtime = join(outDir, 'public', RUNTIME_PATH)
    if (!existsSync(runtime)) {
      const bytes = await buildSceneRuntime(await import('esbuild'), this.config.engineDir, runtime)
      log(`Code scene runtime built (${Math.round(bytes / 1024)} KB)`)
    }
    // The bundle's public folder serves the asset cache as `assets/`.
    const link = join(outDir, 'public', 'assets')
    await mkdir(join(outDir, 'public'), { recursive: true })
    // The link itself, never the cache it points to (on Windows a junction).
    await unlinkDir(link)
    await linkDir(this.assetsDir, link)
    await this.dropOldBundles(outDir)
    return outDir
  }

  private async dropOldBundles(keep: string): Promise<void> {
    for (const name of await readdir(this.config.workDir).catch(() => [] as string[])) {
      const path = resolve(this.config.workDir, name)
      if (!/^bundle-[a-f0-9]{16}$/.test(name) || path === keep || this.inUse.has(path)) continue
      // An old bundle's assets link goes first, so removing the bundle never reaches into the cache.
      await unlinkDir(join(path, 'public', 'assets')).catch(() => undefined)
      await removeQuietly(path)
    }
  }

  /** Options every Remotion call shares, for a render of `project` (glFor, or `swangle` once software compositing failed here). */
  async common(log: Log, project?: EditorProject): Promise<{ browserExecutable: string | null; timeoutInMilliseconds: number; logLevel: 'warn'; chromiumOptions: { gl: GlBackend } }> {
    const gl = glFor(this.platform, project)
    return { browserExecutable: await this.chrome(log), timeoutInMilliseconds: 120_000, logLevel: 'warn', chromiumOptions: { gl: gl === 'swiftshader' && this.glFellBack ? 'swangle' : gl } }
  }

  /**
   * A render (`attempt`, handed the shared options and a callback to call once a frame is drawn) that, should Chrome
   * not start or fail before its first frame with software compositing (glFallbackWanted), is made once more with
   * `swangle`, and every later render of this process starts with `swangle`. The good case pays nothing.
   */
  async withGlFallback<T>(log: Log, project: EditorProject | undefined, aborted: () => boolean,
    attempt: (common: Awaited<ReturnType<Renderer['common']>>, frameDrawn: () => void) => Promise<T>): Promise<T> {
    const common = await this.common(log, project)
    let frames = 0
    try {
      return await attempt(common, () => { frames++ })
    } catch (err) {
      if (!glFallbackWanted(err, { gl: common.chromiumOptions.gl, framesDrawn: frames, aborted: aborted() })) throw err
      this.glFellBack = true
      log(`Chrome failed with software compositing before its first frame (${firstLine(err)}): rendering with swangle (slower) from now on in this worker`)
      return attempt(await this.common(log, project), () => {})
    }
  }
}

const firstLine = (err: unknown) => String((err as Error)?.message ?? err).split('\n')[0]!.slice(0, 200)

/**
 * Whether a render that failed should be made again with `swangle`: only when it asked for software compositing
 * (`swiftshader`), drew no frame, was not cancelled, and failed the way a browser that cannot start or whose GPU
 * process takes it down fails (a launch error, the browser or page gone, a GL or GPU message). A render error of the
 * page itself (a delayRender timeout, a media it cannot read, a scene that throws) is not retried. Pure.
 */
export function glFallbackWanted(err: unknown, at: { gl: GlBackend; framesDrawn: number; aborted: boolean }): boolean {
  if (at.gl !== 'swiftshader' || at.framesDrawn > 0 || at.aborted) return false
  const text = `${(err as Error)?.name ?? ''} ${(err as Error)?.message ?? String(err)}`
  if (/delayRender|cancel|Cannot decode|could not be decoded|Unknown container|Network error|ENOSPC/i.test(text)) return false
  return /Failed to launch the browser|browser process (exited|crashed)|Browser (closed|has disconnected|was closed)|Target closed|Session closed|Page crashed|crashed|Timed out after \d+ ?ms while (trying to connect|waiting for the WS endpoint)|GPU process|gpu_init|viz_main|GL implementation|SwiftShader|ANGLE|\bEGL\b|WebGL/i.test(text)
}

/**
 * How an export is encoded (renderMedia's options).
 * - BT.709 (matrix and primaries; bt709WithSwscale says what the file is labelled): Chrome turns a recording's YUV into RGB as BT.709 (what the preview shows), and Remotion's
 *   default turned that RGB back into YUV as BT.601 with no tag, so players, which read an untagged HD video as BT.709,
 *   showed saturated colours shifted (a recording's green at 216 came out at 183). Measured on a made-up recording:
 *   the export against the recording 30.5 dB before, 46 dB with this.
 * - x264 `veryfast`, not its default `medium`: 35 % less encoder CPU (12 % of a render's), 0.8 dB less against the
 *   recording at the same CRF 18 (46.2 against 47.0 dB, both far past what an eye tells apart), a file 11 % smaller.
 */
export const EXPORT_ENCODING = { codec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p', crf: 18, x264Preset: 'veryfast', colorSpace: 'bt709' } as const

/**
 * Remotion converts each frame to BT.709 with zscale; FFmpeg's own scaler does the same conversion for a third of the
 * CPU (the conversion's cost went from 0.08 to 0.01 CPU-seconds a frame at 2504×1438). For renderMedia's
 * `ffmpegOverride`. What the file then says (H.264 VUI and the MP4's `colr`, read back with ffprobe): primaries BT.709,
 * matrix BT.709, limited range, transfer IEC 61966-2-1 (sRGB). Remotion still passes `-color_trc:v bt709`, but the
 * screenshots arrive labelled sRGB and FFmpeg writes the frames' label; zscale relabelled them BT.709, and Remotion's
 * FFmpeg has no filter that relabels. Every export said sRGB before this too. Should Remotion's arguments change shape,
 * nothing matches and zscale stays: slower, not wrong. Pure.
 */
export const BT709_SWSCALE = 'scale=out_color_matrix=bt709:out_range=tv'
export function bt709WithSwscale({ args }: { type: string; args: string[] }): string[] {
  return args.map((a) => a.replace(/zscale=matrix=709:range=limited[^,]*/, BT709_SWSCALE))
}

export type GlBackend = 'swangle' | 'swiftshader' | null

/**
 * How Chrome draws a render. Off Linux (a Mac): Chrome's own choice, the GPU. On Linux (the container, no GPU):
 * - `swiftshader`, the default: Remotion passes `--use-gl=swiftshader`, a GL Chrome no longer has, so its GPU process
 *   gives up at start ("Requested GL implementation … not found", "Exiting GPU process due to errors during
 *   initialization" in a verbose log) and Chrome composites the page in software, which is its fast path with no GPU.
 *   There is no WebGL then; nothing the engine draws uses it.
 * - `swangle` (SwiftShader behind ANGLE: a GPU emulated on the CPU, so WebGL works) only for a video with code scenes,
 *   whose code is the agent's and might draw with WebGL. It is about four times the CPU per frame: everything Chrome
 *   composites goes through the emulated GPU (measured, deploy/studio/README.md, "Export speed").
 * Pure.
 */
export function glFor(platform: NodeJS.Platform, project?: EditorProject): GlBackend {
  if (platform !== 'linux') return null
  return project && projectScenes(project).length > 0 ? 'swangle' : 'swiftshader'
}

/**
 * The props the composition takes. Fonts are staged per job (fonts.ts) and added by the caller. `codeScenes`:
 * 'run' plays code scenes in their locked frame (their modules staged first, scenes.ts), 'placeholder' draws each
 * as a labelled box without loading its code (a thumbnail, a sound-only render).
 */
export function inputPropsFor(project: EditorProject, codeScenes: 'run' | 'placeholder' = 'run'): Record<string, unknown> {
  return { project, fonts: [], codeScenes }
}

/** What a project uses that this worker does not stage yet (each a sentence), so the job's log says so. */
export function unstagedNeeds(project: EditorProject): string[] {
  const out: string[] = []
  const layers = (project.layers ?? []) as Array<{ style?: { font?: string; scene?: { id: string; name: string; fonts?: string[] } } }>
  const fonts = new Set<string>()
  for (const l of layers) {
    if (l.style?.font) fonts.add(l.style.font)
    for (const f of l.style?.scene?.fonts ?? []) fonts.add(f)
  }
  if (project.captions.enabled) fonts.add(project.captions.font)
  if (fonts.size > 0) out.push(`Fonts are not staged on the studio worker yet: ${[...fonts].join(', ')} render with the fallback stack`)
  return out
}

/** A PNG's size from its header. */
export function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG') throw new Error('Not a PNG')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}
