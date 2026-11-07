/**
 * The cloud browser relay (docs/plans/cloud-browser.md, C2): a process in the
 * person's sandbox that takes their agent's browser commands from the app and
 * runs them on the sandbox's Chrome, one at a time. No model calls here: each
 * step's decision is the app's (/api/browser-relay/commands/[id]/decision).
 *
 * The same process is the sandbox's hub (hub.ts, C3): the live view's gate on
 * the published port, and the computer card's thumbnail; and its Mac exit
 * (exit.ts, C4): Chrome's SOCKS proxy, out through the person's Mac or from
 * the cloud, which the runner pins per task and which follows the Mac's
 * tunnel between commands.
 *
 * Bundled by scripts/cloud-browser/build-assets.mjs into public/cloud-browser/,
 * with the app build it belongs to baked in; the host starts it (host.ts
 * `startRelay`) with the app's origin, and the hub's port, sandbox and the
 * server's public key:
 *   node relay.mjs --origin https://browser-relay.dial8.ai --hub-port 4000 --sandbox <name> --viewer-key <spki>
 * It exits when the app has moved to another build, and the next start fetches
 * the new one.
 */
import { CloudBrowser } from '../cdp/browser'
import { CLOUD_BROWSER } from '../config'
import { RelayClient, RelayRestart } from './client'
import { startExit, type ExitMode } from './exit'
import { exitControl } from './exit-control'
import { startHub } from './hub'
import { runClaimed, type RelayState } from './runner'

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
/** The computer card's preview: small, and cheap to send every few seconds. */
const THUMBNAIL = { maxWidth: 480, quality: 0.6 }
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }))

async function connect(port: number): Promise<CloudBrowser> {
  for (let attempt = 0; ; attempt++) {
    try { return await CloudBrowser.connect(port) } catch (error) {
      if (attempt >= 50) throw error
      await sleep(300)
    }
  }
}

export async function runRelay(options: { origin: string; version: string; cdpPort: number; signal: AbortSignal
  hub?: { port: number; sandbox: string; verifyKey: string }; exitMode?: ExitMode }) {
  const client = new RelayClient(options.origin, options.version)
  const state: RelayState = { browser: await connect(options.cdpPort), client, agentPage: null }
  // Chrome's only way out (`--proxy-server`), so it runs with or without a hub; a Mac can only connect through the hub
  // (its /exit). It starts in the mode the row had (the host passes it), and the controller decides from there.
  const bootMode: ExitMode = options.hub && options.exitMode === 'mac' ? 'mac' : 'cloud'
  const exit = startExit({ sandbox: options.hub?.sandbox ?? '', verifyKey: options.hub?.verifyKey ?? '', socksPort: CLOUD_BROWSER.socksPort,
    refusedHosts: [new URL(options.origin).hostname], mode: bootMode, log })
  state.exit = exitControl({ exit, bootMode, capable: !!options.hub, report: (mode, tunnel) => client.setExit(mode, tunnel) })
  void state.exit.sync()
  // Stopping (a new build's relay is starting) frees the hub's port at once.
  const hub = options.hub ? startHub({ ...options.hub, log, exit,
    vncSockets: { view: CLOUD_BROWSER.vncViewSocket, control: CLOUD_BROWSER.vncControlSocket },
    // A hub that can't listen leaves the live view dark: exit, and the next start brings both back.
    onFatal: () => process.exit(1),
    thumbnail: async () => {
      const shot = state.agentPage && !state.agentPage.closed ? await state.agentPage.screenshot(THUMBNAIL)
        : await state.browser.peek(THUMBNAIL)
      return shot ? Buffer.from(shot, 'base64') : null
    } }) : null
  options.signal.addEventListener('abort', () => { hub?.close(); exit.close(); state.exit?.close() }, { once: true })
  log('relay.started', { version: options.version, hub: !!hub })
  let failures = 0
  while (!options.signal.aborted) {
    let next: { id: string; command: string } | null
    try {
      const polled = await client.next(options.signal)
      next = polled.command
      // The person may have taken the browser over (their session keeps the Mac's address).
      if (polled.driver) state.exit?.setDriver(polled.driver)
      failures = 0
    } catch (error) {
      if (error instanceof RelayRestart) { log('relay.restart', { version: error.version }); break }
      if (options.signal.aborted) break
      failures++
      log('relay.poll_failed', { message: error instanceof Error ? error.message : String(error) })
      await sleep(Math.min(10_000, 500 * 2 ** Math.min(failures, 5)), options.signal)
      continue
    }
    if (!next) continue
    const claimed = await client.claim(next.id).catch(() => null)
    if (!claimed) continue
    const started = Date.now()
    if (claimed.driver) state.exit?.setDriver(claimed.driver)
    state.busy = true
    try {
      await runClaimed(state, claimed.command, claimed.blockedSites, claimed.driver, claimed.siteMemory)
    } catch (error) {
      await client.settle(claimed.command.id, 'failed', null, error instanceof Error ? error.message : 'browser command failed')
    } finally {
      state.busy = false
    }
    log('relay.command', { command: claimed.command.command, ms: Date.now() - started })
  }
  hub?.close()
  exit.close()
  state.browser.close()
}

// Started as a script (the bundle), not imported.
if (process.argv[1]?.endsWith('relay.mjs')) {
  const origin = arg('origin'), version = process.env.CLOUD_BROWSER_RELAY_BUILD ?? arg('version')
  if (!origin || !version) { console.error('relay: --origin is required'); process.exit(2) }
  const controller = new AbortController()
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => controller.abort())
  const hubPort = Number(arg('hub-port')), sandbox = arg('sandbox'), verifyKey = arg('viewer-key')
  runRelay({ origin, version, cdpPort: Number(arg('cdp') ?? 9222), signal: controller.signal, exitMode: arg('exit-mode') === 'mac' ? 'mac' : 'cloud',
    ...(hubPort && sandbox && verifyKey ? { hub: { port: hubPort, sandbox, verifyKey } } : {}) })
    .then(() => process.exit(0), error => { log('relay.crashed', { message: error instanceof Error ? error.message : String(error) }); process.exit(1) })
}
