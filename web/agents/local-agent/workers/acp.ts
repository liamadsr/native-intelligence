/**
 * The one worker entry point the desktop runs instead of the launcher, for
 * every agent in registry.json (`<node> <bundle>/workers/acp.mjs`, built by
 * ./build.sh). The protocol, the fence and the registry are this folder's
 * README.
 *
 * `acp.mjs --mcp-proxy` is the stdio MCP proxy an agent starts when it takes
 * no HTTP MCP server (lib/mcp-proxy.ts), and `acp.mjs --return-logins` is
 * what the desktop runs after sweeping a finished job's processes
 * (lib/run.ts runReturnLogins): the same file, so the bundle stays one.
 */
import { pathToFileURL } from 'node:url'
import { runMcpProxy } from './lib/mcp-proxy.js'
import { runReturnLogins, runWorker } from './lib/run.js'

/** Whatever goes wrong, the desktop gets a `fatal` line with a sentence, never a bare stack trace. */
function fatal(err: unknown): never {
  process.stdout.write(`${JSON.stringify({ type: 'fatal', message: err instanceof Error ? err.message : String(err) })}\n`)
  process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === '--return-logins') process.exit(runReturnLogins())
    ;(process.argv[2] === '--mcp-proxy' ? runMcpProxy() : runWorker()).catch(fatal)
  } catch (err) {
    fatal(err)
  }
}
