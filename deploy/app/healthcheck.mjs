#!/usr/bin/env node
// The image's HEALTHCHECK. entrypoint.sh wrote the container's role to /tmp/ni-role;
// this asks that role's own health route on localhost.
//
//   web           GET /api/version      200 with a buildId
//   worker        GET /api/inngest      200 from the Inngest SDK's unsigned introspection,
//                                       with functions loaded and a signing key set
//                                       (without one the SDK answers 500)
//   agent <name>  GET /eve/v1/health    200 with status "ready" (eve's public health route)
//   cron          supercronic is running
import { readFileSync, readdirSync } from 'node:fs'

const port = process.env.PORT || '3000'

function unhealthy(message) {
  console.error(`unhealthy: ${message}`)
  process.exit(1)
}

async function getJson(path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(4000) })
  if (response.status !== 200) unhealthy(`${path} answered ${response.status}`)
  return response.json()
}

let role
try {
  role = readFileSync('/tmp/ni-role', 'utf8').trim()
} catch {
  unhealthy('no role yet (/tmp/ni-role is missing)')
}

try {
  if (role === 'web') {
    const body = await getJson('/api/version')
    if (typeof body?.buildId !== 'string') unhealthy(`/api/version has no buildId: ${JSON.stringify(body)}`)
  } else if (role === 'worker') {
    // inngest 4.0.0, InngestCommHandler.introspectionBody(): without a signature the
    // reply has function_count, has_signing_key, has_event_key and mode, nothing else.
    const body = await getJson('/api/inngest')
    if (!(body?.function_count > 0)) unhealthy(`/api/inngest has no functions: ${JSON.stringify(body)}`)
    if (body?.has_signing_key !== true) unhealthy(`/api/inngest has no signing key: ${JSON.stringify(body)}`)
  } else if (role.startsWith('agent ')) {
    const body = await getJson('/eve/v1/health')
    if (body?.status !== 'ready') unhealthy(`/eve/v1/health is not ready: ${JSON.stringify(body)}`)
  } else if (role === 'cron') {
    const running = readdirSync('/proc')
      .filter(entry => /^\d+$/.test(entry))
      .some(pid => {
        try {
          return readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === 'supercronic'
        } catch {
          return false
        }
      })
    if (!running) unhealthy('supercronic is not running')
  } else {
    unhealthy(`unknown role "${role}"`)
  }
} catch (error) {
  unhealthy(error?.cause?.code ?? error?.message ?? String(error))
}
