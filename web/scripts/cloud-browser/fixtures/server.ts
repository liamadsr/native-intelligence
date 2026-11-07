import { createServer, type Server } from 'node:http'

/**
 * The cloud browser's driver fixtures (docs/plans/cloud-browser.md, C1): small
 * pages that exercise frames, real input, refusals and the navigation guard,
 * served on three loopback sites so frames are cross-site (out-of-process in
 * Chrome): A = 127.0.0.1, B = localhost, C = [::1], one port. Pages report
 * what happened (click handlers and whether the event was trusted) to /log on
 * their own origin, so the result reads the same from WebKit and Chrome.
 * Nothing here leaves the machine.
 */

export type Site = 'A' | 'B' | 'C'
export const HOSTS: Record<Site, string> = { A: '127.0.0.1', B: 'localhost', C: '[::1]' }
export const siteOf = (host: string): Site | null =>
  (Object.entries(HOSTS) as [Site, string][]).find(([, name]) => host.replace(/:\d+$/, '') === name)?.[0] ?? null

export type LogEntry = { site: Site | null; page: string; event: string }

const LOG = `<script>window.log=e=>fetch('/log',{method:'POST',keepalive:true,body:JSON.stringify({page:location.pathname,event:String(e)})})</script>`
const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset=utf-8><title>${title}</title>${LOG}</head><body style="margin:0;font:16px sans-serif">${body}</body></html>`
const frame = (src: string, top: number, height = 140) =>
  `<iframe src="${src}" style="position:absolute;left:20px;top:${top}px;width:420px;height:${height}px;border:0"></iframe>`

/** Every page by path; `url(site, path)` builds the address. */
function pages(url: (site: Site, path: string) => string): Record<string, string> {
  return {
    '/form': page('Form', `<form id=f style="padding:10px"><input id=field aria-label="Guests"> <button type=button id=x>Book</button></form>
      <script>x.addEventListener('click',e=>log('book:'+e.isTrusted+':'+field.value))</script>`),
    '/form-inner': page('Inner form', `<div style="padding:10px"><button type=button id=x>Book inner</button></div>
      <script>x.addEventListener('click',e=>log('inner:'+e.isTrusted))</script>`),
    '/outer': page('Outer', `<p style="margin:4px 10px">Outer frame</p>${frame(url('C', '/form-inner'), 30, 100)}`),
    '/same-origin': page('Same-origin frame', `<h1 style="margin:10px">Same-origin frame</h1>${frame('/form', 80)}`),
    '/cross': page('Cross-site frame', `<h1 style="margin:10px">Cross-site frame</h1>${frame(url('B', '/form'), 80)}`),
    '/nested': page('Nested frames', `<h1 style="margin:10px">Nested frames</h1>${frame(url('B', '/outer'), 80, 200)}`),
    '/shadow': page('Shadow picker', `<h1 style="margin:10px">Pick a day</h1><day-picker></day-picker>
      <script>customElements.define('day-picker',class extends HTMLElement{constructor(){super();const r=this.attachShadow({mode:'open'});
      r.innerHTML='<div style="padding:10px"><button>Day 1</button> <button>Day 2</button></div>';
      r.querySelectorAll('button').forEach(b=>b.addEventListener('click',e=>log('pick:'+b.textContent+':'+e.isTrusted)))}})</script>`),
    '/select': page('Select', `<label style="display:block;margin:10px">Size <select id=s aria-label="Size"><option>Small</option><option>Medium</option><option>Large</option></select></label>
      <script>s.addEventListener('change',()=>log('size:'+s.value))</script>`),
    '/covered': page('Covered', `<button id=help style="position:absolute;left:20px;top:20px">Help</button>
      <button id=go style="position:absolute;left:20px;top:100px">Continue</button>
      <div style="position:absolute;left:0;top:80px;width:400px;height:80px;background:rgba(255,255,255,0.02)"></div>
      <script>go.addEventListener('click',e=>log('continue:'+e.isTrusted));help.addEventListener('click',e=>log('help:'+e.isTrusted))</script>`),
    '/sensitive': page('Checkout', `<form id=f style="padding:10px" onsubmit="event.preventDefault()"><input aria-label="Name on card"> <button type=button id=buy>Place order</button></form>
      <script>buy.addEventListener('click',e=>log('order:'+e.isTrusted))</script>`),
    '/redirect-start': page('Partner links', `<p style="margin:10px"><a id=link href="/redirect">Continue to partner</a></p>
      <p style="margin:10px"><button id=go>Open partner</button></p>
      <script>go.addEventListener('click',()=>{location.href=${JSON.stringify(url('B', '/blocked'))}})</script>`),
    '/blocked': page('Blocked partner', `<p>Partner page</p><script>log('blocked-page-loaded')</script>`),
    '/download': page('Download', `<p style="margin:10px"><a id=dl href="/file.bin">Get the file</a></p>`),
    '/popup': page('Popups', `<p style="margin:10px"><button id=details>Open details</button></p><p style="margin:10px"><button id=partner>Open partner window</button></p>
      <script>details.addEventListener('click',e=>{log('open:'+e.isTrusted+':'+(window.open('/details')?'window':'none'))});
      partner.addEventListener('click',e=>{log('open-partner:'+e.isTrusted+':'+(window.open(${JSON.stringify(url('B', '/blocked'))})?'window':'none'))})</script>`),
    // The guard's two loads without a request it sees (cloud checks): a service worker's page, and the back/forward cache.
    '/sw-home': page('Service worker home', `<p>Registering</p><script>navigator.serviceWorker.register('/sw-scope/sw.js',{scope:'/sw-scope/'})
      .then(()=>navigator.serviceWorker.ready).then(()=>log('sw-ready'))</script>`),
    '/sw-start': page('Service worker link', `<p style="margin:10px"><a id=link href=${JSON.stringify(url('B', '/sw-scope/page'))}>Open the worker page</a></p>`),
    '/bf-start': page('Back-forward start', `<p style="margin:10px"><a id=link href=${JSON.stringify(url('B', '/bf-target'))}>Open partner page</a></p>`),
    '/bf-target': page('Back-forward target', `<p>Partner page</p><script>addEventListener('pageshow',e=>log('pageshow:'+e.persisted))</script>`),
    // Far from the origin, small: a click in the wrong units (zoomed DIP vs CSS px) misses it.
    '/zoom': page('Zoom', `<button id=far style="position:absolute;left:400px;top:250px;width:70px;height:28px">Far</button>
      <script>far.addEventListener('click',e=>log('far:'+e.isTrusted))</script>`),
    '/details': page('Details', `<p>Details</p><script>log('details-loaded')</script>`),
    '/heavy': page('Heavy', Array.from({ length: 1500 }, (_, i) =>
      `<div style="margin:2px 10px"><a href="/details?i=${i}">Result ${i}</a> <button type=button>Save ${i}</button> <span>Item ${i} with some descriptive text to read</span></div>`).join('')),
  }
}

export async function startFixtureServer(port = 0): Promise<{ server: Server; port: number; url: (site: Site, path: string) => string; log: LogEntry[] }> {
  const log: LogEntry[] = []
  let actualPort = port
  const url = (site: Site, path: string) => `http://${HOSTS[site]}:${actualPort}${path}`
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/log' && req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const entry = JSON.parse(body) as { page?: unknown; event?: unknown }
          log.push({ site: siteOf(req.headers.host ?? ''), page: String(entry.page ?? ''), event: String(entry.event ?? '') })
        } catch { /* a malformed report is dropped */ }
        res.writeHead(204, { 'access-control-allow-origin': '*' }).end()
      })
      return
    }
    if (path === '/redirect') { res.writeHead(302, { location: url('B', '/blocked') }).end(); return }
    if (path === '/sw-scope/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(`self.addEventListener('install',()=>self.skipWaiting())
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()))
self.addEventListener('fetch',e=>{if(e.request.mode==='navigate')e.respondWith(new Response('<!doctype html><title>Worker page</title><script>fetch("/log",{method:"POST",keepalive:true,body:JSON.stringify({page:location.pathname,event:"sw-served"})})</script>',{headers:{'content-type':'text/html'}}))})`)
      return
    }
    if (path === '/file.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="file.bin"' })
      res.end(Buffer.alloc(2048))
      return
    }
    const html = pages(url)[path]
    if (!html) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html)
  })
  await new Promise<void>(resolve => server.listen({ port, host: '::', ipv6Only: false }, resolve))
  actualPort = (server.address() as { port: number }).port
  return { server, port: actualPort, url, log }
}
