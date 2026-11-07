/**
 * The live view against a real sandbox (docs/plans/cloud-browser.md, C3): the
 * host's own start script (relay-start.ts) brings up both x11vnc servers and the
 * relay's hub; noVNC in a local headless Chrome connects through the published
 * port as the app's live view does. Checks:
 *   1. a bad token is refused (4401);
 *   2. a view token streams the screen, and the view-only server drops input,
 *      even input the client sends anyway;
 *   3. a control token's clicks and keys reach the cloud page;
 *   4. the thumbnail needs the token, and is a JPEG of the page.
 * Uses a fresh key of its own, never the app's. Needs a test sandbox created
 * from the base snapshot with the hub port published, and the Vercel CLI:
 *   vercel sandbox create --name <test> --snapshot <base> --publish-port 4000 --timeout 30m --non-persistent
 *   node scripts/cloud-browser/build-assets.mjs
 *   npx tsx scripts/cloud-browser/live-check/check.ts --sandbox <test> --hub https://<the 4000 route> [--out <dir>] [--key <pkcs8>]
 * Remove the sandbox afterwards (it holds nothing of anyone's).
 */
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { vercelTeam } from '../../main-checkout'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { CLOUD_BROWSER } from '@/lib/cloud-browser/config'
import { RELAY_START } from '@/lib/cloud-browser/relay-start'
import { sandboxSigningKey, sandboxVerifyKey, signSandboxToken } from '@/lib/cloud-browser/viewer-token'

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const sandbox = arg('sandbox'), out = arg('out') ?? tmpdir()
const hub = arg('hub')?.replace(/\/$/, '') ?? ''
if (!sandbox || !hub) { console.error('usage: check.ts --sandbox <name> --hub https://<route> [--out <dir>] [--key <pkcs8>]'); process.exit(2) }
const project = process.env.PROJECT ?? 'dial8-website'
const team = vercelTeam(project)
const scope = [`--project=${project}`, ...(team ? [`--scope=${team}`] : [])]
const exec = (script: string) => execFileSync('vercel', ['sandbox', 'exec', ...scope, sandbox, '--', 'bash', '-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const copy = (from: string, to: string) => execFileSync('vercel', ['sandbox', 'copy', ...scope, from, `${sandbox}:${to}`], { stdio: 'ignore' })
const results: [string, boolean, string?][] = []
const check = (name: string, ok: boolean, detail?: string) => { results.push([name, ok, detail]); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`) }

async function main() {
  // A key of its own; --key (base64 PKCS#8) keeps the hub up for a demo afterwards.
  const privateKey = arg('key') ? sandboxSigningKey({ CLOUD_BROWSER_SIGNING_KEY: arg('key') })! : generateKeyPairSync('ed25519').privateKey
  const token = (control: boolean) => signSandboxToken({ aud: 'browser-viewer', userId: 'live-check', workspaceId: 'live-check', sandbox: sandbox!, control }, 120_000, privateKey)

  // The sandbox: Chrome, a stand-in origin serving the bundles, then the host's start script.
  exec('mkdir -p /tmp/live-check/origin/cloud-browser')
  for (const f of ['relay.mjs', 'agent_runtime.js']) copy(`public/cloud-browser/${f}`, `/tmp/live-check/origin/cloud-browser/${f}`)
  copy('scripts/cloud-browser/live-check/sandbox-cdp.mjs', '/tmp/live-check/sandbox-cdp.mjs')
  writeFileSync(join(out, 'relay-start.sh'), RELAY_START)
  copy(join(out, 'relay-start.sh'), '/tmp/live-check/relay-start.sh')
  exec(`(setsid bash /opt/cloud-browser/start.sh </dev/null >/tmp/live-check/boot.out 2>&1 &)
    for _ in $(seq 100); do curl -s -m 1 -o /dev/null 127.0.0.1:9222/json/version && break; sleep 0.3; done
    (setsid python3 -m http.server 8080 --bind 127.0.0.1 -d /tmp/live-check/origin </dev/null >/tmp/live-check/origin.log 2>&1 &)
    sleep 1; node /tmp/live-check/sandbox-cdp.mjs open`)
  exec(`(setsid bash /tmp/live-check/relay-start.sh http://127.0.0.1:8080 live-check-${Date.now()} ${CLOUD_BROWSER.relayDir} ${CLOUD_BROWSER.hubPort} ${sandbox} ${sandboxVerifyKey(privateKey)} </dev/null >/tmp/live-check/start.out 2>&1 &)`)
  let healthy = false
  for (let i = 0; i < 40 && !healthy; i++) {
    healthy = await fetch(`${hub}/health`).then(r => r.ok, () => false)
    if (!healthy) await sleep(500)
  }
  check('the hub answers on the published port', healthy)
  if (!healthy) { console.log(exec('cat /tmp/live-check/start.out /tmp/cloud-browser-relay.log 2>&1 | tail -20')); return }
  console.log(exec('pgrep -a x11vnc; pgrep -af relay.mjs').trim())
  // A page in the cloud Chrome can reach any loopback port: the VNC servers must have none.
  const vncTcp = exec("ss -ltnp 2>/dev/null | grep -c x11vnc || true").trim()
  check('the VNC servers listen on no TCP port', vncTcp === '0', `${vncTcp} TCP listeners`)

  // The viewer: the app's noVNC bundle on a local page, in a local headless Chrome.
  const local = createServer((req, res) => {
    if (req.url === '/rfb.mjs') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync('public/cloud-browser/rfb.mjs'))
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><body style="margin:0;background:#111">
<div id="screen" style="width:1280px;height:800px"></div>
<script type="module">
import RFB from '/rfb.mjs'
window.open_ = (url, token) => new Promise(resolve => {
  const result = window.result = { ok: null, connected: false, closed: null }
  const socket = new WebSocket(url)
  socket.onopen = () => socket.send(token)
  socket.onclose = e => { result.closed = e.code; resolve(result) }
  socket.onmessage = event => {
    result.ok = JSON.parse(event.data)
    const rfb = window.rfb = new RFB(document.getElementById('screen'), socket, { shared: true })
    rfb.scaleViewport = true; rfb.resizeSession = false
    rfb.viewOnly = false // the client always sends: the server decides
    rfb.addEventListener('connect', () => { result.connected = true; resolve(result) })
    rfb.addEventListener('disconnect', () => { result.closed = result.closed ?? 'disconnect' })
    socket.send('go')
  }
})
window.pixel = () => {
  const canvas = document.querySelector('#screen canvas')
  if (!canvas) return null
  const [r, g, b] = canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 5, 1, 1).data
  return [r, g, b]
}
</script>`)
  })
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const viewport = { width: 1280, height: 800 }
  const viewerUrl = `${hub.replace(/^http/, 'ws')}/viewer`
  const page = async () => {
    const p = await browser.newPage({ viewport })
    await p.goto(`http://127.0.0.1:${(local.address() as { port: number }).port}/`)
    await p.waitForFunction(() => typeof (window as unknown as { open_?: unknown }).open_ === 'function')
    return p
  }
  const typed = () => JSON.parse(exec('node /tmp/live-check/sandbox-cdp.mjs value')).value as string | null

  try {
    const bad = await page()
    const refused = await bad.evaluate(([url]) => (window as never as { open_: (u: string, t: string) => Promise<{ closed: unknown }> }).open_(url, 'not-a-token'), [viewerUrl])
    check('a bad token is refused', refused.closed === 4401, `close ${refused.closed}`)
    await bad.close()

    const view = await page()
    const watched = await view.evaluate(([url, t]) => (window as never as { open_: (u: string, t: string) => Promise<{ ok: unknown; connected: boolean }> }).open_(url, t), [viewerUrl, token(false)])
    check('a view token connects view-only', watched.connected && JSON.stringify(watched.ok) === '{"ok":true,"control":false}', JSON.stringify(watched))
    const blue = (rgb: number[] | null) => !!rgb && rgb[2] > 150 && rgb[0] < 90
    let pixel: number[] | null = null
    for (let i = 0; i < 20 && !blue(pixel); i++) { await sleep(250); pixel = await view.evaluate(() => (window as never as { pixel: () => number[] | null }).pixel()) }
    check('the screen streams (the check page’s blue)', blue(pixel), JSON.stringify(pixel))
    await view.screenshot({ path: join(out, 'live-view-watching.png') })
    await view.mouse.click(640, 450)
    await view.keyboard.type('nope')
    await sleep(800)
    check('the view-only server drops input the client sends', typed() === '', JSON.stringify(typed()))

    const drive = await page()
    const driving = await drive.evaluate(([url, t]) => (window as never as { open_: (u: string, t: string) => Promise<{ ok: unknown; connected: boolean }> }).open_(url, t), [viewerUrl, token(true)])
    check('a control token connects with input', driving.connected && JSON.stringify(driving.ok) === '{"ok":true,"control":true}', JSON.stringify(driving))
    await sleep(1000)
    await drive.mouse.click(640, 450)
    await sleep(300)
    await drive.keyboard.type('hello from dial8')
    let value: string | null = null
    for (let i = 0; i < 10 && value !== 'hello from dial8'; i++) { await sleep(400); value = typed() }
    check('its clicks and keys reach the cloud page', value === 'hello from dial8', JSON.stringify(value))
    await sleep(800)
    await drive.screenshot({ path: join(out, 'live-view-driving.png') })
    const stillWatching = await view.evaluate(() => (window as never as { result: { closed: unknown } }).result.closed)
    check('the watcher stays connected beside the driver', stillWatching === null, JSON.stringify(stillWatching))

    check('the thumbnail needs the token', (await fetch(`${hub}/thumbnail`)).status === 401)
    const thumb = await fetch(`${hub}/thumbnail`, { headers: { authorization: `Bearer ${token(false)}` } })
    const jpeg = new Uint8Array(await thumb.arrayBuffer())
    writeFileSync(join(out, 'live-view-thumbnail.jpg'), jpeg)
    check('the thumbnail is a JPEG of the page', thumb.status === 200 && thumb.headers.get('content-type') === 'image/jpeg' && jpeg[0] === 0xff && jpeg[1] === 0xd8,
      `${thumb.status} ${jpeg.length} bytes`)
  } finally {
    await browser.close()
    local.close()
  }
  console.log(`screenshots in ${out}`)
}

main().then(() => process.exit(results.every(([, ok]) => ok) && results.length > 0 ? 0 : 1), error => { console.error(error); process.exit(1) })
