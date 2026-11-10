/**
 * RUNTIME GATE for the step-split work-run dispatch (precondition A1/A2 of
 * docs/plans/agent-orchestration-followup.md): drive ONE deliberately long work
 * run against LOCAL dev (next dev + its eve children + the Inngest dev server)
 * and DEV Supabase, and print the receipts that prove:
 *
 *   - exactly ONE eve session is created for the run (agent_run.sandbox_id never
 *     changes once stamped, across every watch-step boundary and any retry);
 *   - a turn far longer than one /api/inngest request (300 s on Vercel) is
 *     watched to its boundary rather than cut off (the run parks / finishes);
 *   - a park (request_user_input) is honoured wherever the budget boundary lands,
 *     the answer resumes the SAME session, and the run finishes cleanly.
 *
 * The task tells the agent to hold the turn open with `sleep` (an eve tool the
 * work-agent must expose for this run), then ask ONE question, then finish.
 * With a real model the task text drives it; the local gate harness drives the
 * same plan with a scripted model (see the follow-up plan doc, Part 0).
 *
 * Flow (mirrors scripts/work-interaction-smoke.ts):
 *   1. throwaway DEV user (handle_new_user provisions workspace+member)
 *   2. seed a work_proposal card carrying the gate task
 *   3. PATCH the real Start route
 *   4. poll agent_run + tracked_job every 5 s, printing a timeline; assert one session id
 *   5. on needs_input: POST /respond (answer "Yes") → poll to terminal
 *   6. read the next-dev access log for the /api/inngest step requests (GATE_NEXT_LOG)
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/work-run-gate-smoke.ts <email> [--sleep-seconds N] [--sleep-count N] [--cancel-after-tools N]
 * `--cancel-after-tools N` presses Stop (the real cancel route) once N tool
 * calls have been logged, mid-tool-call, and expects the run to settle
 * `canceled` with its eve session cancelled (pre-step 1: Stop must stop).
 * Env: SMOKE_BASE_URL (default http://localhost:3000), GATE_NEXT_LOG (path of the
 * next-dev stdout log, optional), GATE_MAX_MINUTES (default 40).
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env: Record<string, string> = { ...(process.env as Record<string, string>) }
for (const f of ['.env.local', '.env.development.local']) {
  try {
    for (const line of readFileSync(`${process.cwd()}/${f}`, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?\s*$/)
      if (m && !(m[1] in env)) env[m[1]] = m[2]
    }
  } catch {
    /* file optional */
  }
}
function required(name: string): string {
  const v = env[name]
  if (!v) throw new Error(`${name} is required`)
  return v
}
const url = required('NEXT_PUBLIC_SUPABASE_URL')
const serviceKey = required('SUPABASE_SERVICE_ROLE_KEY')
const anonKey = required('NEXT_PUBLIC_SUPABASE_ANON_KEY')
if (!url.includes('edrjddsxjoigpbecqgfb')) throw new Error(`refusing: not DEV supabase (${url})`)

const argv = process.argv.slice(2)
const email = argv.find((a) => !a.startsWith('--')) ?? ''
if (!email) throw new Error('usage: tsx scripts/work-run-gate-smoke.ts <email> [--sleep-seconds N] [--sleep-count N]')
const flag = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const sleepSeconds = Number(flag('sleep-seconds', env.GATE_SLEEP_SECONDS ?? '100'))
const sleepCount = Number(flag('sleep-count', env.GATE_SLEEP_COUNT ?? '7'))
const cancelAfterTools = Number(flag('cancel-after-tools', '0'))
const maxMs = Number(env.GATE_MAX_MINUTES ?? '40') * 60_000

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
const baseUrl = env.SMOKE_BASE_URL ?? 'http://localhost:3000'

const t0 = Date.now()
const elapsed = () => `${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s`
const log = (...a: unknown[]) => console.log(elapsed(), ...a)

