/**
 * What a kit, a batch, a brief or a reel can make the worker do, held down: values escaped for where they go and
 * checked against the contract's grammar again, the pages fenced to the job's folder and cut off from every network
 * (the browser part runs when a Chrome headless shell is found: STUDIO_CHROME or node_modules/.remotion), the
 * browser started with a minimal environment, the kit's audio filters and copy rules kept harmless, and the lengths
 * and the disk checked before a frame is drawn. Made-up values throughout.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { browserArgs, browserEnv } from '../src/ads/browser.ts'
import { attr, cssString, family, html, jsString, paint } from '../src/ads/escape.ts'
import { fencedPage, fileForUrl, pageUrl, PAGE_ORIGIN, type FenceLog } from '../src/ads/fence.ts'
import { tokenFor } from '../src/ads/kit.ts'
import { renderMotion, soundFilters } from '../src/ads/motion.ts'
import { cutOnBeat, pullOut, veilOf } from '../src/ads/motion-templates.ts'
import { copyRuleFindings } from '../src/ads/patterns.ts'
import { renderReel } from '../src/ads/reel.ts'
import { needSpace } from '../src/disk.ts'
import { checkedJobKit, fontExtension } from '../src/jobs/ads-static.ts'
import { findChromeIn } from '../src/render.ts'
import { JobError } from '../src/jobs/context.ts'
import { BrandKitSchema } from '../src/engine.ts'

const HOSTILE_FAMILY = "X'}body{background:url(file:///etc/hosts)}"
const kitOf = (over: Record<string, unknown> = {}) =>
  ({ tok: (n: string) => n, fonts: { serif: { family: 'Fixture Serif' }, sans: { family: 'Fixture Sans' } }, kit: { motion: {} }, ...over }) as never

test('values are escaped for the context they go into', () => {
  assert.equal(html(`<img src=x onerror="a">&'`), '&#60;img src=x onerror=&#34;a&#34;&#62;&#38;&#39;')
  assert.equal(attr('a"b'), 'a&#34;b')
  // A CSS string keeps letters, digits, space, - and _; everything else becomes a hex escape.
  assert.equal(cssString('Fixture Serif'), "'Fixture Serif'")
  const css = cssString(HOSTILE_FAMILY)
  assert.ok(!/['"<>{};\\]/.test(css.slice(1, -1).replace(/\\[0-9a-f]+ /g, '')), css)
  assert.ok(!css.slice(1, -1).includes("'") && !css.includes('}'))
  // A JS string can't close its <script> or its quotes.
  const js = jsString('"; fetch("http://example.test"); </script><script>')
  assert.ok(!js.includes('</script') && !js.slice(1, -1).replace(/\\"/g, '').includes('"'), js)
  assert.equal(JSON.parse(js), '"; fetch("http://example.test"); </script><script>')
})

test('font names and paints are held to the contract’s grammar in the worker too', () => {
  assert.equal(family('Fixture Serif'), 'Fixture Serif')
  assert.throws(() => family(HOSTILE_FAMILY))
  assert.throws(() => family('A";alert(1);"'))
  assert.equal(paint('sand'), 'sand')
  assert.throws(() => paint('red;background:url(file:///etc/hosts)'))
  // A veil by preset (the kit's or the default), or written out: checked either way.
  assert.match(veilOf(kitOf(), 'forest'), /^linear-gradient/)
  assert.throws(() => veilOf(kitOf(), 'red" onload="x'))
  assert.throws(() => veilOf(kitOf({ kit: { motion: { veils: { night: 'url(file:///etc/hosts)' } } } }), 'night'))
  // Template code never draws a hostile veil or family.
  const copy = { service: 'Care', ink: 'ink', beats: [{ at: 0, lines: ['Hi'], size: 120, top: 900 }], end: { at: 3, cta: 'Visit' } }
  assert.throws(() => cutOnBeat({ ...copy, veils: [{ css: 'red;x:url(/etc/hosts)' }] }, { secs: 5, fps: 24, kit: kitOf() }))
  const pull = { service: 'Care', panel: 'ground', ink: 'ink', hookInk: 'ink', hook: { lines: ['Hi'], at: [0] }, line: 'Look', word: 'Here.', end: { at: 4, cta: 'Visit' } }
  assert.throws(() => pullOut(pull, { secs: 6, fps: 24, kit: kitOf({ fonts: { serif: { family: HOSTILE_FAMILY }, sans: { family: 'Fixture Sans' } } }) }))
  const ok = pullOut(pull, { secs: 6, fps: 24, kit: kitOf() })
  assert.ok(ok.html.includes(`' + "'Fixture Serif'";`), 'the serif goes into the script as a JS string holding a CSS string')
  // A kit as a job carries it is checked again, its editor families too.
  const kit = BrandKitSchema.parse({ schemaVersion: 1, name: 'Fixture', palette: {}, fonts: { serif: { family: 'Fixture Serif' }, sans: { family: 'Fixture Sans' } } })
  const job = { kit, logos: {}, fonts: { serif: [], sans: [] }, editorFamilies: { serif: 'Fixture Serif', sans: 'Fixture Sans' }, fontNotes: [] } as never
  assert.doesNotThrow(() => checkedJobKit(job))
  assert.throws(() => checkedJobKit({ ...(job as object), kit: { ...kit, fonts: { ...kit.fonts, serif: { ...kit.fonts.serif, family: HOSTILE_FAMILY } } } } as never), JobError)
  assert.throws(() => checkedJobKit({ ...(job as object), editorFamilies: { serif: HOSTILE_FAMILY, sans: 'Fixture Sans' } } as never), JobError)
  assert.equal(fontExtension('brand-kits/p/fonts/a.TTF'), '.ttf')
  assert.equal(fontExtension('x.otf/../../y'), '.otf')
})

test('a colour is only ever a palette token: never a property inherited from Object', () => {
  const kit = { palette: { leaf: '#7FBF8E' }, roles: { ink: 'leaf' } } as never
  assert.equal(tokenFor(kit, 'leaf'), 'leaf')
  assert.equal(tokenFor(kit, 'ink'), 'leaf')
  for (const name of ['constructor', '__proto__', 'toString', 'x;}body{']) assert.throws(() => tokenFor(kit, name), name)
})

test('a kit sound’s audio filters run only when every one is pure', () => {
  assert.equal(soundFilters('highpass=f=120, lowpass=f=9000', 'bed'), 'highpass=f=120,lowpass=f=9000')
  assert.equal(soundFilters(undefined, 'bed'), '')
  for (const af of ['ladspa=file=/tmp/x.so', 'volume=1,amovie=/etc/hosts', 'ametadata=mode=print:file=/tmp/x', 'volume=1[a];[a]anull', 'arnndn=m=/tmp/m']) assert.throws(() => soundFilters(af, 'bed'), af)
})

test('a copy rule that backtracks without end is stopped and named, never waited on', () => {
  const started = Date.now()
  const found = copyRuleFindings([{ pattern: '(a+)+$', rule: 'VOICE-9', why: 'slow' }, { pattern: '\\bmiracle\\b', rule: 'VOICE-3', why: 'a promise' }], `${'a'.repeat(40)}! a miracle`)
  assert.ok(Date.now() - started < 3000, 'it returned in time')
  assert.equal(found.length, 2)
  assert.equal(found[0]!.rule, 'VOICE-9')
  assert.match(found[0]!.message, /took too long/)
  assert.deepEqual(found[1], { level: 'error', rule: 'VOICE-3', message: 'a promise: "miracle"' })
})

test('lengths, frame rates and the disk are checked before a frame is drawn', async () => {
  const stub = { kit: { kit: { motion: { rules: {} } } }, browser: null, log: () => undefined, progress: () => undefined, signal: new AbortController().signal, media: new Map(), sounds: new Map(), editorFamilies: { serif: 'S', sans: 'X' }, root: '/nowhere', work: '/nowhere/work', out: '/nowhere/out' }
  await assert.rejects(renderMotion({ ...stub, brief: { id: 'm', template: 'cut-on-beat', seconds: 61, background: [], copy: {} } } as never), /at most 60 s/)
  await assert.rejects(renderMotion({ ...stub, brief: { id: 'm', template: 'cut-on-beat', seconds: 10, fps: 240, background: [], copy: {} } } as never), /60 fps/)
  const reel = (shots: unknown[], extra: Record<string, unknown> = {}) => renderReel({ ...stub, spec: { id: 'r', shots, beats: [], ...extra } } as never)
  await assert.rejects(reel([{ src: 'a', in: 0, out: 85 }], { end: { seconds: 10 } }), /at most 90 s/)
  await assert.rejects(reel([{ src: 'a', in: 0, out: 30, slow: 4 }]), /at most 90 s/)
  await assert.rejects(reel([{ src: 'a', in: 0, out: 5 }], { fps: 1000 }), /60 fps/)
  await assert.rejects(needSpace('/', 2 * 1024 ** 3, async () => 1024 ** 3), /1\.0 GB free; this render needs at least 2 GB/)
  await assert.doesNotReject(needSpace('/', 2 * 1024 ** 3, async () => 3 * 1024 ** 3))
})

test('a page address names a file inside the job’s folder, or nothing', () => {
  const root = '/work/jobs/j1'
  assert.equal(pageUrl(root, '/work/jobs/j1/out/a b.html'), `${PAGE_ORIGIN}/out/a%20b.html`)
  assert.throws(() => pageUrl(root, '/work/cache/x.png'))
  assert.equal(fileForUrl(root, `${PAGE_ORIGIN}/out/a%20b.html`), '/work/jobs/j1/out/a b.html')
  // Dot segments (written plain or as %2e%2e) are resolved by the address itself, never above the folder.
  for (const url of [`${PAGE_ORIGIN}/%2e%2e/j2/out.png`, `${PAGE_ORIGIN}/out/%2e%2e/%2e%2e/x`, `${PAGE_ORIGIN}/../../../etc/hosts`]) {
    const file = fileForUrl(root, url)
    assert.ok(file === null || file.startsWith(`${root}/`), `${url} -> ${file}`)
  }
  for (const url of [
    `${PAGE_ORIGIN}/a%2f..%2f..%2fx`,
    `${PAGE_ORIGIN}/a%5c..%5cx`,
    `${PAGE_ORIGIN}/a%00`,
    `${PAGE_ORIGIN}/`,
    'http://example.test/out/a.html',
    'file:///etc/hosts',
    'http://user:pw@studio-job.invalid/a',
    'data:text/plain,hi',
  ]) assert.equal(fileForUrl(root, url), null, url)
})

test('the browser starts with a minimal environment and no route to any network', () => {
  const env = browserEnv({ PATH: '/usr/bin', HOME: '/home/w', TMPDIR: '/tmp', LANG: 'en_GB.UTF-8', FONTCONFIG_FILE: '/etc/fonts/fonts.conf', XDG_CACHE_HOME: '/tmp/.cache', STUDIO_WORKER_SECRET: 's', STUDIO_APP_URL: 'http://app', ELEVENLABS_API_KEY: 'k', DEEPGRAM_API_KEY: 'k', AWS_SECRET_ACCESS_KEY: 'k' })
  assert.deepEqual(Object.keys(env).sort(), ['FONTCONFIG_FILE', 'HOME', 'LANG', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME'])
  const args = browserArgs('linux')
  assert.ok(args.includes('--proxy-server=socks5://127.0.0.1:9'))
  assert.ok(args.includes('--proxy-bypass-list=<-loopback>'))
  assert.ok(args.includes('--host-resolver-rules=MAP * ~NOTFOUND'))
})

/** A Chrome headless shell on this machine, or null (the browser test is then skipped). */
async function chrome(): Promise<string | null> {
  const set = process.env.STUDIO_CHROME
  if (set && existsSync(set)) return statSync(set).isFile() ? set : findChromeIn(set, 6)
  return findChromeIn(resolve(import.meta.dirname, '../node_modules/.remotion'), 6)
}

