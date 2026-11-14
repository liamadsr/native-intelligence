/**
 * Conformance of the cloud browser's RUNTIME backend (src/lib/cloud-browser/
 * runtime-browser.ts, the very code the app runs with CLOUD_BROWSER_BACKEND=runtime)
 * against a REAL runtime and the real browser image: the proof the unit tests
 * (a fake client) cannot give. Modelled on agents/coding-agent/scripts/runtime-conformance.mts.
 *
 * It prints one `ok` or `FAIL` line per check (some print what they found:
 * the routing the hub answered to, lifetimes, error names) and exits 1 if any
 * failed (2 if it could not start). Every sandbox it starts is killed before it
 * exits, failures and Ctrl-C included: it names its browsers
 * `browser-local-conformance-<run>-*` and removes exactly those. It never prints
 * the key, and never the relay token it writes.
 *
 * HOW TO RUN, from the `web` folder of a checkout whose dependencies are
 * installed (`npm ci`: it needs `tsx` and `e2b`), on a machine that reaches the
 * runtime (the app's server, over the tunnel), once the image is built:
 *
 *   SANDBOX_RUNTIME_API_URL=http://<runtime tunnel address>:3000 \
 *   SANDBOX_RUNTIME_TRAFFIC_URL=http://<runtime tunnel address>:3002 \
 *   CLOUD_BROWSER_RUNTIME_TEMPLATE=ni-cloud-browser \
 *   SANDBOX_RUNTIME_KEY="$(<a command that prints the key from a root-only file>)" \
 *   npx tsx scripts/cloud-browser/runtime-conformance.mts
 *
 * Optional: CONFORMANCE_RELAY_ORIGIN (default https://example.com), the host
 * the `mac` policy leaves open (a stand-in for the relay host), and
 * CONFORMANCE_BLOCKED_URL (default https://github.com), a public site it must
 * close, and CONFORMANCE_PUBLIC_NAME (default www.wikipedia.org), a name that
 * must resolve again in `cloud` mode. It takes about five minutes (one wait is 70 s on purpose).
 *
 * The key is the runtime's own (`E2B_API_KEY` in the sandbox server's
 * /opt/e2b/sdk.env): bring it into the environment without showing it, never
 * by pasting it onto a command line that is echoed or kept in a history.
 *
 * It also prints what list, getInfo and the traffic port say during a pause
 * and a resume, and checks that traffic never wakes a paused sandbox: the
 * backend's "listed running but silent" handling rests on those answers.
 *
 * What it cannot reproduce: the runtime restarting under a running sandbox
 * (deploy/sandbox/README.md: it "still listed it as running"). It kills one
 * behind the client's back instead and prints what connect and a command say.
 */
import { request as httpRequest } from 'node:http'

// This database's namespace would be the browsers' own: never touch them. The
// browsers here are `local`, and named for this run alone.
delete process.env.NEXT_PUBLIC_SUPABASE_URL
delete process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF
process.env.CLOUD_BROWSER_HUB_DOMAIN ||= 'hub.conformance.invalid'
process.env.CLOUD_BROWSER_BACKEND = 'runtime'

const env = (name: string) => process.env[name]?.trim() ?? ''
const apiUrl = env('SANDBOX_RUNTIME_API_URL')
const trafficUrl = env('SANDBOX_RUNTIME_TRAFFIC_URL').replace(/\/+$/, '')
const key = env('SANDBOX_RUNTIME_KEY')
if (!apiUrl || !trafficUrl || !key) {
  console.error('runtime-conformance: set SANDBOX_RUNTIME_API_URL, SANDBOX_RUNTIME_TRAFFIC_URL and SANDBOX_RUNTIME_KEY (see this file\'s header)')
  process.exit(2)
}
const relayOrigin = env('CONFORMANCE_RELAY_ORIGIN') || 'https://example.com'
const blockedUrl = env('CONFORMANCE_BLOCKED_URL') || 'https://github.com'

