/**
 * E2E smoke of Loops v3 Phase 3 INTERACTIVE work runs against LOCAL dev + DEV
 * Supabase: mid-run question park + answer + resume, then post-settle follow-up
 * chat on the run's parked eve session.
 *
 * Flow (extends scripts/work-proposal-smoke.ts):
 *   1. throwaway DEV user (handle_new_user provisions workspace+member)
 *   2. seed a work_proposal card whose task FORCES a request_user_input ask
 *   3. PATCH the real Start route
 *   4. poll agent_run → expect status 'needs_input' + pending_input questions
 *   5. assert the run-read API returns pending_input but NEVER session_state
 *   6. POST /respond with answers → poll to terminal (completed)
 *   7. POST /chat with a follow-up question → print the reduced NDJSON events
 *   8. GET /chat replay → confirm the prior follow-up turn replays
 *
 * Usage: node_modules/.bin/tsx scripts/work-interaction-smoke.ts <email>
 * Set SMOKE_BASE_URL for a dev server not on :3000.
 * The dev server must have booted AFTER agents/work-agent gained
 * request_user_input (eve children spawn at next-dev boot — restart it).
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { mainCheckout } from './main-checkout'

// The checkout whose env files it reads: REPO, or the main checkout (a worktree has none).
const REPO = process.env.REPO ?? mainCheckout()
const env: Record<string, string> = {}
for (const f of ['.env.local', '.env.development.local']) {
  try {
    for (const line of readFileSync(`${REPO}/${f}`, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?\s*$/)
      if (m && !(m[1] in env)) env[m[1]] = m[2]
    }
  } catch { /* file optional */ }
}
const url = env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY
if (!url?.includes('edrjddsxjoigpbecqgfb')) throw new Error(`refusing: not DEV supabase (${url})`)

const email = process.argv[2]
if (!email) throw new Error('usage: tsx scripts/work-interaction-smoke.ts <email>')

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
const baseUrl = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000'

async function pollRun(
  runId: string,
  until: (status: string) => boolean,
  maxMs: number,
): Promise<Record<string, unknown> | null> {
  const started = Date.now()
  let lastLog = 0
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000))
    const { data: run } = await admin
      .from('agent_run')
      .select('status, log_tail, pending_input, session_state, result_summary, deliverables, error_message, sandbox_id')
      .eq('id', runId)
      .maybeSingle()
    const logLen = (run?.log_tail as string | null)?.length ?? 0
    process.stdout.write(
      `  ${Math.round((Date.now() - started) / 1000)}s status=${run?.status} log=${logLen}${logLen > lastLog ? ' (+)' : ''}\n`,
    )
    lastLog = logLen
    if (run && until(run.status as string)) return run
    if (run && ['failed', 'canceled'].includes(run.status as string)) {
      console.log('UNEXPECTED terminal:', run.status, run.error_message)
      console.log('log tail:\n', ((run.log_tail as string) ?? '').slice(-800))
      return run
    }
    if (Date.now() - started > maxMs) {
      console.log('TIMEOUT — still', run?.status)
      return run ?? null
    }
  }
}

async function readNdjson(res: Response, label: string): Promise<string[]> {
  const lines: string[] = []
  if (!res.body) return lines
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (line) {
        lines.push(line)
        console.log(`  [${label}]`, line.length > 160 ? line.slice(0, 160) + '…' : line)
      }
    }
  }
  return lines
}

