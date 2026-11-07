/**
 * Run the cloud browser's driver fixtures (docs/plans/cloud-browser.md, C1)
 * and compare what happened with the desktop's baseline: recorded from the
 * WebKit browser before C5 retired it (desktop-baseline.json, which stays the reference).
 *
 *   # the cloud driver against a Chrome with remote debugging on :9222 (in the sandbox):
 *   npx tsx scripts/cloud-browser/fixtures/run.ts --driver cloud --cdp 9222 --compare scripts/cloud-browser/fixtures/desktop-baseline.json
 *   # cloud only: cross-site frames out of process, and clicks under Chrome's zoom (needs xdotool on :99):
 *   npx tsx scripts/cloud-browser/fixtures/run.ts --checks --cdp 9222
 *   # decision snapshot timing on a heavy page (the fixture, or --url for a real one):
 *   npx tsx scripts/cloud-browser/fixtures/run.ts --driver cloud --cdp 9222 --bench [--runs 15] [--url https://…]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { CloudBrowser } from '@/lib/cloud-browser/cdp/browser'
import type { CloudPage } from '@/lib/cloud-browser/cdp/page'
import { mergeFrameObservations } from '@/lib/browser-agent/frame-observation'
import { CASES, type FixtureCase, type Step } from './cases'
import { cloudDriver, type FixtureDriver, type FixtureTab } from './drivers'
import { HOSTS, startFixtureServer, type Site } from './server'

type Json = Record<string, unknown>
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
const flag = (name: string) => process.argv.includes(`--${name}`)

/** "A:/popup" for http://127.0.0.1:<port>/popup, so records from any port compare. */
function place(url: string, port: number): string {
  for (const [site, host] of Object.entries(HOSTS) as [Site, string][]) {
    const origin = `http://${host}:${port}`
    if (url === origin || url.startsWith(`${origin}/`)) return `${site}:${url.slice(origin.length) || '/'}`
  }
  return url
}

/** The request the task executor would send for `target` (task-executor.ts, the identity it builds). */
function request(observation: Json, target: Json, step: Exclude<Step, { do: 'wait' }>): Json {
  const frames = (observation.frames ?? []) as Json[]
  const frame = typeof target.frame === 'string' ? frames.find(entry => entry.key === target.frame) : undefined
  const identity = frame ? {
    ref: String(target.ref).slice(String(frame.key).length), documentId: frame.documentId, observationId: frame.observationId,
    interactionEpoch: frame.interactionEpoch,
    frame: { path: frame.path, point: target.point, ancestors: (frame.path as number[]).map((_, level) => {
      const entry = level === 0 ? observation : frames.find(other => (other.path as number[]).length === level &&
        (other.path as number[]).every((index, position) => index === (frame.path as number[])[position]))
      return { documentId: entry?.documentId, observationId: entry?.observationId, interactionEpoch: entry?.interactionEpoch }
    }) },
  } : { ref: target.ref, documentId: observation.documentId, observationId: observation.observationId, interactionEpoch: observation.interactionEpoch }
  const operation = { click: 'click', type: 'type', select: 'select' }[step.do]
  return { operation, ...identity, deadline: Date.now() + 10_000,
    ...(step.do === 'click' && step.approved ? { approved: true } : {}),
    ...(step.do === 'type' ? { text: step.text } : {}),
    ...(step.do === 'select' ? { option: step.option } : {}) }
}

async function runCase(driver: FixtureDriver, fixture: FixtureCase, url: (site: Site, path: string) => string,
  log: { site: Site | null; page: string; event: string }[], port: number) {
  log.length = 0
  const tab: FixtureTab = await driver.open(url(fixture.start.site, fixture.start.path))
  try {
    if (fixture.sites) await tab.guard(fixture.sites, 60_000)
    const steps: Json[] = []
    for (const step of fixture.steps) {
      if (step.do === 'wait') { await sleep(step.ms); continue }
      const observation = mergeFrameObservations(await tab.snapshot(), []) as Json
      const elements = (observation.elements ?? []) as Json[]
      const target = elements.find(element => element.name === step.name)
      const described = { do: step.do, name: step.name, ...(step.do === 'click' && step.approved ? { approved: true } : {}),
        ...(target?.frame ? { inFrame: true } : {}) }
      if (!target) { steps.push({ ...described, found: false }); continue }
      const result = await tab.act(request(observation, target, step))
      steps.push({ ...described, found: true, ok: result.ok, code: result.code ?? null })
      await sleep(700)
    }
    const { notices, opened } = await tab.events()
    return { id: fixture.id, steps, url: place(await tab.url(), port), notices, opened: opened.map(entry => place(entry, port)),
      page: log.map(entry => `${entry.site}:${entry.page} ${entry.event}`) }
  } finally {
    await tab.close()
  }
}

