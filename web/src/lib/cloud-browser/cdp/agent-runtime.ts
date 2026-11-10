import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The agent runtime the cloud browser injects (docs/plans/cloud-browser.md,
 * C1). It came byte for byte from the desktop's WebKit browser
 * (`src-tauri/src/native/agent_runtime.js` at `commit`); since C5 retired that
 * browser, this copy is the only one. A test checks the file still matches
 * `sha256`, so a change to it is deliberate: update the hash with it.
 */
export const AGENT_RUNTIME_ORIGIN = {
  repo: 'dial8-desktop',
  path: 'src-tauri/src/native/agent_runtime.js',
  commit: '7ce866c32b3edbbc2f0befe811f152d3c60d9046',
  sha256: '53f23c731955e5962b36f319387f20e99d3019e0ea48e26b0c40436ba97f4181',
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
