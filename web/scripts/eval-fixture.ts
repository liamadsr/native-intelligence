/**
 * The DEV fixture the deterministic evals run as (evals/README.md).
 *
 * Creates, or finds, one test person on DEV and makes their workspace an eval
 * fixture the chat channel's eval entry accepts (agents/chat-agent/lib/eval-auth.ts):
 *   - the auth user evals@dial8-evals.test (a reserved .test domain, so it can
 *     never be a real person), with no password: nobody signs in as it;
 *   - their own workspace (the signup trigger makes it), renamed
 *     "Dial8 Evals (fixture)" and marked `settings.eval_fixture = true`;
 *   - checked to have that user as its ONLY member;
 *   - a complimentary subscription (a granted_ row, as the admin console grants),
 *     since there is no free tier and the usage gate would cancel every turn;
 *   - one chat conversation, "Safety evals", the evals' token is minted for.
 * Then it prints the env lines for the app (.env.development.local) and the
 * runner. It prints no secret: make EVE_EVAL_SECRET yourself (see the README).
 *
 *   --reset   also switch off every flow in the fixture workspace, expire
 *             its pending approvals (the flow and outward cases leave both),
 *             and archive the fixture person's Now file: every case shares
 *             the one conversation, so a turn that wrote the note leaks into
 *             the next run's cases (migration 440's unique index skips an
 *             archived note, so the next write starts a fresh one).
 *
 * DEV ONLY: refuses any Supabase URL but DEV's. Writes only the fixture's own
 * rows. Run:
 *   node node_modules/.bin/tsx scripts/eval-fixture.ts [--reset]
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { EVAL_DEV_SUPABASE_HOST, EVAL_USER_EMAIL, isDevSupabaseUrl } from '../agents/chat-agent/lib/eval-fixture-identity'
const WORKSPACE_NAME = 'Dial8 Evals (fixture)'
const CONVERSATION_TITLE = 'Safety evals'

function loadEnvFile(path: string): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (!m) continue
    let val = m[2]
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    if (process.env[m[1]] === undefined) process.env[m[1]] = val
  }
}

async function findUserId(admin: SupabaseClient, email: string): Promise<string | null> {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`listUsers: ${error.message}`)
    const hit = data.users.find((u) => u.email?.toLowerCase() === email)
    if (hit) return hit.id
    if (data.users.length < 200) return null
  }
  return null
}

async function main(): Promise<void> {
  const root = resolve(__dirname, '..')
  loadEnvFile(resolve(root, '.env.development.local'))
  loadEnvFile(resolve(root, '.env.local'))
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  if (!isDevSupabaseUrl(url)) {
    throw new Error(`refusing: NEXT_PUBLIC_SUPABASE_URL's host is not DEV (${EVAL_DEV_SUPABASE_HOST}); the eval fixture lives on DEV only`)
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set')
  const admin = createClient(url, key, { auth: { persistSession: false } })

  let userId = await findUserId(admin, EVAL_USER_EMAIL)
  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({
      email: EVAL_USER_EMAIL,
      email_confirm: true,
      user_metadata: { full_name: 'Dial8 Evals' },
    })
    if (error || !data.user) throw new Error(`createUser: ${error?.message ?? 'no user'}`)
    userId = data.user.id
    console.error(`created ${EVAL_USER_EMAIL} (${userId})`)
  }

  const { data: memberships, error: mErr } = await admin.from('member').select('workspace_id, role').eq('user_id', userId)
  if (mErr) throw new Error(`member: ${mErr.message}`)
  if (!memberships || memberships.length !== 1) {
    throw new Error(`expected the eval user in exactly one workspace, found ${memberships?.length ?? 0}`)
  }
  const workspaceId = memberships[0].workspace_id as string

  const { data: members, error: allErr } = await admin.from('member').select('user_id').eq('workspace_id', workspaceId)
  if (allErr) throw new Error(`member: ${allErr.message}`)
  if (!members || members.length !== 1 || members[0].user_id !== userId) {
    throw new Error('the eval workspace has another member: refusing to mark it as a fixture')
  }

  const { data: ws, error: wsErr } = await admin.from('workspace').select('settings').eq('id', workspaceId).single()
  if (wsErr) throw new Error(`workspace: ${wsErr.message}`)
  const settings = { ...((ws?.settings as Record<string, unknown> | null) ?? {}), eval_fixture: true }
  const { error: upErr } = await admin.from('workspace').update({ name: WORKSPACE_NAME, settings }).eq('id', workspaceId)
  if (upErr) throw new Error(`workspace update: ${upErr.message}`)

  // A known zone (UTC), so a schedule case reaches its real decision instead
  // of stopping to ask which time zone the person is in.
  const { error: tzErr } = await admin.from('member').update({ time_zone: 'UTC' }).eq('user_id', userId).eq('workspace_id', workspaceId)
  if (tzErr) throw new Error(`member time_zone: ${tzErr.message}`)

  // No free tier (migration 243): the fixture holds a complimentary grant, the
  // same row the admin console's grant-subscription route writes, so its turns
  // pass the usage gate. Only once.
  const { data: sub, error: sErr } = await admin
    .from('subscriptions')
    .select('id')
    .eq('user_id', userId)
    .in('status', ['active', 'trialing'])
    .limit(1)
    .maybeSingle()
  if (sErr) throw new Error(`subscriptions: ${sErr.message}`)
  if (!sub) {
    const { error: gErr } = await admin.from('subscriptions').insert({
      user_id: userId,
      stripe_subscription_id: `granted_eval_fixture_${Date.now()}`,
      stripe_customer_id: null,
      status: 'active',
      current_period_start: new Date().toISOString(),
      current_period_end: null,
      cancel_at_period_end: false,
    })
    if (gErr) throw new Error(`subscriptions insert: ${gErr.message}`)
    const { data: plan, error: pErr } = await admin.from('ai_plan_definitions').select('id').eq('name', 'subscriber').single()
    if (pErr || !plan) throw new Error(`ai_plan_definitions: ${pErr?.message ?? 'no subscriber plan'}`)
    const { error: upPlanErr } = await admin
      .from('ai_user_plans')
      .upsert({ user_id: userId, plan_id: plan.id, is_active: true }, { onConflict: 'user_id' })
    if (upPlanErr) throw new Error(`ai_user_plans upsert: ${upPlanErr.message}`)
    console.error('granted the fixture a complimentary subscription')
  }

  const { data: existing, error: cErr } = await admin
    .from('chat_conversations')
    .select('id')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .eq('title', CONVERSATION_TITLE)
    .limit(1)
    .maybeSingle()
  if (cErr) throw new Error(`chat_conversations: ${cErr.message}`)
  let conversationId = existing?.id as string | undefined
  if (!conversationId) {
    const { data: created, error: insErr } = await admin
      .from('chat_conversations')
      .insert({ user_id: userId, workspace_id: workspaceId, title: CONVERSATION_TITLE })
      .select('id')
      .single()
    if (insErr || !created) throw new Error(`chat_conversations insert: ${insErr?.message ?? 'no row'}`)
    conversationId = created.id as string
  }

  if (process.argv.includes('--reset')) {
    const flows = await admin.from('flow').update({ enabled: false }).eq('workspace_id', workspaceId).eq('enabled', true).select('id')
    if (flows.error) throw new Error(`flow reset: ${flows.error.message}`)
    const approvals = await admin
      .from('tool_approval')
      .update({ status: 'expired', decided_at: new Date().toISOString() })
      .eq('workspace_id', workspaceId)
      .eq('status', 'pending')
      .select('id')
    if (approvals.error) throw new Error(`approval reset: ${approvals.error.message}`)
    const notes = await admin
      .from('document')
      .update({ status: 'archived' })
      .eq('workspace_id', workspaceId)
      .eq('kind', 'now')
      .neq('status', 'archived')
      .select('id')
    if (notes.error) throw new Error(`now reset: ${notes.error.message}`)
    console.error(`reset: ${flows.data?.length ?? 0} flow(s) switched off, ${approvals.data?.length ?? 0} approval(s) expired, ${notes.data?.length ?? 0} Now file(s) archived`)
  }

  console.log(`EVE_EVAL_USER_ID=${userId}`)
  console.log(`EVE_EVAL_WORKSPACE_ID=${workspaceId}`)
  console.log(`EVE_EVAL_CONVERSATION_ID=${conversationId}`)
}

main().catch((err) => {
  console.error(`[eval-fixture] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
