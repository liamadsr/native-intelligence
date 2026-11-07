// Calls the temporary sleep RPC through PostgREST as service_role and prints
// only the status, the elapsed time and the (key-free) body.
import { readFileSync } from 'node:fs'

const envFile = process.argv[2]
const seconds = Number(process.argv[3] ?? '12')
const env = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')]
    }),
)
const url = env.NEXT_PUBLIC_SUPABASE_URL
const key = env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) throw new Error('env missing url or service key')

const t0 = Date.now()
const res = await fetch(`${url}/rest/v1/rpc/_wsmerge_probe_sleep`, {
  method: 'POST',
  headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_seconds: seconds }),
})
const body = await res.text()
console.log(JSON.stringify({ project: url.replace(/^https:\/\//, '').split('.')[0], status: res.status, elapsed_s: ((Date.now() - t0) / 1000).toFixed(1), body: body.slice(0, 300) }))
