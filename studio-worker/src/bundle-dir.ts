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
import { cp, readFile, rename, rm } from 'node:fs/promises'
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
  if (expected.renderVersion !== null && m.renderVersion !== expected.renderVersion) return `the bundle is render version ${m.renderVersion}, this runner's engine is ${expected.renderVersion}`
  return null
}

/**
 * The folder to serve a render from: a copy of `dir` in `workDir` (made once per render version), after its manifest
 * was checked against `expected`. Throws when it does not fit.
 */
export async function prebuiltBundle(dir: string, workDir: string, expected: { renderVersion: string | null; remotion: string }): Promise<string> {
  const manifest = await readFile(join(dir, BUNDLE_MANIFEST), 'utf8').then((t) => JSON.parse(t) as Partial<BundleManifest>).catch(() => null)
  const why = manifestProblem(manifest, expected)
  if (why) throw new Error(`STUDIO_BUNDLE_DIR: ${why}`)
  if (!existsSync(join(dir, 'index.html'))) throw new Error('STUDIO_BUNDLE_DIR: no index.html there')
  const safe = manifest!.renderVersion!.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)
  const copy = resolve(workDir, `bundle-prebuilt-${safe}`)
  if (!existsSync(join(copy, 'index.html'))) {
    const staging = `${copy}.${process.pid}`
    await rm(staging, { recursive: true, force: true })
    await cp(dir, staging, { recursive: true })
    await rm(copy, { recursive: true, force: true })
    await rename(staging, copy)
  }
  return copy
}