test('a fenced page reads its own folder and nothing else: no other file, no file://, no network', async (t) => {
  const exe = await chrome()
  if (!exe) return t.skip('no Chrome headless shell here (set STUDIO_CHROME)')
  const base = await mkdtemp(join(tmpdir(), 'studio-fence-'))
  const root = join(base, 'jobs', 'j1')
  let hits = 0
  const server = createServer((_req, res) => {
    hits++
    res.end('reached')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ executablePath: exe, args: browserArgs(), env: browserEnv() })
  try {
    await mkdir(join(root, 'out'), { recursive: true })
    await mkdir(join(base, 'jobs', 'j2'), { recursive: true })
    await writeFile(join(root, 'out', 'mine.txt'), 'mine')
    await writeFile(join(base, 'jobs', 'j2', 'theirs.txt'), 'theirs')
    await writeFile(join(base, 'secret.env'), 'SECRET=1')
    await symlink(join(base, 'secret.env'), join(root, 'out', 'link.txt'))
    await writeFile(join(root, 'out', 'page.html'), '<!doctype html><html><body>page</body></html>')
    const log: FenceLog = []
    const page = await fencedPage(browser, root, { log })
    await page.addInitScript({ content: 'window.__name = (f) => f;' })
    await page.goto(pageUrl(root, join(root, 'out', 'page.html')))
    const read = await page.evaluate(async ({ port }) => {
      const get = async (url: string) => {
        try {
          const r = await fetch(url)
          return r.ok ? await r.text() : `status ${r.status}`
        } catch {
          return 'refused'
        }
      }
      const img = (src: string) => new Promise<string>((done) => {
        const i = new Image()
        i.onload = () => done('loaded')
        i.onerror = () => done('refused')
        i.src = src
      })
      return {
        mine: await get('/out/mine.txt'),
        theirs: await get('/%2e%2e/j2/theirs.txt'),
        dotdot: await get('/out/../../j2/theirs.txt'),
        link: await get('/out/link.txt'),
        http: await get(`http://127.0.0.1:${port}/x`),
        localhost: await get(`http://localhost:${port}/x`),
        file: await get('file:///etc/hosts'),
        fileImg: await img('file:///etc/hosts'),
        httpImg: await img(`http://127.0.0.1:${port}/y.png`),
        ws: await new Promise<string>((done) => {
          try {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
            ws.onopen = () => done('open')
            ws.onerror = () => done('refused')
            ws.onclose = () => done('refused')
          } catch {
            done('refused')
          }
        }),
      }
    }, { port })
    assert.equal(read.mine, 'mine')
    for (const key of ['theirs', 'dotdot', 'link', 'http', 'localhost', 'file', 'fileImg', 'httpImg', 'ws'] as const) assert.equal(read[key], 'refused', `${key}: ${read[key]}`)
    // A page opened on file:// never happens; and navigating to one is refused too.
    await assert.rejects(page.goto('file:///etc/hosts'))
    assert.equal(hits, 0, 'nothing reached the network')
    assert.ok(log.some((l) => l.served && l.url.endsWith('/out/mine.txt')))
    assert.ok(!log.some((l) => l.served && !/\/out\/(mine\.txt|page\.html)$/.test(l.url)), JSON.stringify(log))
    await page.close()
  } finally {
    await browser.close().catch(() => undefined)
    server.close()
    await rm(base, { recursive: true, force: true })
  }
})