// Loaded dynamically: tsx compiles the app's files as CommonJS (the web package
// is not "type": "module"), whose named exports a static ESM import cannot always see.
type Core = typeof import('../../src/lib/cloud-browser/runtime-browser.js')
type Client = typeof import('../../src/lib/cloud-browser/runtime-client.js')
type Config = typeof import('../../src/lib/cloud-browser/config.js')
const { createRuntimeBrowserBackend, METADATA_KIND } = (await import('../../src/lib/cloud-browser/runtime-browser.js')) as Core
const { loadRuntimeBrowserClient } = (await import('../../src/lib/cloud-browser/runtime-client.js')) as Client
const { CLOUD_BROWSER, cloudBrowserRuntimeSettings } = (await import('../../src/lib/cloud-browser/config.js')) as Config

type Backend = ReturnType<Core['createRuntimeBrowserBackend']>
type Handle = Awaited<ReturnType<Backend['getOrCreate']>>['sandbox']
/** What getInfo answers, beyond the narrow interface. */
type FullInfo = { sandboxId: string; metadata: Record<string, string>; state: string; startedAt: Date; endAt?: Date | string
  lifecycle?: { onTimeout?: string; autoResume?: boolean }; sandboxDomain?: string; network?: unknown }

const settings = cloudBrowserRuntimeSettings()
const template = settings.template
const connection = { apiKey: key, apiUrl, sandboxUrl: trafficUrl }

/** Any text this script prints, with the key cut out. */
const scrub = (text: string) => text.split(key).join('[redacted]')
const say = (line: string) => console.log(scrub(line))
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))
const nameOf = (err: unknown) => (err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : typeof err)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let failures = 0
async function check(name: string, fn: () => Promise<string | void>): Promise<boolean> {
  try {
    const detail = await fn()
    say(`ok    ${name}${detail ? ` (${detail})` : ''}`)
    return true
  } catch (err) {
    failures++
    say(`FAIL  ${name}: ${messageOf(err)}`)
    return false
  }
}
function expect(condition: unknown, what: string): asserts condition {
  if (!condition) throw new Error(what)
}

const run = `${Date.now().toString(36)}`
const prefix = `browser-local-conformance-${run}-`
const backend = createRuntimeBrowserBackend({ env: process.env })
const client = await loadRuntimeBrowserClient()
type Api = Awaited<ReturnType<Client['loadRuntimeBrowserClient']>>['Sandbox']
/** The client's own Sandbox class: getInfo answers more than the backend reads. */
const Sandbox = client.Sandbox as unknown as Omit<Api, 'getInfo'> & { getInfo(id: string, o: typeof connection): Promise<FullInfo> }

/** Every sandbox of this run's browsers (by their metadata), or of one of them. */
async function mine(name?: string): Promise<FullInfo[]> {
  const page = Sandbox.list({ ...connection, query: { metadata: { niKind: METADATA_KIND, niNs: 'local', ...(name ? { niName: name } : {}) }, state: ['running', 'paused'] } })
  const out: FullInfo[] = []
  while (page.hasNext) out.push(...(await page.nextItems()) as FullInfo[])
  return out.filter(info => (info.metadata?.niName ?? '').startsWith(prefix))
}
const idOf = async (name: string) => {
  const found = await mine(name)
  expect(found.length === 1, `${found.length} sandboxes for ${name}, not one`)
  return found[0].sandboxId
}
const info = (id: string) => Sandbox.getInfo(id, connection)
const minutesLeft = (i: FullInfo) => (i.endAt ? Math.round((new Date(i.endAt).getTime() - Date.now()) / 60_000) : NaN)

async function cleanup() {
  for (const box of await mine().catch(() => [] as FullInfo[])) {
    try {
      await Sandbox.kill(box.sandboxId, connection)
    } catch (err) {
      failures++
      say(`FAIL  cleanup of ${box.sandboxId}: ${messageOf(err)}`)
    }
  }
}
process.on('SIGINT', () => {
  void cleanup().finally(() => process.exit(130))
})

