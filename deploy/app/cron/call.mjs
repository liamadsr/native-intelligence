#!/usr/bin/env node
// One cron call, as Vercel Cron makes it: GET <CRON_TARGET_URL><path> with
// `Authorization: Bearer $CRON_SECRET`. The crontab runs this once per job
// (generate.mjs). Exits non-zero, with the status and the start of the body, on
// anything but a 2xx, so supercronic logs the failure.
//
//   CRON_TARGET_URL        the web role's origin, e.g. http://web:3000
//   CRON_SECRET            the same secret the web role has
//   CRON_TIMEOUT_SECONDS   default 900 (the routes' own limits are 30 to 300 seconds)
//   CRON_DRY_RUN           1: say which route would be called, and call nothing
//
// node:http, not fetch: fetch stops waiting for a response's headers after 300 s,
// and a route that answers only when its work is done would fail there, well inside
// CRON_TIMEOUT_SECONDS. Here the one limit is CRON_TIMEOUT_SECONDS, for the whole call.
import http from 'node:http'
import https from 'node:https'

const path = process.argv[2]
const target = process.env.CRON_TARGET_URL?.replace(/\/+$/, '')
const secret = process.env.CRON_SECRET
const timeoutSeconds = Number(process.env.CRON_TIMEOUT_SECONDS || 900)

function fail(message) {
  console.error(`cron ${path ?? ''}: ${message}`)
  process.exit(1)
}

if (!path?.startsWith('/')) fail('usage: call.mjs /api/cron/<name>')
if (process.env.CRON_DRY_RUN === '1') {
  console.log(`cron ${path}: skipped, CRON_DRY_RUN is set`)
  process.exit(0)
}
if (!target) fail('CRON_TARGET_URL is not set')
if (!secret) fail('CRON_SECRET is not set')
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) fail('CRON_TIMEOUT_SECONDS must be a positive number')

const url = URL.parse(`${target}${path}`)
if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) fail('CRON_TARGET_URL must be an http:// or https:// origin')

const started = Date.now()
const seconds = () => ((Date.now() - started) / 1000).toFixed(1)

// Resolves with the status and the first 4 KB of the body. A redirect is not
// followed: Vercel Cron does not follow one either, so a 3xx is a failed run.
function get() {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${secret}`, 'user-agent': 'ni-cron/1.0' },
      // A connection of its own, closed after the response: nothing keeps this
      // process alive once the call is over.
      agent: false,
    })
    // The first outcome wins; the timeout is settled before the destroy it causes.
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(`no complete answer within ${timeoutSeconds}s`), { name: 'TimeoutError' }))
      request.destroy()
    }, timeoutSeconds * 1000)
    const failed = error => {
      clearTimeout(timer)
      reject(error)
    }
    request.on('error', failed)
    request.on('response', response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        if (body.length < 4096) body += chunk
      })
      response.on('error', failed)
      response.on('end', () => {
        clearTimeout(timer)
        resolve({ status: response.statusCode, body })
      })
    })
    request.end()
  })
}

try {
  const { status, body } = await get()
  const text = body.replace(/\s+/g, ' ').trim().slice(0, 300)
  if (!(status >= 200 && status < 300)) fail(`${status} after ${seconds()}s: ${text}`)
  console.log(`cron ${path}: ${status} in ${seconds()}s`)
} catch (error) {
  const cause = error?.code ?? error?.cause?.code ?? error?.cause?.message
  fail(`${error?.name ?? 'Error'} after ${seconds()}s: ${error?.message ?? error}${cause ? ` (${cause})` : ''}`)
}
