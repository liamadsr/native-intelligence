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
import { mkdir, readdir, rename, rm, stat, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import type { EditorProject } from '../../web/src/lib/studio/engine/contracts.ts'
import type { WorkerConfig } from './config.ts'
import { buildSceneRuntime, RUNTIME_PATH } from './engine.ts'
import { projectScenes } from './scenes.ts'

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

  constructor(config: WorkerConfig, assetsDir: string) {
    this.config = config
    this.assetsDir = assetsDir
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
    const key = await engineFingerprint(this.config.engineDir)
    if (!this.bundling || this.bundling.key !== key) {
      const promise = this.make(key, log)
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
    await rm(link, { recursive: true, force: true })
    await symlink(this.assetsDir, link, 'dir')
    await this.dropOldBundles(outDir)
    return outDir
  }

  private async dropOldBundles(keep: string): Promise<void> {
    for (const name of await readdir(this.config.workDir).catch(() => [] as string[])) {
      const path = resolve(this.config.workDir, name)
      if (!/^bundle-[a-f0-9]{16}$/.test(name) || path === keep || this.inUse.has(path)) continue
      await rm(path, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** Options every Remotion call shares, for a render of `project` (glFor). */
  async common(log: Log, project?: EditorProject): Promise<{ browserExecutable: string | null; timeoutInMilliseconds: number; logLevel: 'warn'; chromiumOptions: { gl: GlBackend } }> {
    return { browserExecutable: await this.chrome(log), timeoutInMilliseconds: 120_000, logLevel: 'warn', chromiumOptions: { gl: glFor(process.platform, project) } }
  }
}

/**
 * How an export is encoded (renderMedia's options).
 * - BT.709, tagged as such: Chrome turns a recording's YUV into RGB as BT.709 (what the preview shows), and Remotion's
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
 * `ffmpegOverride`. The file then says BT.709 primaries and matrix, and keeps the sRGB transfer Chrome's screenshots
 * arrive with (what every export said before; zscale would have written BT.709, and Remotion's FFmpeg has no filter to
 * relabel it). Should Remotion's arguments change shape, nothing matches and zscale stays: slower, not wrong. Pure.
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