const signal = () => AbortSignal.timeout(180_000)
const sh = async (h: Handle, script: string) => (await h.exec('bash', ['-c', script], { signal: AbortSignal.timeout(60_000) })).stdout()
/** curl's view of a URL from inside the sandbox: an HTTP status, or "000" when nothing answered. */
const reach = async (h: Handle, url: string, seconds = 5) => (await sh(h, `curl -s -o /dev/null -m ${seconds} -w '%{http_code}' '${url}' || true`)).trim() || '000'
const reached = (code: string) => code !== '000'
/**
 * A name lookup from inside the VM through its own resolv.conf (node's lookup,
 * as the relay does), cut at `seconds`: how long it took, or a throw.
 */
async function lookup(h: Handle, host: string, seconds: number): Promise<number> {
  const t0 = Date.now()
  const out = (await sh(h, `timeout ${seconds} node -e "require('dns').lookup(process.argv[1], (e, a) => { console.log(e ? 'fail ' + e.code : 'ok ' + a); process.exit(e ? 1 : 0) })" '${host}' || echo "fail exit $?"`)).trim()
  expect(out.startsWith('ok '), `looking up ${host}: ${out || 'nothing'}`)
  return Date.now() - t0
}
/** Poll until `want(code)` or `ms` pass: how long it took, or a throw. */
async function within(h: Handle, url: string, want: (code: string) => boolean, ms: number): Promise<number> {
  const t0 = Date.now()
  for (;;) {
    const code = await reach(h, url, 3)
    if (want(code)) return Date.now() - t0
    if (Date.now() - t0 > ms) throw new Error(`still ${code} after ${ms} ms`)
    await sleep(500)
  }
}
const CDP = `curl -s -m 1 -o /dev/null -w '%{http_code}' http://127.0.0.1:9222/json/version`
async function startChrome(h: Handle): Promise<number> {
  const t0 = Date.now()
  await h.exec('rm', ['-f', CLOUD_BROWSER.startFailedFile])
  await h.exec('bash', [CLOUD_BROWSER.startScript], { detached: true })
  while (Date.now() - t0 < CLOUD_BROWSER.startTimeoutMs) {
    const out = await sh(h, `${CDP}; echo; head -1 ${CLOUD_BROWSER.startFailedFile} 2>/dev/null`)
    const [code, failed = ''] = out.split('\n')
    if (code.trim() === '200') return Date.now() - t0
    if (failed.trim()) throw new Error(`start.sh failed: ${failed.trim().slice(0, 200)}`)
    await sleep(CLOUD_BROWSER.startPollMs)
  }
  throw new Error(`Chrome did not answer within ${CLOUD_BROWSER.startTimeoutMs / 1000} s`)
}
/** A browser-level CDP call from inside the VM (node's own WebSocket), printing the result as JSON. */
// ONE line: inside bash's double quotes a JSON string's "\n" stays two characters,
// and node then reads a syntax error and prints nothing (seen on the first real run).
const CDP_CALL = [
  `(async () => {`,
  `const [method, params] = [process.argv[1], JSON.parse(process.argv[2])];`,
  `const { webSocketDebuggerUrl } = await (await fetch('http://127.0.0.1:9222/json/version')).json();`,
  `const ws = new WebSocket(webSocketDebuggerUrl);`,
  `await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject });`,
  `ws.onmessage = event => { const m = JSON.parse(event.data); if (m.id === 1) { console.log(JSON.stringify(m.result ?? m.error)); process.exit(0) } };`,
  `ws.send(JSON.stringify({ id: 1, method, params }));`,
  `setTimeout(() => process.exit(3), 10000)`,
  `})()`,
].join(' ')
const quote = (text: string) => `'${text.split("'").join(`'\\''`)}'`
const cdp = (method: string, params: unknown) => `node -e ${quote(CDP_CALL)} ${quote(method)} ${quote(JSON.stringify(params))}`

/** An HTTP answer from the traffic port, routed the way `headers` say. */
function traffic(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const url = new URL(path, `${trafficUrl}/`)
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET', headers, timeout: 10_000 }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: body.slice(0, 200) }))
    })
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    req.end()
  })
}

async function identity(): Promise<Handle | null> {
  let handle: Handle | null = null
  const name = `${prefix}a`
  await check('create from the template with the browser metadata, and find it by the metadata query', async () => {
    const out = await backend.getOrCreate(name, signal())
    expect(out.created, 'it was not created')
    handle = out.sandbox
    const id = await idOf(name)
    const i = await info(id)
    expect(i.metadata?.niKind === 'cloud-browser' && i.metadata?.niName === name && i.metadata?.niNs === 'local', `metadata ${JSON.stringify(i.metadata)}`)
    expect(handle.hubOrigin() === `https://${id}.${settings.hubDomain}`, `hub ${handle.hubOrigin()}`)
    expect(handle.session().sessionId.startsWith(`${id}.`), 'session id does not name the sandbox')
    return `${id}, template ${template}, ends in ${minutesLeft(i)} min`
  })
  if (!handle) return null
  await check('after the create, /usr/local is root’s alone: nothing in it writable by group or others, the default user cannot write there, and sudo -n fails', async () => {
    const h = handle!
    const open = (await sh(h, `find /usr/local ! -type l \\( -perm /022 -o ! -user root \\) -print 2>&1 | head -5`)).trim()
    expect(open === '', `still open: ${open}`)
    const who = (await sh(h, 'id -un; id -u')).trim().split('\n')
    expect(who[1] !== '0', `commands run as root (${who[0]})`)
    for (const target of ['/usr/local/bin/ni-conformance-probe', '/usr/local/ni-conformance-probe']) {
      const wrote = (await sh(h, `touch ${target} 2>/dev/null && echo wrote || echo refused`)).trim()
      expect(wrote === 'refused', `the default user could write ${target}`)
    }
    const seed = (await sh(h, `printf 'local %s; ' "$(stat -c '%U %a' /usr/local)"; for f in /usr/local/bin/e2b-seed-certs /usr/local/bin/e2b-chrony-source; do printf '%s %s; ' "$f" "$(stat -c '%U %a' "$f" 2>/dev/null || echo absent)"; done`)).trim()
    const sudo = (await sh(h, 'sudo -n true 2>/dev/null && echo sudo-works || echo sudo-refused')).trim()
    expect(sudo === 'sudo-refused', 'sudo -n true succeeded: the default user can become root')
    return `as ${who[0]}; ${seed} ${sudo}`
  })
  await check('the lifetime’s end pauses it (auto-pause accepted) and auto-resume is off', async () => {
    const i = await info(await idOf(name))
    expect(i.lifecycle?.onTimeout === 'pause', `lifecycle ${JSON.stringify(i.lifecycle ?? null)}`)
    expect(i.lifecycle?.autoResume === false, `autoResume ${String(i.lifecycle?.autoResume)}`)
  })
  await check('it takes public traffic (no traffic access token demanded: the edge sends none)', async () => {
    const i = await info(await idOf(name))
    const network = (i.network ?? {}) as { allowPublicTraffic?: boolean }
    expect(network.allowPublicTraffic !== false, `allowPublicTraffic is ${String(network.allowPublicTraffic)}`)
    return `allowPublicTraffic ${String(network.allowPublicTraffic ?? '(unset: the runtime default)')}`
  })
  await check('a new sandbox reaches nothing before its network is set (created with no internet)', async () => {
    const code = await reach(handle!, relayOrigin)
    expect(!reached(code), `it answered HTTP ${code}`)
  })
  await check('two ensures at once for one name end with one sandbox, used by both', async () => {
    const raced = `${prefix}race`
    const [a, b] = await Promise.all([backend.getOrCreate(raced, signal()), backend.getOrCreate(raced, signal())])
    const left = await mine(raced)
    expect(left.length === 1, `${left.length} sandboxes left`)
    expect(a.sandbox.hubOrigin() === b.sandbox.hubOrigin(), 'the two ensures got different sandboxes')
    return `created: ${a.created}/${b.created}`
  })
  return handle
}

