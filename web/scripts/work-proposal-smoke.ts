/**
 * E2E smoke of the Loops v3 work-proposal path against LOCAL dev + DEV Supabase.
 *
 * Creates a throwaway DEV user (handle_new_user provisions workspace+member),
 * seeds a work_proposal attention card (service role — cards are service-write-only),
 * mints a real session, PATCHes the REAL Start route, then polls the agent_run
 * to terminal and prints receipts: run status/log tail, deliverables, the tracked
 * action's workflow state + agent_run_status, and the work_run_ready notification.
 *
 * Usage: node_modules/.bin/tsx scripts/work-proposal-smoke.ts <email>
 * Set SMOKE_BASE_URL to target a dev server not on :3000 (autoPort sessions).
 * Requires the dev server to have booted AFTER agents/work-agent existed
 * (eve children spawn at next-dev boot).
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
if (!email) throw new Error('usage: tsx scripts/work-proposal-smoke.ts <email>')

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
const baseUrl = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000'

async function main() {
  // 1. Create (or reuse) the throwaway user — the trigger provisions workspace+member.
  let userId: string
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: 'Work Smoke' },
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

  // 2. Session (magiclink → verifyOtp) + browser cookie for the visual walkthrough.
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (linkErr) throw linkErr
  const anon = createClient(url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data: session, error: otpErr } = await anon.auth.verifyOtp({
    type: 'magiclink',
    token_hash: link.properties.hashed_token,
  })
  if (otpErr) throw otpErr
  const token = session.session!.access_token
  const ref = url.match(/https:\/\/([a-z0-9]+)\.supabase/)![1]
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session.session)).toString('base64url')
  console.log('session minted')
  console.log(`BROWSER COOKIE sb-${ref}-auth-token = (printed last)`)

  // 3. Wait for member + workspace.
  let workspaceId = ''
  let memberId = ''
  for (let i = 0; i < 20; i++) {
    const { data: m } = await admin
      .from('member').select('id, workspace_id').eq('user_id', userId).limit(1).maybeSingle()
    if (m?.workspace_id) { workspaceId = m.workspace_id; memberId = m.id; break }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!workspaceId) throw new Error('no member row appeared — trigger did not provision')
  console.log('workspace', workspaceId, 'member', memberId)

  // 4. Seed the work_proposal card (service role — the verdict engine's write path).
  const { data: card, error: cardErr } = await admin
    .from('attention_item')
    .insert({
      workspace_id: workspaceId,
      member_id: memberId,
      kind: 'work_proposal',
      title: 'Draft a launch-announcement doc for Native Intelligence',
      why: 'You said in today’s sync you wanted announcement copy ready before Thursday.',
      payload: {
        task:
          'Create a short launch-announcement document for Native Intelligence, an AI meeting workspace that turns meetings into tracked work. ' +
          'Audience: existing waitlist subscribers. Tone: warm, direct, no corporate filler. ' +
          'Structure: a 1-line hook, 3 short paragraphs (what Native Intelligence does, what changed with launch, how to get started), and a closing line inviting replies. ' +
          'Save it as a document titled "Native Intelligence Launch Announcement". When done, call finish_work with the document as a deliverable.',
        deliverable_hint: 'document',
        resources: [{ type: 'capture', label: "Today's sync" }],
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

  // 5. PATCH the REAL Start route.
  const start = await fetch(`${baseUrl}/api/account/attention-items`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ id: card.id, action: 'start' }),
  })
  const startBody = await start.json().catch(() => ({}))
  console.log('start:', start.status, JSON.stringify(startBody))
  if (!start.ok) throw new Error('start failed')
  const runId = startBody.agent_run_id as string

  // 6. Poll the run to terminal (max ~5 min), narrating log growth.
  const started = Date.now()
  let lastLogLen = 0
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000))
    const { data: run } = await admin
      .from('agent_run')
      .select('status, log_tail, result_summary, deliverables, error_message, sandbox_id')
      .eq('id', runId)
      .maybeSingle()
    const logLen = run?.log_tail?.length ?? 0
    process.stdout.write(
      `  ${Math.round((Date.now() - started) / 1000)}s status=${run?.status} log=${logLen}${logLen > lastLogLen ? ' (+)' : ''}\n`,
    )
    lastLogLen = logLen
    if (run && ['completed', 'failed', 'canceled'].includes(run.status)) {
      console.log('\n=== TERMINAL ===')
      console.log('status:', run.status)
      console.log('sandbox_id:', run.sandbox_id)
      console.log('error:', run.error_message)
      console.log('result_summary:', run.result_summary)
      console.log('deliverables:', JSON.stringify(run.deliverables))
      console.log('log tail (last 600):\n', (run.log_tail ?? '').slice(-600))
      break
    }
    if (Date.now() - started > 300_000) { console.log('TIMEOUT — still', run?.status); break }
  }

  // 7. Receipts: tracked action state, documents, notification, card status.
  const { data: startedAction } = await admin
    .from('actions')
    .select('id, title, agent_run_status, status_id, context_data')
    .eq('id', startBody.entity_id)
    .maybeSingle()
  const { data: state } = startedAction?.status_id
    ? await admin.from('workflow_state').select('name, category').eq('id', startedAction.status_id).maybeSingle()
    : { data: null }
  console.log('\ntracked action:', JSON.stringify({ ...startedAction, state }))
  const { data: docs } = await admin
    .from('document').select('id, title').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(3)
  console.log('recent documents:', JSON.stringify(docs))
  const { data: notifs } = await admin
    .from('notification').select('type, title, target_type, target_id').eq('workspace_id', workspaceId)
    .eq('type', 'work_run_ready')
  console.log('work_run_ready notifications:', JSON.stringify(notifs))
  const { data: cardAfter } = await admin
    .from('attention_item').select('status, resolved_at').eq('id', card.id).maybeSingle()
  console.log('card after:', JSON.stringify(cardAfter))
  console.log(`\nBROWSER COOKIE sb-${ref}-auth-token=${cookieValue.slice(0, 40)}… (full below)`)
  console.log(cookieValue)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
