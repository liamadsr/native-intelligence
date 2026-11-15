/**
 * A render bundle built ahead of time (STUDIO_BUNDLE_DIR): the desktop app ships one, built when the app is released,
 * because the bundler and what it needs are most of the worker's node_modules. The server keeps bundling the engine
 * as it is (render.ts).
 *
 * A bundle says what it was built from in BUNDLE_MANIFEST: the engine's render version (engine/render-version.ts,
 * which the app also checks a local export against) and the Remotion version (a bundle drives the renderer it was
 * built with). One that does not match is refused, never used. It is used from a copy in the work folder: the copy
 * gets the asset cache and the fonts linked into its public folder, which the shipped one (inside the app, read-only)
 * cannot.
 */
import { cp, readdir, readFile, rename, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { removeQuietly, unlinkDir } from './platform.ts'

/** A copy removed: its linked asset cache unlinked first, so removing the copy never reaches into the cache. */
async function dropCopy(path: string): Promise<void> {
  await unlinkDir(join(path, 'public', 'assets')).catch(() => undefined)
  await removeQuietly(path)
}
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const BUNDLE_MANIFEST = 'studio-render.json'

export interface BundleManifest {
  /** engine/render-version.ts's version when it was built. */
  renderVersion: string
  /** @remotion/bundler's version it was built with. */
  remotion: string
  builtAt: string
}

/** Why a bundle's manifest does not fit this runner, or null. Pure. */
export function manifestProblem(m: Partial<BundleManifest> | null, expected: { renderVersion: string | null; remotion: string }): string | null {
  if (!m || typeof m.renderVersion !== 'string' || typeof m.remotion !== 'string') return `the bundle has no ${BUNDLE_MANIFEST}`
  if (m.remotion !== expected.remotion) return `the bundle was built with Remotion ${m.remotion}, this runner has ${expected.remotion}`
  // Fails closed: a runner whose engine has no render version cannot say the bundle is its own.
  if (expected.renderVersion === null) return 'this runner has no render version to hold the bundle to'
  if (m.renderVersion !== expected.renderVersion) return `the bundle is render version ${m.renderVersion}, this runner's engine is ${expected.renderVersion}`
  return null
}

/**
 * The folder to serve a render from: a copy of `dir` in `workDir`, named by the hash of the shipped manifest (a bundle
 * rebuilt under the same render version, or with another Remotion, gets a copy of its own), used only while its own
 * manifest is the shipped one byte for byte; other copies are removed. Throws when the bundle does not fit `expected`.
 */
export async function prebuiltBundle(dir: string, workDir: string, expected: { renderVersion: string | null; remotion: string }): Promise<string> {
  const text = await readFile(join(dir, BUNDLE_MANIFEST), 'utf8').catch(() => null)
  const manifest = text === null ? null : (() => { try { return JSON.parse(text) as Partial<BundleManifest> } catch { return null } })()
  const why = manifestProblem(manifest, expected)
  if (why) throw new Error(`STUDIO_BUNDLE_DIR: ${why}`)
  if (!existsSync(join(dir, 'index.html'))) throw new Error('STUDIO_BUNDLE_DIR: no index.html there')
  const name = `bundle-prebuilt-${createHash('sha256').update(text!).digest('hex').slice(0, 16)}`
  const copy = resolve(workDir, name)
  for (const old of await readdir(workDir).catch(() => [] as string[])) if (/^bundle-prebuilt-/.test(old) && old !== name && !old.startsWith(`${name}.`)) await dropCopy(resolve(workDir, old))
  const copied = await readFile(join(copy, BUNDLE_MANIFEST), 'utf8').catch(() => null)
  if (copied !== text || !existsSync(join(copy, 'index.html'))) {
    const staging = `${copy}.${process.pid}`
    await rm(staging, { recursive: true, force: true })
    await cp(dir, staging, { recursive: true })
    await dropCopy(copy)
    await rename(staging, copy)
  }
  return copy
}
