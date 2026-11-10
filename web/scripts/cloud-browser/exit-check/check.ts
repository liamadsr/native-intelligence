/**
 * The Mac exit end to end (docs/plans/cloud-browser.md, C4): a test sandbox's
 * Chrome (from the base snapshot: behind the relay's SOCKS proxy) and this
 * Mac's real exit node (desktop/crates/browser-exit, its example
 * binary), through the hub's published port. Checks:
 *   1. with no Mac, the browser leaves from the cloud (cloud mode);
 *   2. this Mac's exit connects with a token naming the hub, and the browser
 *      then shows this Mac's public IP;
 *   3. this Mac's exit refuses its own network (a page at 192.168.1.1 fails);
 *   4. killing the exit makes the browser fail at once, never falling back to
 *      the cloud's address.
 * Uses a fresh key of its own. Needs a test sandbox from the base snapshot
 * with the hub port published, the Vercel CLI, and the desktop repo:
 *   vercel sandbox create --name <test> --snapshot <base> --publish-port 4000 --timeout 30m --non-persistent
 *   node scripts/cloud-browser/build-assets.mjs
 *   npx tsx scripts/cloud-browser/exit-check/check.ts --sandbox <test> --hub https://<the 4000 route> --desktop <desktop folder>
 * Only the check's own pages go through this Mac (checkip, example.com).
 * Remove the sandbox afterwards.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { vercelTeam } from '../../main-checkout'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLOUD_BROWSER } from '@/lib/cloud-browser/config'
import { RELAY_START } from '@/lib/cloud-browser/relay-start'
import { sandboxVerifyKey, signSandboxToken } from '@/lib/cloud-browser/viewer-token'

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const sandbox = arg('sandbox') ?? '', desktop = arg('desktop') ?? ''
const hub = arg('hub')?.replace(/\/$/, '') ?? ''
if (!sandbox || !hub || !desktop) { console.error('usage: check.ts --sandbox <name> --hub https://<route> --desktop <desktop folder>'); process.exit(2) }
const project = process.env.PROJECT ?? 'dial8-website'
const team = vercelTeam(project)
const scope = [`--project=${project}`, ...(team ? [`--scope=${team}`] : [])]
const exec = (script: string) => execFileSync('vercel', ['sandbox', 'exec', ...scope, sandbox, '--', 'bash', '-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const copy = (from: string, to: string) => execFileSync('vercel', ['sandbox', 'copy', ...scope, from, `${sandbox}:${to}`], { stdio: 'ignore' })
const results: boolean[] = []
const check = (name: string, ok: boolean, detail?: string) => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`) }
const probe = (url: string) => JSON.parse(exec(`node /tmp/exit-check/sandbox-probe.mjs '${url}'`).trim().split('\n').at(-1)!) as { title: string; text: string }
const ipIn = (page: { text: string }) => /\b\d{1,3}(?:\.\d{1,3}){3}\b/.exec(page.text)?.[0] ?? null

async function main() {
  const { privateKey } = generateKeyPairSync('ed25519')
  const verifyKey = sandboxVerifyKey(privateKey)
  const out = tmpdir()

  // The sandbox: Chrome, a stand-in origin serving the bundle, then the host's start script with a hub.
  exec('mkdir -p /tmp/exit-check/origin/cloud-browser')
  for (const f of ['relay.mjs', 'agent_runtime.js']) copy(`public/cloud-browser/${f}`, `/tmp/exit-check/origin/cloud-browser/${f}`)
  copy('scripts/cloud-browser/exit-check/sandbox-probe.mjs', '/tmp/exit-check/sandbox-probe.mjs')
  copy('scripts/cloud-browser/exit-check/stand-in-origin.mjs', '/tmp/exit-check/stand-in-origin.mjs')
  writeFileSync(join(out, 'relay-start.sh'), RELAY_START)
  copy(join(out, 'relay-start.sh'), '/tmp/exit-check/relay-start.sh')
  exec(`grep -q proxy-server /opt/cloud-browser/start.sh || { echo "this snapshot's Chrome has no proxy flag"; exit 1; }
    (setsid bash /opt/cloud-browser/start.sh </dev/null >/tmp/exit-check/boot.out 2>&1 &)
    for _ in $(seq 100); do curl -s -m 1 -o /dev/null 127.0.0.1:9222/json/version && break; sleep 0.3; done
    (setsid node /tmp/exit-check/stand-in-origin.mjs 8080 /tmp/exit-check/origin </dev/null >/tmp/exit-check/origin.log 2>&1 &)
    sleep 1
    (setsid bash /tmp/exit-check/relay-start.sh http://127.0.0.1:8080 exit-check-${Date.now()} ${CLOUD_BROWSER.relayDir} ${CLOUD_BROWSER.hubPort} ${sandbox} ${verifyKey} </dev/null >/tmp/exit-check/start.out 2>&1 &)`)
  let healthy = false
  for (let i = 0; i < 40 && !healthy; i++) { healthy = await fetch(`${hub}/health`).then(r => r.ok, () => false); if (!healthy) await sleep(500) }
  check('the hub answers', healthy)
  if (!healthy) { console.log(exec('tail -20 /tmp/exit-check/start.out /tmp/cloud-browser-relay.log 2>&1')); return }

  const sandboxIp = exec('curl -s -m 5 https://checkip.amazonaws.com').trim()
  const macIp = execFileSync('curl', ['-s', '-m', '5', 'https://checkip.amazonaws.com'], { encoding: 'utf8' }).trim()
  console.log(`the sandbox's own IP ${sandboxIp}; this Mac's ${macIp}`)

  const cloud = probe('https://checkip.amazonaws.com/')
  check('with no Mac, the browser leaves from the cloud', ipIn(cloud) === sandboxIp, JSON.stringify(cloud.text.slice(0, 40)))

  // This Mac's exit: the desktop crate's own example, with a token naming the hub.
  const hubHost = new URL(hub).host
  const token = signSandboxToken({ aud: 'browser-exit', userId: 'exit-check', workspaceId: 'exit-check', sandbox, hub: hubHost, deviceId: 'exit-check' }, 30 * 60_000, privateKey)
  const node: ChildProcess = spawn('cargo', ['run', '-q', '--example', 'exit_node', '--', '--url', `wss://${hubHost}/exit`, '--token', token, '--key', verifyKey,
    '--public-ip', macIp],
    { cwd: join(desktop, 'src-tauri/crates/browser-exit'), stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, CARGO_INCREMENTAL: '0' } })
  let nodeLog = ''
  node.stdout!.on('data', chunk => { nodeLog += chunk.toString() })
  for (let i = 0; i < 240 && !nodeLog.includes('Up {'); i++) await sleep(500)
  check('this Mac’s exit connects with a token naming the hub', nodeLog.includes('Up {'), nodeLog.split('\n').find(line => line.startsWith('Up')) ?? nodeLog.slice(-200))
  // The relay follows the tunnel between commands: give it a moment to switch.
  await sleep(1500)
  const home = probe('https://checkip.amazonaws.com/')
  check('through the Mac, sites see this Mac’s IP', ipIn(home) === macIp && macIp !== sandboxIp, JSON.stringify(home.text.slice(0, 40)))
  const example = probe('https://example.com/')
  check('and pages load through it', /Example Domain/i.test(example.title), example.title)
  // A fresh address each run: Chrome remembers a failed host for a while.
  const lanHost = `192.168.${Math.floor(Math.random() * 250) + 1}.1`
  // This Mac's own public address, as the app's server saw it: its router answers there.
  const hairpin = probe(`http://${macIp}/`)
  await sleep(500)
  check('this Mac refuses its own public address', /can.t be reached/i.test(hairpin.text) && nodeLog.includes(`Refused { host: "${macIp}", reason: Blocked }`),
    JSON.stringify(hairpin.text.slice(0, 40)))
  const lan = probe(`http://${lanHost}/`)
  // The probe ran synchronously: let the exit node's output in before reading it.
  await sleep(500)
  check('this Mac refuses its own network', /can.t be reached/i.test(lan.text) && nodeLog.includes(`Refused { host: "${lanHost}", reason: Blocked }`),
    nodeLog.split('\n').find(line => line.includes(lanHost)) ?? JSON.stringify(lan.text.slice(0, 80)))

  node.kill('SIGKILL')
  const started = Date.now()
  await sleep(500)
  const after = probe('https://checkip.amazonaws.com/')
  check('with the Mac gone, the browser fails instead of leaving from the cloud', ipIn(after) !== sandboxIp && ipIn(after) === null,
    `${Math.round((Date.now() - started) / 100) / 10} s: ${JSON.stringify(after.text.slice(0, 60))}`)
  // The relay really switched (the stand-in answers its exit route as the app does): to the cloud at start, to
  // the Mac when it came, and not back to the cloud during the grace after it went.
  const switches = exec('cat /tmp/exit-check/switches.log 2>/dev/null').trim().split('\n').map(line => JSON.parse(line.slice(line.indexOf(' ') + 1)) as { mode: string })
  const modes = switches.map(entry => entry.mode).filter((mode, i, all) => mode !== all[i - 1])
  check('the relay switched to the Mac with it, and held it after the Mac went', modes.join(' → ').startsWith('cloud → mac') && modes.at(-1) === 'mac', modes.join(' → '))
  console.log(nodeLog.split('\n').filter(line => line.startsWith('Opened') || line.startsWith('Refused')).slice(0, 8).join('\n'))
}

main().then(() => process.exit(results.length > 0 && results.every(Boolean) ? 0 : 1), error => { console.error(error); process.exit(1) })
