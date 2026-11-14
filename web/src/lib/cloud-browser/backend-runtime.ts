import 'server-only'
import { createRuntimeBrowserBackend, type RuntimeBackendDeps, type RuntimeCloudBrowserBackend } from './runtime-browser'
import * as store from './store'

/**
 * The `runtime` backend as the app uses it: runtime-browser.ts (where all of
 * it lives, and what its header explains), wired to the row store.
 */
export function createRuntimeBackend(deps: RuntimeBackendDeps = {}): RuntimeCloudBrowserBackend {
  return createRuntimeBrowserBackend({ readSession: ref => store.readSession(ref), ...deps })
}

export { commandLine, firstOf, METADATA_KIND, runtimeNetworkFor, runtimeSessionId, sandboxIdOfSession, shellQuote } from './runtime-browser'
