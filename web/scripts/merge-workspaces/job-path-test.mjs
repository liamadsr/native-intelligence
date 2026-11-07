// DEV only (migration 417): the merge route's calls through PostgREST as service_role — preflight, enqueue (and a
// duplicate, which must be P0010), then the job row until the pg_cron runner records an outcome. Prints statuses,
// timings and counts only. Usage, from the repo root (needs .env.local = DEV):
//   node scripts/merge-workspaces/job-path-test.mjs <source id> <destination id> <owner user id>
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }),
)
if (!env.NEXT_PUBLIC_SUPABASE_URL.includes('edrjddsxjoigpbecqgfb')) throw new Error('.env.local is not DEV; stopping')
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const [source, destination, actor] = process.argv.slice(2)
const args = { p_source: source, p_destination: destination, p_actor: actor }

const pre = await sb.rpc('merge_workspace_preflight', { ...args, p_plan: null })
if (pre.error) throw new Error(`preflight ${pre.error.code}`)
console.log('preflight', { ok: pre.data.ok, blockers: (pre.data.blockers ?? []).map((b) => b.code) })
const t0 = Date.now()
const enq = await sb.rpc('merge_workspace_enqueue', { ...args, p_plan: pre.data.plan })
if (enq.error) throw new Error(`enqueue ${enq.error.code}`)
const dup = await sb.rpc('merge_workspace_enqueue', { ...args, p_plan: pre.data.plan })
console.log('duplicate enqueue', dup.error ? dup.error.code : 'NO ERROR')
for (;;) {
  const { data } = await sb.from('workspace_merge_job').select('status, result, error_code, error_message').eq('id', enq.data).maybeSingle()
  if (data && data.status !== 'queued') {
    console.log('job', { status: data.status, waited_ms: Date.now() - t0, error_code: data.error_code, engine_ms: data.result?.duration_ms })
    break
  }
  if (Date.now() - t0 > 180_000) { console.log('still queued after 180 s'); break }
  await new Promise((r) => setTimeout(r, 1000))
}
console.log('source still exists', Boolean((await sb.from('workspace').select('id').eq('id', source).maybeSingle()).data))
console.log('merge record', Boolean((await sb.from('workspace_merge').select('id').eq('source_workspace_id', source).maybeSingle()).data))