async function network(h: Handle) {
  const token = `conformance-token-${run}-${Math.random().toString(36).slice(2)}`
  await check('mac: the relay host only, a public site closed within seconds', async () => {
    await h.setNetwork('mac', relayOrigin, token)
    const closed = await within(h, blockedUrl, code => !reached(code), 10_000)
    const open = await reach(h, relayOrigin)
    expect(reached(open), `the relay host did not answer (${open})`)
    return `${blockedUrl} closed after ${closed} ms, ${new URL(relayOrigin).hostname} HTTP ${open}`
  })
  await check('mac: the relay host’s name is looked up within 2 s through the image’s own resolvers', async () => {
    const ms = await lookup(h, new URL(relayOrigin).hostname, 2)
    const conf = (await sh(h, `grep '^nameserver' /etc/resolv.conf | tr '\n' ' '`)).trim()
    return `${ms} ms (round trip included); ${conf}`
  })
  const privateRefused = async () => {
    for (const url of ['http://169.254.1.1/', 'http://10.0.0.1/', 'http://192.168.0.1/', 'http://172.16.0.1/', 'http://100.64.0.1/']) {
      const code = await reach(h, url, 3)
      expect(!reached(code), `${url} answered HTTP ${code}`)
    }
    // The runtime's own metadata address is answered inside the VM (the guide's
    // "Known gaps": a sandbox can read its own id and a hash of its access token
    // there). Printed, not failed: it is not a way out.
    return `the runtime's metadata address answers HTTP ${await reach(h, 'http://169.254.169.254/', 3)} from inside the VM`
  }
  await check('mac: private and link-local addresses refused', privateRefused)
  const relayHost = new URL(relayOrigin).hostname
  await check('mac: the relay host’s name on ANOTHER public address (domain fronting) is refused', async () => {
    const other = new URL(blockedUrl).hostname
    const ip = (await sh(h, `timeout 3 node -e "require('dns').lookup(process.argv[1], (e, a) => console.log(e ? '' : a))" '${other}' || true`)).trim()
    expect(ip, `could not look up ${other} to get another address`)
    // -k is deliberate: the other address would show its own certificate. What
    // counts is who answered: nothing, or the relay host itself (the runtime's
    // proxy dials the name it reads, whatever address the client aimed at).
    const digest = (extra: string) => sh(h, `curl -sk -m 5 ${extra} https://${relayHost}/ | sha256sum | cut -c1-16; true`).then(out => out.trim())
    const direct = await digest('')
    const fronted = await digest(`--connect-to ${relayHost}:443:${ip}:443`)
    const empty = 'e3b0c44298fc1c14'
    expect(fronted === empty || fronted === direct, `a request for ${relayHost} aimed at ${ip} was answered by something other than ${relayHost}`)
    return fronted === empty ? `${relayHost} aimed at ${ip}: no answer` : `${relayHost} aimed at ${ip}: answered by ${relayHost} itself (the proxy dials the name)`
  })
  await check('mac: what else the runtime lets out (printed: the relay host on other ports, a bare address, the resolvers off port 53)', async () => {
    const probes: [string, string][] = [
      [`http://${relayHost}:80/`, 'relay host :80'],
      [`https://${relayHost}:8443/`, 'relay host :8443'],
      ['https://1.1.1.1/', 'resolver 1.1.1.1 :443'],
      ['https://9.9.9.9/', 'resolver 9.9.9.9 :443'],
      ['https://8.8.8.8/', 'default resolver 8.8.8.8 :443'],
    ]
    const seen: string[] = []
    for (const [url, what] of probes) seen.push(`${what} ${await reach(h, url, 4)}`)
    return seen.join('; ')
  })
  await check('the token file is 0600 in a 0700 directory, and in no process’s command line or environment', async () => {
    const modes = (await sh(h, `stat -c '%a' ${CLOUD_BROWSER.relayTokenDir} ${CLOUD_BROWSER.relayTokenFile}`)).trim().split('\n')
    expect(modes[0] === '700' && modes[1] === '600', `modes ${modes.join(' ')}`)
    // The token is never named here: grep takes it from the file (-f), never from its arguments.
    const found = await sh(h, `for f in /proc/[0-9]*/cmdline /proc/[0-9]*/environ; do tr '\\0' '\\n' < "$f" 2>/dev/null | grep -qF -f ${CLOUD_BROWSER.relayTokenFile} && echo "$f"; done; true`)
    expect(found.trim() === '', `the token is in ${found.trim().split('\n').join(', ')}`)
    const held = (await sh(h, `[ "$(cat ${CLOUD_BROWSER.relayTokenFile})" = '${token}' ] && echo same`)).trim()
    expect(held === 'same', 'the file does not hold the token that was set')
    return `owner ${(await sh(h, `stat -c '%U' ${CLOUD_BROWSER.relayTokenFile}`)).trim()}`
  })
  await check('cloud: the open internet again within seconds', async () => {
    await h.setNetwork('cloud', relayOrigin, `${token}-2`)
    const opened = await within(h, blockedUrl, reached, 10_000)
    return `${blockedUrl} open after ${opened} ms`
  })
  await check('cloud: an arbitrary public name resolves again', async () => {
    const name = env('CONFORMANCE_PUBLIC_NAME') || 'www.wikipedia.org'
    return `${name} in ${await lookup(h, name, 5)} ms`
  })
  await check('cloud: private and link-local addresses still refused', privateRefused)
}

