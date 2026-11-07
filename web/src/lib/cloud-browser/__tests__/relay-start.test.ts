/**
 * The relay's start script (src/lib/cloud-browser/relay-start.ts) as bash
 * reads it: it parses, its VNC servers listen on unix sockets only, and it
 * keeps only a 200 as the relay's code (PROD 2026-10-23: a redirect's
 * "Redirecting..." body was saved as relay.mjs and crashed it). And the
 * host's check reads a running relay as up (PROD 2026-10-23: the build file's
 * own newline shifted the lines, so "up" read as the failure).
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { CLOUD_BROWSER } from '../config'
import { RELAY_START, readRelayProbe, relayProbeScript } from '../relay-start'

describe('the relay start script', () => {
  it('parses', () => {
    expect(() => execFileSync('bash', ['-n', '-c', RELAY_START], { stdio: 'pipe' })).not.toThrow()
  })

  it('runs every VNC server on a unix socket, never a TCP port', () => {
    const servers = RELAY_START.split('\n').filter(line => /^\s*x11vnc /.test(line))
    expect(servers).toHaveLength(2)
    for (const line of servers) expect(line).toMatch(/-unixsock \S+ -rfbport 0 -rfbportv6 0 -noipv6 /)
    expect(servers[0]).toContain(`-unixsock ${CLOUD_BROWSER.vncViewSocket} -rfbport 0 -rfbportv6 0 -noipv6 -viewonly`)
    expect(servers[1]).not.toContain('-viewonly')
    expect(RELAY_START).toContain(`chmod 700 ${CLOUD_BROWSER.vncDir}`)
  })

  it('keeps a downloaded file only when the origin answers 200', async () => {
    const lines = RELAY_START.split('\n')
    const from = lines.findIndex(line => line.startsWith('for f in relay.mjs agent_runtime.js; do'))
    const download = lines.slice(from, lines.indexOf('done', from) + 1).join('\n')
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/cloud-browser/relay.mjs') && process.env.RELAY_TEST_REDIRECT === '1') {
        res.writeHead(307, { location: 'https://dial8.ai/cloud-browser/relay.mjs' }).end('Redirecting...')
      } else res.writeHead(200).end(`// ${req.url}`)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const run = async (redirect: boolean) => {
      process.env.RELAY_TEST_REDIRECT = redirect ? '1' : '0'
      const dir = mkdtempSync(join(tmpdir(), 'relay-start-'))
      await promisify(execFile)('bash', ['-c', `DIR=${dir}; ORIGIN=${origin}; BUILD=b1\n${download}`]).catch(() => null)
      return dir
    }
    try {
      const ok = await run(false)
      expect(readFileSync(join(ok, 'relay.mjs'), 'utf8')).toBe('// /cloud-browser/relay.mjs?b=b1')
      expect(existsSync(join(ok, 'failed'))).toBe(false)
      const redirected = await run(true)
      expect(existsSync(join(redirected, 'relay.mjs'))).toBe(false)
      expect(readFileSync(join(redirected, 'failed'), 'utf8').trim()).toBe('fetch relay.mjs failed (307)')
    } finally {
      delete process.env.RELAY_TEST_REDIRECT
      server.close()
    }
  })

  it('the host reads a running relay as up, its hub, and a failure, from the real script', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-probe-'))
    // As RELAY_START writes it: echo, so the file ends in a newline.
    execFileSync('bash', ['-c', `echo b1+abc > ${dir}/build`])
    writeFileSync(join(dir, 'relay.mjs'), 'setTimeout(() => {}, 60_000)')
    const relay = spawn('node', [join(dir, 'relay.mjs')], { stdio: 'ignore' })
    const hub = createServer((req, res) => res.writeHead(req.url === '/health' ? 200 : 404).end())
    await new Promise<void>(resolve => hub.listen(0, '127.0.0.1', resolve))
    const port = (hub.address() as { port: number }).port
    const probe = async (hubPort: number | null) => readRelayProbe((await promisify(execFile)('bash', ['-c', relayProbeScript(dir, hubPort)])).stdout)
    try {
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(await probe(port)).toEqual({ build: 'b1+abc', up: true, failed: '', hub: '200' })
      expect(await probe(null)).toEqual({ build: 'b1+abc', up: true, failed: '', hub: null })
      relay.kill()
      await new Promise(resolve => relay.once('exit', resolve))
      writeFileSync(join(dir, 'failed'), 'fetch relay.mjs failed (307)\n')
      expect(await probe(null)).toEqual({ build: 'b1+abc', up: false, failed: 'fetch relay.mjs failed (307)', hub: null })
    } finally {
      relay.kill()
      hub.close()
    }
  })
})
