// Runs inside the test sandbox (exit-check/check.ts copies it there): the app's
// stand-in for the relay. It serves the bundles and answers the relay's routes
// as the app does, enough for the exit to switch for real: the long-poll (no
// command, agent driving) and the exit switch (logged to /tmp/exit-check/switches.log).
//   node stand-in-origin.mjs <port> <dir>
import { appendFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const [port, dir] = [Number(process.argv[2]), process.argv[3]]
createServer((req, res) => {
  const url = new URL(req.url, 'http://origin')
  if (url.pathname.startsWith('/cloud-browser/')) {
    try { res.writeHead(200).end(readFileSync(join(dir, url.pathname))) } catch { res.writeHead(404).end() }
    return
  }
  if (url.pathname === '/api/browser-relay/next') {
    setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ command: null, driver: 'agent' })), 2000)
    return
  }
  if (url.pathname === '/api/browser-relay/exit' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      appendFileSync('/tmp/exit-check/switches.log', `${new Date().toISOString()} ${body}\n`)
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    })
    return
  }
  res.writeHead(404).end()
}).listen(port, '127.0.0.1')