async function browser(name: string, h0: Handle) {
  let h = h0
  await check('start.sh brings Chrome up and CDP answers', async () => `${await startChrome(h)} ms`)
  await check('Chrome still answers 70 s after start.sh was let go (a detached command is not cut at 60 s)', async () => {
    await sleep(70_000)
    expect((await sh(h, CDP)).trim() === '200', 'CDP no longer answers')
  })
  const cookie = { name: 'ni_conformance', value: run, domain: 'example.com', path: '/', expires: Math.floor(Date.now() / 1000) + 86_400 }
  await check('a cookie, stop.sh, pause, wake, start.sh: the cookie is still there (the profile survived)', async () => {
    await sh(h, cdp('Storage.setCookies', { cookies: [cookie] }))
    const before = await sh(h, cdp('Storage.getCookies', {}))
    expect(before.includes('"ni_conformance"') && before.includes(`"${run}"`), `the cookie was never set (Chrome said: ${before.trim().slice(0, 120) || 'nothing'})`)
    await h.exec('bash', [CLOUD_BROWSER.stopScript], { noWake: true, signal: AbortSignal.timeout(CLOUD_BROWSER.closeChromeTimeoutMs) })
    expect((await sh(h, `${CDP} || true`)).trim() !== '200', 'Chrome still answers after stop.sh')
    await h.stop(AbortSignal.timeout(CLOUD_BROWSER.stopTimeoutMs))
    expect((await info(await idOf(name))).state === 'paused', 'not paused after the stop')
    const woken = await backend.getOrCreate(name, signal())
    expect(!woken.created, 'the wake created a new sandbox')
    h = woken.sandbox
    await startChrome(h)
    const cookies = await sh(h, cdp('Storage.getCookies', {}))
    expect(cookies.includes('"ni_conformance"') && cookies.includes(`"${run}"`), 'the cookie is gone')
  })
  await check('pause then connect keeps a file and a running process', async () => {
    await sh(h, `printf here > /tmp/ni-conformance-marker`)
    const pid = (await sh(h, `nohup sleep 900 >/dev/null 2>&1 </dev/null & echo $!`)).trim()
    await h.stop(AbortSignal.timeout(CLOUD_BROWSER.stopTimeoutMs))
    const woken = await backend.getOrCreate(name, signal())
    h = woken.sandbox
    const out = (await sh(h, `cat /tmp/ni-conformance-marker; kill -0 ${pid} 2>/dev/null && echo ' alive'`)).trim()
    expect(out === 'here alive', `after the wake: ${JSON.stringify(out)}`)
    const open = (await sh(h, `find /usr/local ! -type l \\( -perm /022 -o ! -user root \\) -print 2>&1 | head -3`)).trim()
    expect(open === '', `after a pause and a wake /usr/local is open again: ${open}`)
  })
  await check('the lifetime after a wake', async () => {
    const i = await info(await idOf(name))
    expect(i.lifecycle?.onTimeout === 'pause', `after a wake the lifecycle is ${JSON.stringify(i.lifecycle ?? null)}`)
    return `ends in ${minutesLeft(i)} min; startedAt ${new Date(i.startedAt).toISOString()} (asked for ${CLOUD_BROWSER.sessionTimeoutMs / 60_000} min)`
  })
  await check('the hub answers on the traffic address, routed as the client routes (print which form)', async () => {
    const id = await idOf(name)
    await h.exec('node', ['-e', `require('http').createServer((q, s) => s.end(q.url === '/headers' ? JSON.stringify({ xri: q.headers['x-real-ip'] ?? null, xff: q.headers['x-forwarded-for'] ?? null }) : 'ni-hub-' + q.url)).listen(${CLOUD_BROWSER.hubPort}, '0.0.0.0')`], { detached: true })
    await sleep(1_000)
    const byHeader = await traffic('/health', { 'E2b-Sandbox-Id': id, 'E2b-Sandbox-Port': String(CLOUD_BROWSER.hubPort) }).catch((e: unknown) => ({ status: 0, body: messageOf(e) }))
    const domain = (await info(id)).sandboxDomain ?? 'e2b.app'
    const host = `${CLOUD_BROWSER.hubPort}-${id}.${domain}`
    const byHost = await traffic('/health', { host }).catch((e: unknown) => ({ status: 0, body: messageOf(e) }))
    const ok = (r: { status: number; body: string }) => r.status === 200 && r.body === 'ni-hub-/health'
    expect(ok(byHeader) || ok(byHost), `header form: ${byHeader.status} ${byHeader.body}; host form: ${byHost.status} ${byHost.body}`)
    return `header form (E2b-Sandbox-Id, E2b-Sandbox-Port): ${ok(byHeader) ? 'answers' : `${byHeader.status}`}; host form (Host: ${CLOUD_BROWSER.hubPort}-<id>.${domain}): ${ok(byHost) ? 'answers' : `${byHost.status}`}`
  })
  await check('which of X-Real-IP and X-Forwarded-For the traffic port lets through to the hub (the hub reads X-Real-IP here)', async () => {
    const id = await idOf(name)
    const seen = await traffic('/headers', { 'E2b-Sandbox-Id': id, 'E2b-Sandbox-Port': String(CLOUD_BROWSER.hubPort), 'X-Real-IP': '198.51.100.7', 'X-Forwarded-For': '198.51.100.8' })
    const got = JSON.parse(seen.body) as { xri: string | null; xff: string | null }
    expect(got.xri === '198.51.100.7', `X-Real-IP arrived as ${JSON.stringify(got.xri)}`)
    return `X-Real-IP ${JSON.stringify(got.xri)}, X-Forwarded-For ${JSON.stringify(got.xff)}`
  })
}

