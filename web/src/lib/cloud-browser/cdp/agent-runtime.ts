import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The agent runtime the cloud browser injects (docs/plans/cloud-browser.md,
 * C1). It came byte for byte from the desktop's WebKit browser
 * (`src-tauri/src/native/agent_runtime.js` at `commit`); since C5 retired that
 * browser, this copy is the only one. A test checks the file still matches
 * `sha256`, so a change to it is deliberate: update the hash with it.
 * Changed here since the copy: a password field says its kind (`secretKind`,
 * browser-agent/sign-in-page.ts), never its value or hints; and `fillField`
 * puts a saved login into one field (browser-agent/sign-in-fill.ts), which is
 * forbidden from then on.
 */
export const AGENT_RUNTIME_ORIGIN = {
  repo: 'dial8-desktop',
  path: 'src-tauri/src/native/agent_runtime.js',
  commit: '7ce866c32b3edbbc2f0befe811f152d3c60d9046',
  sha256: '10af14bd91d86b9df543281c0e287a04a87bf937f5c64c1265a9db010ea490d1',
} as const

/** The isolated world the runtime lives in, the twin of WebKit's ni-agent content world. */
export const AGENT_WORLD = 'ni-agent'

let cached: string | null = null

/** The runtime's text, read from beside this module (a bundle ships the file next to itself). */
export function agentRuntimeSource(): string {
  // A plain path, not new URL('./…', import.meta.url), which bundlers treat as an import of the script.
  cached ??= readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'agent_runtime.js'), 'utf8')
  return cached
}
