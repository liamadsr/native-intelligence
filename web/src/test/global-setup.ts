/**
 * Runs once, in vitest's main process, before any test file: apply web/patches
 * to node_modules.
 *
 * The suite tests the dependencies as production runs them, and production
 * runs them patched (deploy/app/Dockerfile: `npm ci`, whose postinstall is
 * patch-package, then `patch-package --error-on-fail`). An install made with
 * `npm ci --ignore-scripts`, as fresh cloud sessions do, skips the postinstall
 * and leaves every patched package unpatched, so the tests of patched
 * behaviour (call-glow-frame-layout.test.tsx: voice-glow's frame rate and
 * layout reads) fail on clean code. patch-package is a no-op on packages
 * already patched (about 0.2 s for all of web/patches), and with
 * --error-on-fail a patch that no longer applies stops the run here, named,
 * instead of surfacing as some test's puzzling failure.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export default function applyPatches(): void {
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const bin = path.join(webRoot, 'node_modules/patch-package/index.js')
  try {
    execFileSync(process.execPath, [bin, '--error-on-fail'], { cwd: webRoot, stdio: 'pipe' })
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer }
    throw new Error(
      `patch-package could not apply web/patches to node_modules:\n${e.stdout ?? ''}${e.stderr ?? ''}`,
    )
  }
}
