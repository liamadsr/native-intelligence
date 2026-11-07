/**
 * E2E smoke of the agent-driven onboarding seeding path against LOCAL dev + DEV Supabase.
 * Creates a throwaway DEV user (handle_new_user provisions workspace+member),
 * mints a real session token, POSTs the REAL kickoff route with role/focus,
 * then polls the durable research state to terminal and prints receipts.
 *
 * Usage: node_modules/.bin/tsx onboarding-e2e-smoke.ts <email> <role> <focus>
 * Set SMOKE_BASE_URL to target a dev server not on :3000 (autoPort sessions).
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { mainCheckout } from './main-checkout'

// The checkout whose env files it reads: REPO, or the main checkout (a worktree has none).
const REPO = process.env.REPO ?? mainCheckout()
const env: Record<string, string> = {}
for (const line of readFileSync(`${REPO}/.env.local`, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?\s*$/)
  if (m) env[m[1]] = m[2]
}
const url = env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY
if (!url?.includes('edrjddsxjoigpbecqgfb')) throw new Error(`refusing: not DEV supabase (${url})`)

const email = process.argv[2]
const role = process.argv[3] ?? ''
const focus = process.argv[4] ?? ''
if (!email) throw new Error('usage: tsx onboarding-e2e-smoke.ts <email> <role> <focus>')

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
const baseUrl = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000'

async function main() {
  // 1. Create (or reuse) the throwaway user — the trigger provisions workspace+member.
  let userId: string
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: 'Smoke Founder' },
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

  // 2. Mint a real session (magiclink → verifyOtp) — the established DEV harness pattern.
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

  // 3. Wait for the member row (trigger is async-ish), grab workspace.
  let workspaceId = ''
  for (let i = 0; i < 20; i++) {
    const { data: m } = await admin.from('member').select('workspace_id').eq('user_id', userId).limit(1).maybeSingle()
    if (m?.workspace_id) { workspaceId = m.workspace_id; break }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!workspaceId) throw new Error('no member row appeared — trigger did not provision')
  console.log('workspace', workspaceId)

  // 4. POST the REAL kickoff route with priming.
  const kick = await fetch(`${baseUrl}/api/account/onboarding/research`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ role, focus }),
  })
  const kickBody = await kick.json().catch(() => ({}))
  console.log('kickoff:', kick.status, JSON.stringify(kickBody))
  if (!kick.ok) throw new Error('kickoff failed')

  // 5. Poll durable research state to terminal (max ~3 min).
  const started = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000))
    const { data: m } = await admin
      .from('member')
      .select('onboarding_progress')
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    const research = (m?.onboarding_progress as { research?: Record<string, unknown> } | null)?.research
    const status = research?.status as string | undefined
    process.stdout.write(`  ${Math.round((Date.now() - started) / 1000)}s status=${status}\n`)
    if (status === 'done' || status === 'skipped' || status === 'error') {
      console.log('\n=== TERMINAL ===')
      console.log('status:', status)
      console.log('companyFound:', research?.companyFound)
      console.log('seededSummary:', JSON.stringify(research?.seededSummary))
      console.log('brief:', String(research?.brief ?? '').slice(0, 500))
      break
    }
    if (Date.now() - started > 180_000) { console.log('TIMEOUT — still', status); break }
  }

  // 6. Receipts: seeded rows + workspace name.
  const { data: ws } = await admin.from('workspace').select('name').eq('id', workspaceId).maybeSingle()
  console.log('\nworkspace name:', ws?.name)
  const { data: projects } = await admin.from('projects').select('id, name, status').eq('workspace_id', workspaceId)
  console.log('projects:', JSON.stringify(projects))
  const { data: actions } = await admin
    .from('actions')
    .select('identifier, title, context_data, project_id, team_id, status_id')
    .eq('workspace_id', workspaceId)
  console.log('actions:', JSON.stringify(actions, null, 1))
}

main().catch((e) => { console.error('SMOKE FAILED', e); process.exit(1) })