/**
 * Cloud only. Whether each cross-site frame of the nested fixture is its own
 * process (an "iframe" target), and whether a click lands with Chrome's own
 * zoom on (as a person's Ctrl+= through the live view sets it; xdotool presses
 * it here, in the sandbox's display).
 */
/** Click the control named `name` as the executor would. */
async function clickByName(page: CloudPage, name: string) {
  const observation = mergeFrameObservations(JSON.parse(await page.decisionSnapshot()), []) as Json
  const target = ((observation.elements ?? []) as Json[]).find(element => element.name === name)
  if (!target) throw new Error(`no control named ${name}`)
  return JSON.parse(await page.taskAction(request(observation, target, { do: 'click', name })))
}

/** A key press in the sandbox's Chrome window, as a person's through the live view (no window manager: focus, then type). */
function pressInChrome(keys: string) {
  const xdotool = (...args: string[]) => execFileSync('xdotool', args, { env: { ...process.env, DISPLAY: ':99' }, timeout: 5000 }).toString().trim()
  xdotool('windowfocus', xdotool('search', '--onlyvisible', '--class', 'google-chrome').split('\n')[0])
  xdotool('key', '--clearmodifiers', keys)
}

async function cloudChecks(endpoint: number, url: (site: Site, path: string) => string, log: { event: string }[]) {
  const browser = await CloudBrowser.connect(endpoint)
  try {
    const page = await browser.openPage()
    await page.navigate(url('A', '/nested'), new AbortController().signal, Date.now() + 15_000)
    await sleep(1000)
    const { targetInfos } = await browser.conn.send<{ targetInfos: { type: string; url: string }[] }>('Target.getTargets')
    const outOfProcess = targetInfos.filter(target => target.type === 'iframe').map(target => target.url.replace(/:\d+\//, ':P/'))

    const zoom = []
    for (const presses of [0, 2, 4]) {
      log.length = 0
      await page.navigate(url('A', '/zoom'), new AbortController().signal, Date.now() + 15_000)
      await browser.conn.send('Target.activateTarget', { targetId: page.targetId })
      for (let i = 0; i < presses; i++) pressInChrome('ctrl+plus')
      await sleep(500)
      const metrics = await browser.conn.send<{ cssVisualViewport: { zoom?: number } }>('Page.getLayoutMetrics', {}, page.sessionId)
      const observation = mergeFrameObservations(JSON.parse(await page.decisionSnapshot()), []) as Json
      const target = ((observation.elements ?? []) as Json[]).find(element => element.name === 'Far')
      const result = target ? JSON.parse(await page.taskAction(request(observation, target, { do: 'click', name: 'Far' }))) : null
      await sleep(500)
      zoom.push({ zoom: metrics.cssVisualViewport.zoom ?? null, ok: result?.ok ?? null, code: result?.code ?? null, page: log.map(entry => entry.event) })
      if (presses) pressInChrome('ctrl+0')
    }
    // A service worker's page: the worker answers before the network, so the guard must bypass it.
    const signal = new AbortController().signal
    log.length = 0
    await page.navigate(url('B', '/sw-home'), signal, Date.now() + 15_000)
    for (let i = 0; i < 40 && !log.some(entry => entry.event === 'sw-ready'); i++) await sleep(100)
    await page.navigate(url('B', '/sw-scope/page'), signal, Date.now() + 15_000)
    await sleep(300)
    const servedUnguarded = log.some(entry => entry.event === 'sw-served')
    log.length = 0
    const notices: unknown[] = []
    const stop = page.onNotice(notice => notices.push(notice))
    await page.navigate(url('A', '/sw-start'), signal, Date.now() + 15_000)
    await page.setGuard(['localhost'], 60_000)
    await clickByName(page, 'Open the worker page')
    await sleep(800)
    const serviceWorker = { servedUnguarded, servedGuarded: log.some(entry => entry.event === 'sw-served'), notices: notices.splice(0), url: page.url.replace(/:\d+\//, ':P/') }
    await page.setGuard([], 0)

    // The back/forward cache: a restore makes no request, so the commit-time backstop must leave it.
    log.length = 0
    await page.navigate(url('A', '/bf-start'), signal, Date.now() + 15_000)
    await clickByName(page, 'Open partner page')
    await sleep(800)
    await page.goBack()
    await sleep(800)
    await page.setGuard(['localhost'], 60_000)
    await page.goForward()
    await sleep(1200)
    const backForward = { page: log.map(entry => entry.event), notices: notices.splice(0), url: page.url.replace(/:\d+\//, ':P/') }
    stop()
    await page.setGuard([], 0)
    await page.close()
    return { outOfProcess, zoom, serviceWorker, backForward }
  } finally {
    browser.close()
  }
}

async function bench(driver: FixtureDriver, url: string, runs: number) {
  const tab = await driver.open(url)
  try {
    const times: number[] = []
    let size = 0
    for (let i = 0; i < runs; i++) {
      const started = performance.now()
      const raw = await tab.snapshot() as Json
      times.push(performance.now() - started)
      size = ((raw.main as Json)?.elements as unknown[] | undefined)?.length ?? 0
      await sleep(200)
    }
    times.sort((a, b) => a - b)
    return { url, runs, elements: size, medianMs: Math.round(times[Math.floor(runs / 2)]), p90Ms: Math.round(times[Math.floor(runs * 0.9)]) }
  } finally {
    await tab.close()
  }
}

/**
 * Where Chrome can't do what WebKit does, and why the difference is safe. Each
 * one is reported as allowed, never silently matched.
 */
const ALLOWED: { id: string; desktop: string; cloud: string; why: string }[] = [
  { id: 'popup', desktop: 'A:/popup open-partner:true:none', cloud: 'A:/popup open-partner:true:window',
    why: 'WebKit lets the app refuse a popup before it exists, so window.open returns null; Chrome creates it first, and the guard ' +
      'closes it before it loads anything. Either way the blocked site never loads and the opener gets the notice.' },
]

function compare(baseline: Json[], results: Json[]): string[] {
  const differences: string[] = []
  for (const expected of baseline) {
    const actual = results.find(result => result.id === expected.id)
    if (!actual) { differences.push(`${expected.id}: not run`); continue }
    for (const allowed of ALLOWED.filter(entry => entry.id === expected.id)) {
      const page = actual.page as string[]
      if (page.includes(allowed.cloud)) {
        page[page.indexOf(allowed.cloud)] = allowed.desktop
        console.log(`${expected.id}: allowed difference: ${allowed.why}`)
      }
    }
    for (const key of ['steps', 'url', 'notices', 'opened', 'page'])
      if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key]))
        differences.push(`${expected.id} ${key}:\n  desktop ${JSON.stringify(expected[key])}\n  cloud   ${JSON.stringify(actual[key])}`)
  }
  return differences
}

async function main() {
  const { server, port, url, log } = await startFixtureServer(Number(arg('port') ?? 0))
  if (flag('checks')) {
    try { console.log(JSON.stringify(await cloudChecks(Number(arg('cdp') ?? 9222), url, log), null, 2)) } finally { server.close() }
    return
  }
  const which = arg('driver')
  const driver = which === 'cloud' ? await cloudDriver(Number(arg('cdp') ?? 9222))
    : (() => { throw new Error('--driver cloud (the desktop baseline is recorded: desktop-baseline.json)') })()
  try {
    if (flag('bench')) {
      console.log(JSON.stringify(await bench(driver, arg('url') ?? url('A', '/heavy'), Number(arg('runs') ?? 15))))
      return
    }
    const only = arg('case')
    const results = []
    for (const fixture of CASES.filter(entry => !only || entry.id === only)) {
      const result = await runCase(driver, fixture, url, log, port)
      console.error(`${fixture.id}: ${JSON.stringify(result.steps)}`)
      results.push(result)
    }
    const record = { driver: driver.name, recordedAt: new Date().toISOString(), cases: results }
    if (arg('out')) writeFileSync(arg('out')!, JSON.stringify(record, null, 2) + '\n')
    const against = arg('compare')
    if (against) {
      const differences = compare((JSON.parse(readFileSync(against, 'utf8')) as { cases: Json[] }).cases, results)
      console.log(differences.length ? differences.join('\n') : `all ${results.length} fixtures match ${against}`)
      process.exitCode = differences.length ? 1 : 0
    } else if (!arg('out')) console.log(JSON.stringify(record, null, 2))
  } finally {
    server.close()
    await driver.close()
  }
}

main().catch(error => { console.error(error); process.exit(1) })
