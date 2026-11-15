import 'server-only'
import { createRuntimeBrowserBackend, type RuntimeBackendDeps, type RuntimeCloudBrowserBackend } from './runtime-browser'
import * as store from './store'

/**
 * The `runtime` backend as the app uses it: runtime-browser.ts (where all of
 * it lives, and what its header explains), wired to the row store.
 */
export function createRuntimeBackend(deps: RuntimeBackendDeps = {}): RuntimeCloudBrowserBackend {
  return createRuntimeBrowserBackend({
    readSession: ref => store.readSession(ref),
    sessionOfName: name => store.sessionOfSandboxName(name),
    recordSandbox: (name, sandboxId) => store.recordStartingSandbox(name, sandboxId),
    ...deps,
  })
}

export { chooseSandbox, CLOSE_USR_LOCAL, commandLine, USR_LOCAL_CLOSED, firstOf, forgetPrewarmedHubs, HUB_PREWARM_TIMEOUT_MS, METADATA_KIND, RUNTIME_TIMING, runtimeNetworkFor, runtimeSessionId, sandboxIdOfSession, shellQuote } from './runtime-browser'