async function main() {
  // 1. User + session (same shape as work-proposal-smoke).
  let userId: string
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: 'Interaction Smoke' },
  })
  if (createErr) {
    if (!/already/i.test(createErr.message)) throw createErr
    const { data: list } = await admin.auth.admin.listUsers()
    userId = list.users.find((u) => u.email === email)!.id
    console.log('reusing user', userId)
  } else {
    userId = created.user.id
    console.log('created user', userId)
  }

  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (linkErr) throw linkErr
  const anon = createClient(url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data: session, error: otpErr } = await anon.auth.verifyOtp({
    type: 'magiclink',
    token_hash: link.properties.hashed_token,
  })
  if (otpErr) throw otpErr
  const token = session.session!.access_token
  console.log('session minted')

  let workspaceId = ''
  let memberId = ''
  for (let i = 0; i < 20; i++) {
    const { data: m } = await admin
      .from('member').select('id, workspace_id, onboarding_completed_at').eq('user_id', userId).limit(1).maybeSingle()
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
  console.log('workspace', workspaceId, 'member', memberId)

  // 2. Seed a card whose task FORCES a mid-run question.
  const { data: card, error: cardErr } = await admin
    .from('attention_item')
    .insert({
      workspace_id: workspaceId,
      member_id: memberId,
      kind: 'work_proposal',
      title: 'Draft a check-in note to the team',
      why: 'Smoke: forces a mid-run clarifying question.',
      payload: {
        task:
          'Write a SHORT team check-in note (3-4 sentences) as a document titled "Team Check-in". ' +
          'IMPORTANT: before writing anything, you MUST ask the user ONE clarifying question with the request_user_input tool: ' +
          'whether the tone should be "Upbeat" or "Direct" (two options, single-select, header "Tone"). ' +
          'Wait for the answer, write the note in the chosen tone, save the document, then call finish_work with the document as a deliverable.',
        deliverable_hint: 'document',
        resources: [{ type: 'capture', label: 'Smoke harness' }],
        skill_name: 'Smoke Harness',
        confidence: 0.95,
      },
      status: 'pending',
      expires_at: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
    })
    .select('id')
    .single()
  if (cardErr) throw cardErr
  console.log('card seeded', card.id)

  // 3. Start.
  const start = await fetch(`${baseUrl}/api/account/attention-items`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ id: card.id, action: 'start' }),
  })
  const startBody = await start.json().catch(() => ({}))
  console.log('start:', start.status, JSON.stringify(startBody))
  if (!start.ok) throw new Error('start failed')
  const runId = startBody.agent_run_id as string

  // 4. Wait for the question park.
  console.log('\n=== waiting for needs_input park ===')
  const parked = await pollRun(runId, (s) => s === 'needs_input', 240_000)
  if (parked?.status !== 'needs_input') throw new Error(`never parked (status=${parked?.status})`)
  console.log('pending_input:', JSON.stringify(parked.pending_input))
  console.log('session_state present in DB:', parked.session_state != null)

  // 5. The account run-read API must expose pending_input but never session_state.
  const read = await fetch(`${baseUrl}/api/account/agent-runs/${runId}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const readBody = await read.json()
  const runView = readBody.run ?? readBody
  console.log('run-read keys:', Object.keys(runView).join(','))
  if (JSON.stringify(readBody).includes('continuationToken')) throw new Error('LEAK: session_state in run-read response')
  if (!runView.pending_input) throw new Error('run-read missing pending_input')
  console.log('leak check OK (pending_input present, no continuationToken)')

  // 6. Answer → resume → terminal.
  const pending = parked.pending_input as { questions: { question: string }[] }
  const answers = pending.questions.map((q) => ({ question: q.question, answer: 'Direct' }))
  const respond = await fetch(`${baseUrl}/api/account/agent-runs/${runId}/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ answers }),
  })
  console.log('\nrespond:', respond.status, JSON.stringify(await respond.json().catch(() => ({}))))
  if (!respond.ok) throw new Error('respond failed')

  console.log('=== waiting for terminal after resume ===')
  const done = await pollRun(runId, (s) => ['completed', 'failed', 'canceled'].includes(s), 240_000)
  console.log('\n=== TERMINAL ===')
  console.log('status:', done?.status)
  console.log('result_summary:', done?.result_summary)
  console.log('deliverables:', JSON.stringify(done?.deliverables))
  console.log('session_state present:', done?.session_state != null)
  console.log('pending_input cleared:', done?.pending_input == null)
  if (done?.status !== 'completed') throw new Error('run did not complete')

  // Notifications: both the question ping and the ready ping should exist.
  const { data: notifs } = await admin
    .from('notification').select('type, title').eq('workspace_id', workspaceId)
    .in('type', ['work_run_input', 'work_run_ready'])
  console.log('notifications:', JSON.stringify(notifs))

  // 7. Follow-up chat.
  console.log('\n=== follow-up chat ===')
  const chat = await fetch(`${baseUrl}/api/account/agent-runs/${runId}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: 'In one sentence: which tone did you use, and why?' }),
  })
  console.log('chat POST:', chat.status)
  if (!chat.ok) throw new Error('chat failed: ' + (await chat.text()))
  const chatLines = await readNdjson(chat, 'chat')
  const gotText = chatLines.some((l) => l.includes('"text-delta"'))
  const gotDone = chatLines.some((l) => l.includes('"done"'))
  if (!gotText || !gotDone) throw new Error(`follow-up turn incomplete (text=${gotText} done=${gotDone})`)

  // 8. Replay — the follow-up turn above must be reconstructable.
  console.log('\n=== replay ===')
  const replay = await fetch(`${baseUrl}/api/account/agent-runs/${runId}/chat`, {
    headers: { authorization: `Bearer ${token}` },
  })
  console.log('chat GET:', replay.status)
  const replayLines = await readNdjson(replay, 'replay')
  console.log(`replayed ${replayLines.length} events; contains text:`, replayLines.some((l) => l.includes('"text-delta"')))

  console.log('\nALL INTERACTION RECEIPTS GREEN 🎉')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