/** A GET to port 4000 of `id` through the traffic address, routed by header: its status (0: no answer). */
const hubStatus = (id: string) => traffic('/health', { 'E2b-Sandbox-Id': id, 'E2b-Sandbox-Port': String(CLOUD_BROWSER.hubPort) }).then(r => r.status, () => 0)
/** envd's health check of `id` as the reconcile asks it (runtime-browser.ts envdAnswers): its status (0: no answer). */
const envdStatus = (id: string) => traffic('/health', { 'E2b-Sandbox-Id': id, 'E2b-Sandbox-Port': '49983' }).then(r => r.status, () => 0)
const echoServer = (h: Handle) => h.exec('node', ['-e', `require('http').createServer((q, s) => s.end('ni-hub-' + q.url)).listen(${CLOUD_BROWSER.hubPort}, '0.0.0.0')`], { detached: true })

/**
 * What list, getInfo and the traffic port say while a pause and a resume are
 * under way (polled every 100 ms), and whether traffic wakes a paused sandbox.
 * These decide whether the backend's handling of a "listed running but silent"
 * sandbox matches the runtime.
 */
async function transitions() {
  const name = `${prefix}transitions`
  let h: Handle | undefined
  if (!(await check('start a sandbox for the pause and resume observations', async () => {
    h = (await backend.getOrCreate(name, signal())).sandbox
    await echoServer(h)
    await sleep(1_000)
  }))) return
  const id = await idOf(name)
  await check('envd’s health check answers 2xx for a running sandbox (else the reconcile would call every browser silent)', async () => {
    const status = await envdStatus(id)
    expect(status >= 200 && status <= 299, `envd health answered ${status}`)
    return `HTTP ${status}`
  })
  const watch = async (what: string, act: () => Promise<unknown>) => {
    const t0 = Date.now()
    const seen: string[] = []
    let last = ''
    let done = false
    const acting = act().finally(() => { done = true })
    let after = 0
    while (!done || after++ < 20) {
      const [i, listed, status] = await Promise.all([
        info(id).then(x => `${x.state}@${new Date(x.startedAt).getTime()}`, (e: unknown) => nameOf(e)),
        mine(name).then(l => l.map(x => x.state).join('+') || 'absent', (e: unknown) => nameOf(e)),
        hubStatus(id),
      ])
      const now = `getInfo ${i}, list ${listed}, port 4000 ${status}`
      if (now !== last) { seen.push(`${Date.now() - t0} ms: ${now}${done ? ' (call returned)' : ''}`); last = now }
      await sleep(100)
    }
    await acting
    return `${what}: ${seen.join(' | ')}`
  }
  await check('during a pause (printed)', () => watch('pause', () => h!.stop(AbortSignal.timeout(CLOUD_BROWSER.stopTimeoutMs))))
  await check('traffic to a PAUSED sandbox’s port 4000, and the reconcile’s envd health check, never wake it', async () => {
    expect((await info(id)).state === 'paused', 'it is not paused')
    const statuses = [await hubStatus(id), await hubStatus(id), await envdStatus(id)]
    expect(statuses[2] < 200 || statuses[2] > 299, `envd's health check answered ${statuses[2]} for a paused sandbox`)
    await sleep(3_000)
    const after = await info(id)
    expect(after.state === 'paused', `traffic woke it (now ${after.state})`)
    return `port 4000 answered ${statuses[0]}, ${statuses[1]}; envd health ${statuses[2]}, while paused`
  })
  await check('during a resume (printed)', () => watch('resume', async () => { h = (await backend.getOrCreate(name, signal())).sandbox }))
}

