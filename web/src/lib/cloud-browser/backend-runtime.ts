import 'server-only'
import { createRuntimeBrowserBackend, type RuntimeBackendDeps, type RuntimeCloudBrowserBackend } from './runtime-browser'
import * as store from './store'

/**
 * The `runtime` backend as the app uses it: runtime-browser.ts (where all of
 * it lives, and what its header explains), wired to the row store.
 */
export function createRuntimeBackend(deps: RuntimeBackendDeps = {}): RuntimeCloudBrowserBackend {
  return createRuntimeBrowserBackend({ readSession: ref => store.readSession(ref), sessionOfName: name => store.sessionOfSandboxName(name), ...deps })
}

export { chooseSandbox, commandLine, firstOf, METADATA_KIND, RUNTIME_TIMING, runtimeNetworkFor, runtimeSessionId, sandboxIdOfSession, shellQuote } from './runtime-browser'