interface RunRow {
  status: string
  sandbox_id: string | null
  session_state: { sessionId?: string; streamIndex?: number } | null
  pending_input: { requestId?: string; questions?: { question: string }[] } | null
  log_tail: string | null
  result_summary: string | null
  deliverables: unknown
  error_message: string | null
  started_at: string | null
  finished_at: string | null
}

async function readRun(runId: string): Promise<RunRow | null> {
  const { data } = await admin
    .from('agent_run')
    .select('status, sandbox_id, session_state, pending_input, log_tail, result_summary, deliverables, error_message, started_at, finished_at')
    .eq('id', runId)
    .maybeSingle()
  return (data as RunRow | null) ?? null
}

async function readLedger(runId: string): Promise<{ status: string; current_step: string | null } | null> {
  const { data } = await admin.from('tracked_job').select('status, current_step').eq('agent_run_id', runId).maybeSingle()
  return (data as { status: string; current_step: string | null } | null) ?? null
}

const sessionIds = new Set<string>()
const transitions: Array<{ at: number; what: string }> = []
function note(what: string) {
  transitions.push({ at: Math.round((Date.now() - t0) / 1000), what })
  log('▶', what)
}

async function pollUntil(
  runId: string,
  until: (r: RunRow) => boolean,
  budgetMs: number,
  onTick?: (run: RunRow, toolLines: number) => Promise<void>,
): Promise<RunRow | null> {
  const started = Date.now()
  let last = ''
  let lastBeat = 0
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000))
    const run = await readRun(runId)
    const ledger = await readLedger(runId)
    if (!run) continue
    if (onTick) await onTick(run, (run.log_tail ?? '').match(/\[tool\] [a-z_]+/g)?.length ?? 0)
    if (run.sandbox_id?.startsWith('eve:')) {
      const sid = run.sandbox_id.slice(4)
      if (!sessionIds.has(sid)) {
        sessionIds.add(sid)
        note(`session stamped: ${sid} (${sessionIds.size} distinct so far)`)
      }
    }
    const idx = run.session_state?.streamIndex
    const sig = `${run.status}|${run.sandbox_id}|${idx ?? '-'}|${ledger?.status}|${ledger?.current_step ?? ''}|${(run.log_tail ?? '').length}`
    const toolLines = (run.log_tail ?? '').match(/\[tool\] [a-z_]+/g)?.length ?? 0
    if (sig !== last || Date.now() - lastBeat > 30_000) {
      log(`status=${run.status} session=${run.sandbox_id ?? '-'} streamIndex=${idx ?? '-'} ledger=${ledger?.status ?? '-'}${ledger?.current_step ? ` (${ledger.current_step})` : ''} log=${(run.log_tail ?? '').length}ch tools=${toolLines}`)
      lastBeat = Date.now()
    }
    if (sig.split('|')[0] !== last.split('|')[0]) note(`agent_run.status → ${run.status}`)
    last = sig
    if (until(run)) return run
    if (['failed', 'canceled'].includes(run.status)) {
      log(cancelAfterTools > 0 ? 'terminal:' : 'UNEXPECTED terminal:', run.status, run.error_message)
      log('log tail:\n', (run.log_tail ?? '').slice(-1200))
      return run
    }
    if (Date.now() - started > budgetMs) {
      log('TIMEOUT — still', run.status)
      return run
    }
  }
}

