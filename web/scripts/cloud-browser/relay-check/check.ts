/**
 * The relay end to end against a stand-in app (docs/plans/cloud-browser.md, C2):
 * the bundled relay (public/cloud-browser/relay.mjs) long-polls, claims and runs
 * browser tasks on a real Chrome, asking this script's mock of
 * /api/browser-relay/* for each step's decision (scripted here, where the app
 * asks Jev). Pages are the driver fixtures. Checks:
 *   1. a task types into a cross-site frame and clicks, with real input;
 *   2. a sensitive step raises an approval card and the task stops (approval_requested);
 *   3. the replay with the person's grant takes that one step.
 * Run where Chrome has remote debugging on --cdp (the sandbox, or a local headless Chrome):
 *   node scripts/cloud-browser/build-assets.mjs
 *   npx tsx scripts/cloud-browser/relay-check/check.ts --cdp 9222 --relay public/cloud-browser/relay.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { browserApprovalStep, type BrowserApprovalGrant } from '@/lib/browser-agent/approval-grant'
import { startFixtureServer } from '../fixtures/server'

type Json = Record<string, unknown>
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

interface Script { goal: string; startUrl: string; grant?: BrowserApprovalGrant; steps: ((elements: Json[]) => Json)[] }
const byName = (elements: Json[], name: string) => elements.find(element => element.name === name)?.ref

async function main() {
  const fixtures = await startFixtureServer()
  const queue: { id: string; script: Script }[] = []
  const settled = new Map<string, Json>()
  const approvals: { id: string; summary: string }[] = []
  let claimedScript: Script | null = null
  let step = 0

  const app = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://app')
    const reply = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    // The firewall's stand-in: only the relay's marked requests count.
    if (req.headers['x-ni-relay'] !== '1') return reply(401, { error: 'Unauthorized' })
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) as Json : {}
      const match = /^\/api\/browser-relay\/commands\/([^/]+)\/(claim|decision|settle|approval)$/.exec(url.pathname)
      if (url.pathname === '/api/browser-relay/next') {
        if (url.searchParams.get('v') !== 'dev') return reply(426, { version: 'dev' })
        for (let i = 0; i < 20 && !queue.length; i++) await sleep(100)
        const next = queue[0]
        return reply(200, { command: next ? { id: next.id, command: 'run_task' } : null })
      }
      if (!match) return reply(404, {})
      const [, id, op] = match
      if (op === 'claim') {
        const entry = queue.shift()
        if (!entry || entry.id !== id) return reply(409, { error: 'Command not claimable' })
        claimedScript = entry.script
        step = 0
        const now = Date.now()
        return reply(200, { blockedSites: [], command: { id, command: 'run_task', tab_id: null, workspace_id: 'ws',
          claimed_at: new Date(now).toISOString(), lease_expires_at: new Date(now + 60_000).toISOString(),
          request: { decisionCount: 0, task: { goal: entry.script.goal, startUrl: entry.script.startUrl, goalDriven: true, completion: [] },
            ...(entry.script.grant ? { approvalGrant: entry.script.grant } : {}) } } })
      }
      if (op === 'decision') {
        const elements = ((body.observation as Json)?.elements ?? []) as Json[]
        const decide = claimedScript?.steps[step++]
        const value = decide ? decide(elements) : { operation: 'escalate' }
        return reply(200, { decision: { status: 'accepted', value, inferenceId: `inf-${step}` }, deadline: Date.now() + 40_000, blockedSites: [] })
      }
      if (op === 'approval') {
        approvals.push({ id, summary: String(body.summary) })
        return reply(200, { approvalId: `approval-${approvals.length}` })
      }
      settled.set(id, body)
      return reply(200, { ok: true, settled: true })
    })
  })
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`

  const relay = spawn('node', [arg('relay') ?? 'public/cloud-browser/relay.mjs', '--origin', origin, '--cdp', arg('cdp') ?? '9222'], { stdio: ['ignore', 'pipe', 'inherit'] })
  relay.stdout.on('data', chunk => process.stderr.write(`relay: ${chunk}`))
  const run = async (id: string, script: Script) => {
    queue.push({ id, script })
    for (let i = 0; i < 600 && !settled.has(id); i++) await sleep(100)
    return settled.get(id) ?? { status: 'not settled' }
  }
  const results: Json = {}
  try {
    fixtures.log.length = 0
    const frame = await run('cmd-frame', { goal: 'Book for 4 guests', startUrl: fixtures.url('A', '/cross'), steps: [
      els => ({ operation: 'type', ref: byName(els, 'Guests'), value: '4' }),
      els => ({ operation: 'click', ref: byName(els, 'Book') }),
      () => ({ operation: 'done' }),
    ] })
    results.frame = { settle: frame.status, reason: (frame.result as Json)?.reason, steps: (frame.result as Json)?.steps, page: fixtures.log.map(e => e.event) }

    fixtures.log.length = 0
    const order = (els: Json[]) => ({ operation: 'click', ref: byName(els, 'Place order') })
    const held = await run('cmd-held', { goal: 'Place the order', startUrl: fixtures.url('A', '/sensitive'), steps: [order] })
    results.held = { settle: held.status, reason: (held.result as Json)?.reason, approvalId: (held.result as Json)?.approvalId, page: fixtures.log.map(e => e.event) }

    fixtures.log.length = 0
    const step = approvals[0] ? browserApprovalStep(approvals[0].summary) : null
    const replay = step ? await run('cmd-replay', { goal: 'Place the order', startUrl: fixtures.url('A', '/sensitive'),
      grant: { approval_id: 'approval-1', ...step }, steps: [order, () => ({ operation: 'done' })] }) : { status: 'no approval was asked' }
    results.replay = { settle: replay.status, reason: (replay.result as Json)?.reason, page: fixtures.log.map(e => e.event) }
  } finally {
    relay.kill('SIGTERM')
    app.close()
    fixtures.server.close()
  }
  console.log(JSON.stringify(results, null, 2))
  const frame = results.frame as Json, held = results.held as Json, replay = results.replay as Json
  const ok = (frame.page as string[]).includes('book:true:4') && held.reason === 'approval_requested' && (held.page as string[]).length === 0 &&
    (replay.page as string[]).includes('order:true')
  console.log(ok ? 'relay check: all three pass' : 'relay check: FAILED')
  process.exitCode = ok ? 0 : 1
}

main().catch(error => { console.error(error); process.exit(1) })