async function killedBehindItsBack() {
  const name = `${prefix}killed`
  let h: Handle | undefined
  if (!(await check('start a sandbox to kill behind the client’s back', async () => { h = (await backend.getOrCreate(name, signal())).sandbox }))) return
  const id = await idOf(name)
  await Sandbox.kill(id, connection)
  await check('… connect to it then (print what it says)', async () => {
    const said = await Sandbox.connect(id, connection).then(() => 'connected', (e: unknown) => `${nameOf(e)}: ${messageOf(e).slice(0, 120)}`)
    return said
  })
  await check('… a short command through the old client then (print what it says)', async () => {
    const said = await h!.exec('true', []).then(() => 'it ran', (e: unknown) => `${nameOf(e)}: ${messageOf(e).slice(0, 160)}`)
    return said
  })
  await check('… and the next ensure creates a fresh one', async () => {
    const out = await backend.getOrCreate(name, signal())
    expect(out.created, 'it did not create one')
  })
}

try {
  say(`runtime-conformance (cloud browser): ${apiUrl} (traffic ${trafficUrl}), template ${template}, browsers ${prefix}*`)
  const handle = await identity()
  if (handle) {
    await network(handle)
    await browser(`${prefix}a`, handle)
  }
  await transitions()
  // The pool holds few 4 GiB sandboxes: let go of this run's before the last part.
  await cleanup()
  await killedBehindItsBack()
} catch (err) {
  failures++
  say(`FAIL  the run stopped: ${messageOf(err)}`)
} finally {
  await cleanup()
}
say(failures === 0 ? 'runtime-conformance: every check passed' : `runtime-conformance: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
