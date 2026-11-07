/**
 * The Codex worker: what the desktop runs instead of the launcher when a job
 * asks for `codex` (`<node> <bundle>/workers/codex.mjs`, the bundle built by
 * ./build.sh). The protocol and the fence are this folder's README; the
 * adapter is lib/codex.ts.
 */
import { pathToFileURL } from 'node:url'
import { codexAdapter } from './lib/codex.js'
import { runWorker } from './lib/run.js'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorker(codexAdapter).catch((err: unknown) => {
    process.stdout.write(`${JSON.stringify({ type: 'fatal', message: err instanceof Error ? err.message : String(err) })}\n`)
    process.exit(1)
  })
}