async function main() {
  log(`gate: sleep ${sleepCount} × ${sleepSeconds}s ≈ ${sleepCount * sleepSeconds}s of one turn, then one question, then finish`)

  // 1. User + session.
  let userId: string
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: 'Runtime Gate' },
  })
  if (createErr) {
    if (!/already/i.test(createErr.message)) throw createErr
    const { data: list } = await admin.auth.admin.listUsers()
    userId = list.users.find((u) => u.email === email)!.id
    log('reusing user', userId)
  } else {
    userId = created.user.id
    log('created user', userId)
  }
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (linkErr) throw linkErr
  const anon = createClient(url, anonKey, { auth: { persistSession: false } })
  const { data: session, error: otpErr } = await anon.auth.verifyOtp({ type: 'magiclink', token_hash: link.properties.hashed_token })
  if (otpErr) throw otpErr
  const token = session.session!.access_token

  let workspaceId = ''
  let memberId = ''
  for (let i = 0; i < 20; i++) {
    const { data: m } = await admin
      .from('member')
      .select('id, workspace_id, onboarding_completed_at')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle()
    if (m?.workspace_id) {
      workspaceId = m.workspace_id
      memberId = m.id
      if (!m.onboarding_completed_at) {
        await admin.from('member').update({ onboarding_completed_at: new Date().toISOString() }).eq('id', m.id)
      }
      break
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!workspaceId) throw new Error('no member row appeared — trigger did not provision')
  log('workspace', workspaceId, 'member', memberId)

  // 2. The gate card.
  const task =
    `RUNTIME GATE. Do exactly this, in order, with no other tools: ` +
    `(1) call the sleep tool with { seconds: ${sleepSeconds} } exactly ${sleepCount} times, one after another, waiting for each to return; ` +
    `(2) then ask the user ONE question with request_user_input (header "Gate", question "Gate: the long turn is done. Continue to finish?", options "Yes" and "No", single-select); ` +
    `(3) after the answer arrives, call finish_work with a one-sentence summary and an empty deliverables list. Do not create any document, draft or action.`
  const { data: card, error: cardErr } = await admin
    .from('attention_item')
    .insert({
      workspace_id: workspaceId,
      member_id: memberId,
      kind: 'work_proposal',
      title: 'Runtime gate: one long turn',
      why: 'Gate: a turn longer than one Inngest request, a park, a resume, a finish.',
      payload: {
        task,
        deliverable_hint: 'none',
        resources: [{ type: 'capture', label: 'Runtime gate harness' }],
        skill_name: 'Runtime Gate',
        confidence: 0.99,
      },
      status: 'pending',
      expires_at: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
    })
    .select('id')
    .single()
  if (cardErr) throw cardErr
  log('card seeded', card.id)

  // 3. Start (the real route: action + agent_run + ledger row + work/run.requested).
  const start = await fetch(`${baseUrl}/api/account/attention-items`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ id: card.id, action: 'start' }),
  })
  const startBody = await start.json().catch(() => ({}))
  log('start:', start.status, JSON.stringify(startBody))
  if (!start.ok) throw new Error('start failed')
  const runId = startBody.agent_run_id as string
  const actionId = startBody.entity_id as string
  note(`run ${runId} started`)

  // 4a. Stop mid-tool-call (pre-step 1) — the real cancel route, once N tool
  //     calls have been logged; then expect `canceled` and a released park.
  if (cancelAfterTools > 0) {
    log(`=== waiting for ${cancelAfterTools} tool call(s), then Stop ===`)
    let pressed = false
    const done = await pollUntil(
      runId,
      (r) => ['completed', 'failed', 'canceled'].includes(r.status),
      maxMs,
      async (run, toolLines) => {
        if (pressed || toolLines < cancelAfterTools || run.status !== 'running') return
        pressed = true
        const res = await fetch(`${baseUrl}/api/account/actions/${actionId}/agent-runs/${runId}/cancel`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        })
        log('Stop:', res.status, JSON.stringify(await res.json().catch(() => ({}))))
        note(`Stop pressed after ${toolLines} tool call(s)`)
      },
    )
    const ledger = await readLedger(runId)
    console.log('\n=== STOP RECEIPTS ===')
    console.log('run id:               ', runId)
    console.log('final status:         ', done?.status, done?.error_message ? `(${done.error_message})` : '')
    console.log('distinct eve sessions:', sessionIds.size, [...sessionIds].join(', '))
    console.log('pending_input cleared:', done?.pending_input == null)
    console.log('ledger:               ', JSON.stringify(ledger))
    console.log('finished_at:          ', done?.finished_at)
    console.log('timeline:')
    for (const t of transitions) console.log(`  ${String(t.at).padStart(5)}s  ${t.what}`)
    const tools = (done?.log_tail ?? '').match(/\[tool\] [a-z_]+/g) ?? []
    console.log('tool lines in log_tail:', tools.length, tools.join(' | '))
    console.log('log tail end:', JSON.stringify((done?.log_tail ?? '').slice(-160)))
    const ok = done?.status === 'canceled' && ledger?.status === 'canceled' && done?.pending_input == null && sessionIds.size === 1
    console.log(ok ? '\nSTOP GREEN 🎉' : '\nSTOP RED')
    process.exit(ok ? 0 : 1)
  }

  // 4. The long turn → the park.
  log('=== waiting for the park (needs_input) ===')
  const parked = await pollUntil(runId, (r) => r.status === 'needs_input', maxMs)
  if (parked?.status !== 'needs_input') throw new Error(`never parked (status=${parked?.status})`)
  log('pending_input:', JSON.stringify(parked.pending_input))
  log('session_state:', JSON.stringify(parked.session_state))

  // 5. Answer → resume on the SAME session → terminal.
  const answers = (parked.pending_input?.questions ?? []).map((q) => ({ question: q.question, answer: 'Yes' }))
  const respond = await fetch(`${baseUrl}/api/account/agent-runs/${runId}/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ answers }),
  })
  log('respond:', respond.status, JSON.stringify(await respond.json().catch(() => ({}))))
  if (!respond.ok) throw new Error('respond failed')
  note('answered the question')

  log('=== waiting for terminal after resume ===')
  const done = await pollUntil(runId, (r) => ['completed', 'failed', 'canceled'].includes(r.status), maxMs)

  // 6. Receipts.
  const ledger = await readLedger(runId)
  const { data: notifs } = await admin
    .from('notification')
    .select('type, title')
    .eq('workspace_id', workspaceId)
    .in('type', ['work_needs_you', 'work_failed'])
  console.log('\n=== RECEIPTS ===')
  console.log('run id:               ', runId)
  console.log('final status:         ', done?.status, done?.error_message ? `(${done.error_message})` : '')
  console.log('distinct eve sessions:', sessionIds.size, [...sessionIds].join(', '))
  console.log('session_state:        ', JSON.stringify(done?.session_state))
  console.log('pending_input cleared:', done?.pending_input == null)
  console.log('result_summary:       ', done?.result_summary)
  console.log('deliverables:         ', JSON.stringify(done?.deliverables))
  console.log('ledger:               ', JSON.stringify(ledger))
  console.log('notifications:        ', JSON.stringify(notifs))
  console.log('started_at → finished_at:', done?.started_at, '→', done?.finished_at)
  console.log('timeline:')
  for (const t of transitions) console.log(`  ${String(t.at).padStart(5)}s  ${t.what}`)
  const tools = (done?.log_tail ?? '').match(/\[tool\] [a-z_]+/g) ?? []
  console.log('tool lines in log_tail:', tools.length, tools.slice(0, 12).join(' | '))

  const nextLog = env.GATE_NEXT_LOG
  if (nextLog) {
    try {
      const lines = readFileSync(nextLog, 'utf8')
        .split('\n')
        .filter((l) => /\/api\/inngest\?fnId=native-intelligence-work-run-(execute|resume)/.test(l))
      console.log(`\n/api/inngest requests for the work-run functions (${lines.length}):`)
      for (const l of lines) console.log('  ' + l.replace(/\x1b\[[0-9;]*m/g, '').trim())
    } catch (e) {
      console.log('could not read GATE_NEXT_LOG:', (e as Error).message)
    }
  }

  const ok = done?.status === 'completed' && sessionIds.size === 1 && done?.pending_input == null
  console.log(ok ? '\nGATE GREEN 🎉' : '\nGATE RED')
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
