#!/usr/bin/env node
// One cron call, as Vercel Cron makes it: GET <CRON_TARGET_URL><path> with
// `Authorization: Bearer $CRON_SECRET`. The crontab runs this once per job
// (generate.mjs). Exits non-zero, with the status and the start of the body, on
// anything but a 2xx, so supercronic logs the failure.
//
//   CRON_TARGET_URL        the web role's origin, e.g. http://web:3000
//   CRON_SECRET            the same secret the web role has
//   CRON_TIMEOUT_SECONDS   default 900 (the routes' own limits are 30 to 300 seconds)
const path = process.argv[2]
const target = process.env.CRON_TARGET_URL?.replace(/\/+$/, '')
const secret = process.env.CRON_SECRET
const timeoutSeconds = Number(process.env.CRON_TIMEOUT_SECONDS || 900)

function fail(message) {
  console.error(`cron ${path ?? ''}: ${message}`)
  process.exit(1)
}

if (!path?.startsWith('/')) fail('usage: call.mjs /api/cron/<name>')
if (!target) fail('CRON_TARGET_URL is not set')
if (!secret) fail('CRON_SECRET is not set')
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) fail('CRON_TIMEOUT_SECONDS must be a positive number')

const started = Date.now()
const seconds = () => ((Date.now() - started) / 1000).toFixed(1)
try {
  const response = await fetch(`${target}${path}`, {
    headers: { authorization: `Bearer ${secret}`, 'user-agent': 'ni-cron/1.0' },
    // Vercel Cron does not follow redirects: a 3xx is a failed run.
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutSeconds * 1000),
  })
  const body = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 300)
  if (!response.ok) fail(`${response.status} after ${seconds()}s: ${body}`)
  console.log(`cron ${path}: ${response.status} in ${seconds()}s`)
} catch (error) {
  const cause = error?.cause?.code ?? error?.cause?.message
  fail(`${error?.name ?? 'Error'} after ${seconds()}s: ${error?.message ?? error}${cause ? ` (${cause})` : ''}`)
}
