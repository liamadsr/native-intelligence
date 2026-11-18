/**
 * A demo workspace full of made-up data: for README screenshots, and for
 * anyone who wants to look around a fresh install.
 *
 * Creates, or finds, one demo person and fills their workspace:
 *   - the auth user demo@native-intelligence.test (a reserved .test domain, so
 *     it can never be a real person), with no password;
 *   - their own workspace (the signup trigger makes it, with its General team
 *     and that team's board columns), renamed "Fernhill Studio" (a made-up
 *     brand and web design studio) and marked `settings.demo_workspace = true`;
 *   - checked to have that person as its ONLY member;
 *   - a complimentary subscription (a granted_ row, as the admin console
 *     grants), so the trial wall doesn't stop the dashboard;
 *   - made-up work: one project with two milestones, three labels, twelve
 *     tasks across the board, three companies with seven contacts and their
 *     timelines, one finished meeting capture (summary, transcript, attendees,
 *     the tasks and decisions it produced), four calendar events this week,
 *     two documents, and 51 knowledge claims linked to all of it (what the
 *     Knowledge page's Graph draws), learned over the last eight weeks.
 * Every person, company, email and number in it is made up: emails are at
 * `.example` domains and phones are in the 555-01xx range.
 *
 * Running it again adds only what is missing. Calendar events move to the
 * current week each run.
 *
 *   --reset   first delete the rows this script seeded in the demo workspace
 *             (and nothing else), then seed them again.
 *   --clear-activity
 *             first delete what using the demo leaves behind in the demo
 *             workspace: the demo person's chat conversations and every
 *             capture the script didn't seed, with what came from them
 *             (see clearActivity). The browser keeps the main chat too, under
 *             localStorage `ni-chat:<workspace id>`.
 *   --link    also print a one-time sign-in link for the demo person that
 *             works against a local `next dev` on http://localhost:3000
 *             (src/app/auth/demo-link/route.ts redeems it). Open it in the
 *             browser you want signed in; it lands on /account.
 *   --port=N  the port your `next dev` runs on, for --link (default 3000).
 *
 * The content itself lives in src/lib/demo/seed.ts. A demo workspace that
 * outsiders are invited into (production's included) is a different thing:
 * an admin flags it in `demo_workspace` (migration 667) and the app's own
 * nightly job puts it back (src/lib/demo/reset.ts). This script is not how
 * that workspace is seeded, and it still refuses production.
 *
 * DEV OR LOCAL ONLY: refuses any Supabase URL but DEV's or one on this
 * machine (localhost / 127.0.0.1), and always refuses PROD. Writes only the
 * demo workspace's rows. Run from web/:
 *   node node_modules/.bin/tsx scripts/demo-workspace.ts [--reset] [--link] [--port=N]
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { DEMO_USER_EMAIL, PROD_SUPABASE_REF, demoSupabaseTarget } from '../src/lib/demo/demo-workspace-guard'
import {
  LABELS,
  PERSON_NAME,
  PROJECT_NAME,
  SEED,
  WORKSPACE_NAME,
  check,
  claimIds,
  deleteClaimLinks,
  loadSeedContext,
  one,
  resetSeeded,
  seedDemoContent,
  type Ctx,
} from '../src/lib/demo/seed'

const PORT_ARG = process.argv.find((a) => a.startsWith('--port='))?.slice('--port='.length)
const LOCAL_APP_ORIGIN = `http://localhost:${PORT_ARG && /^\d{2,5}$/.test(PORT_ARG) ? PORT_ARG : '3000'}`

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

// ── Clearing what screenshots leave behind ──────────────────────────────────

/**
 * --clear-activity: remove what using the demo leaves behind, so the next
 * screenshot starts clean. Only in the demo workspace, re-checked here by id
 * and `settings.demo_workspace`:
 *   - the demo person's chat conversations there (messages, home turns, relays,
 *     memory epochs and proposed changes go with them by foreign key; pending
 *     tool approvals and chat agent runs, which only hold the id, are deleted
 *     first);
 *   - every capture there that the script didn't seed (participants,
 *     decisions, labels, chunks, references, extraction passes, directives,
 *     lens findings and proposed changes go with it by foreign key; tasks it
 *     produced, comments on it, timeline rows pointing at it, and claims
 *     extracted from it or from the chats, with their links, are deleted first
 *     because nothing cascades to them).
 * Seeded rows are never touched.
 */
/** The `ref` a legacy JWT service-role key was minted for, or null (a new-style key, or not a JWT). */
function serviceKeyRef(key: string): string | null {
  const parts = key.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { ref?: unknown }
    return typeof payload.ref === 'string' ? payload.ref : null
  } catch {
    return null
  }
}

async function clearActivity(ctx: Ctx): Promise<void> {
  const { admin, workspaceId, userId } = ctx
  const ws = one('workspace', await admin.from('workspace').select('id, settings').eq('id', workspaceId).single())
  if (ws.id !== workspaceId || (ws.settings as Record<string, unknown> | null)?.demo_workspace !== true) {
    throw new Error('refusing --clear-activity: the workspace is not marked settings.demo_workspace = true')
  }
  const inChunks = async (label: string, list: string[], run: (chunk: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>) => {
    let n = 0
    for (let i = 0; i < list.length; i += 100) n += ((check(label, await run(list.slice(i, i + 100))) as unknown[] | null) ?? []).length
    return n
  }

  const convs = check('chat_conversations', await admin.from('chat_conversations').select('id').eq('workspace_id', workspaceId).eq('user_id', userId))
  const convIds = (convs ?? []).map((c) => c.id as string)
  const caps = check('captures', await admin.from('captures').select('id, metadata').eq('workspace_id', workspaceId))
  const capIds = (caps ?? []).filter((c) => (c.metadata as Record<string, unknown> | null)?.demo_seed !== true).map((c) => c.id as string)

  // Claims that came from those captures or chats (never a seeded claim).
  const seeded = new Set(claimIds(workspaceId))
  const fromSources = new Set<string>()
  for (const [type, list] of [['capture', capIds], ['conversation', convIds]] as const) {
    for (let i = 0; i < list.length; i += 100) {
      const rows = check('claim_source', await admin.from('claim_source').select('claim_id').eq('workspace_id', workspaceId).eq('source_type', type).in('source_id', list.slice(i, i + 100)))
      for (const r of rows ?? []) if (!seeded.has(r.claim_id as string)) fromSources.add(r.claim_id as string)
    }
  }
  const derivedClaims = [...fromSources]
  const claimLinks = await deleteClaimLinks(admin, workspaceId, derivedClaims)
  const claims = await inChunks('claim delete', derivedClaims, (c) => admin.from('claim').delete().eq('workspace_id', workspaceId).in('id', c).select('id'))

  const tasks = await inChunks('actions delete', capIds, (c) =>
    admin.from('actions').delete().eq('workspace_id', workspaceId).in('source_capture_id', c).select('id'),
  )
  const comments = await inChunks('comment delete', capIds, (c) => admin.from('comment').delete().eq('commentable_type', 'capture').in('commentable_id', c).select('id'))
  const timeline = await inChunks('contact_interaction delete', capIds, (c) =>
    admin.from('contact_interaction').delete().eq('workspace_id', workspaceId).eq('reference_type', 'capture').in('reference_id', c).select('id'),
  )
  const links =
    (await inChunks('entity_link delete', capIds, (c) => admin.from('entity_link').delete().eq('workspace_id', workspaceId).eq('target_type', 'capture').in('target_id', c).select('id'))) +
    (await inChunks('entity_link delete', convIds, (c) => admin.from('entity_link').delete().eq('workspace_id', workspaceId).eq('target_type', 'conversation').in('target_id', c).select('id')))
  const approvals = await inChunks('tool_approval delete', convIds, (c) => admin.from('tool_approval').delete().eq('workspace_id', workspaceId).in('conversation_id', c).select('id'))
  const runs = await inChunks('agent_run delete', convIds, (c) => admin.from('agent_run').delete().eq('workspace_id', workspaceId).in('chat_conversation_id', c).select('id'))

  const captures = await inChunks('captures delete', capIds, (c) => admin.from('captures').delete().eq('workspace_id', workspaceId).in('id', c).select('id'))
  const conversations = await inChunks('chat_conversations delete', convIds, (c) =>
    admin.from('chat_conversations').delete().eq('workspace_id', workspaceId).eq('user_id', userId).in('id', c).select('id'),
  )
  console.error(
    `clear-activity: deleted ${conversations} conversation(s), ${captures} capture(s), ${tasks} task(s) from them, ${claims} claim(s) ` +
      `(${claimLinks + links} link(s)), ${comments} comment(s), ${timeline} timeline row(s), ${approvals} approval(s), ${runs} agent run(s)`,
  )
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const root = resolve(__dirname, '..')
  loadEnvFile(resolve(root, '.env.development.local'))
  loadEnvFile(resolve(root, '.env.local'))
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const target = demoSupabaseTarget(url)
  if (!target) {
    throw new Error("refusing: NEXT_PUBLIC_SUPABASE_URL is neither DEV's Supabase nor a local one; the demo workspace lives on DEV or local only")
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set')
  if (serviceKeyRef(key) === PROD_SUPABASE_REF) {
    throw new Error("refusing: SUPABASE_SERVICE_ROLE_KEY is PROD's (a tunnel or proxy to PROD looks local by URL alone)")
  }
  const admin = createClient(url, key, { auth: { persistSession: false } })
  console.error(`[demo-workspace] Supabase: ${target === 'dev' ? 'DEV' : 'local'}`)

  let userId = await findUserId(admin, DEMO_USER_EMAIL)
  const createdNow = !userId
  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({
      email: DEMO_USER_EMAIL,
      email_confirm: true,
      user_metadata: { full_name: PERSON_NAME },
    })
    if (error || !data.user) throw new Error(`createUser: ${error?.message ?? 'no user'}`)
    userId = data.user.id
    console.error(`created ${DEMO_USER_EMAIL} (${userId})`)
  }

  const memberships = check('member', await admin.from('member').select('id, workspace_id').eq('user_id', userId))
  if (!memberships || memberships.length !== 1) {
    throw new Error(`expected the demo person in exactly one workspace, found ${memberships?.length ?? 0}`)
  }
  const workspaceId = memberships[0].workspace_id as string
  const memberId = memberships[0].id as string

  const members = check('member', await admin.from('member').select('user_id').eq('workspace_id', workspaceId))
  if (!members || members.length !== 1 || members[0].user_id !== userId) {
    throw new Error('the demo workspace has another member: refusing to seed it')
  }

  // The flag is set once, on the run that made the demo person, and required
  // on every run after: a workspace that isn't already marked is never written.
  const ws = check('workspace', await admin.from('workspace').select('settings').eq('id', workspaceId).single())
  const current = (ws?.settings as Record<string, unknown> | null) ?? {}
  if (!createdNow && current.demo_workspace !== true) {
    throw new Error('refusing: the demo person\'s workspace is not marked settings.demo_workspace = true')
  }
  const settings = { ...current, demo_workspace: true }
  check('workspace update', await admin.from('workspace').update({ name: WORKSPACE_NAME, settings }).eq('id', workspaceId))

  // Past onboarding, in a known time zone, so /account opens on the dashboard.
  const me = one('member', await admin.from('member').select('onboarding_completed_at, time_zone').eq('id', memberId).single())
  const memberPatch: Record<string, unknown> = {}
  if (!me.onboarding_completed_at) memberPatch.onboarding_completed_at = new Date().toISOString()
  if (!me.time_zone) memberPatch.time_zone = 'America/Los_Angeles'
  if (Object.keys(memberPatch).length > 0) check('member update', await admin.from('member').update(memberPatch).eq('id', memberId))

  await grantSubscription(admin, userId)

  const ctx: Ctx = await loadSeedContext(admin, { workspaceId, userId, memberId })

  if (process.argv.includes('--clear-activity')) await clearActivity(ctx)
  if (process.argv.includes('--reset')) await resetSeeded(ctx)

  await seedDemoContent(ctx)

  await printSummary(ctx)

  if (process.argv.includes('--link')) await printLink(admin)
}

async function grantSubscription(admin: SupabaseClient, userId: string): Promise<void> {
  // No free tier: the demo holds a complimentary grant, the same row the admin
  // console's grant-subscription route writes. Only once.
  const sub = check(
    'subscriptions',
    await admin.from('subscriptions').select('id').eq('user_id', userId).in('status', ['active', 'trialing']).limit(1).maybeSingle(),
  )
  if (sub) return
  check(
    'subscriptions insert',
    await admin.from('subscriptions').insert({
      user_id: userId,
      stripe_subscription_id: `granted_demo_workspace_${Date.now()}`,
      stripe_customer_id: null,
      status: 'active',
      current_period_start: new Date().toISOString(),
      current_period_end: null,
      cancel_at_period_end: false,
    }),
  )
  const plan = one('ai_plan_definitions', await admin.from('ai_plan_definitions').select('id').eq('name', 'subscriber').single())
  check(
    'ai_user_plans upsert',
    await admin.from('ai_user_plans').upsert({ user_id: userId, plan_id: plan.id, is_active: true }, { onConflict: 'user_id' }),
  )
  console.error('granted the demo person a complimentary subscription')
}

async function printSummary(ctx: Ctx): Promise<void> {
  const { admin, workspaceId, userId } = ctx
  const count = async (label: string, q: PromiseLike<{ count: number | null; error: { message: string } | null }>) => {
    const { count: n, error } = await q
    if (error) throw new Error(`${label}: ${error.message}`)
    return n ?? 0
  }
  const head = { count: 'exact' as const, head: true }
  const captures = check('captures', await admin.from('captures').select('id').eq('workspace_id', workspaceId).contains('metadata', SEED))
  const captureIds = (captures ?? []).map((c) => c.id as string)
  const rows: [string, number][] = [
    ['tasks (actions)', await count('actions', admin.from('actions').select('id', head).eq('workspace_id', workspaceId).contains('context_data', SEED))],
    ['projects', await count('projects', admin.from('projects').select('id', head).eq('workspace_id', workspaceId).eq('name', PROJECT_NAME))],
    ['labels', await count('label', admin.from('label').select('id', head).eq('workspace_id', workspaceId).in('name', LABELS.map((l) => l.name)))],
    ['companies', await count('company', admin.from('company').select('id', head).eq('workspace_id', workspaceId).contains('metadata', SEED))],
    ['contacts', await count('contact', admin.from('contact').select('id', head).eq('workspace_id', workspaceId).contains('metadata', SEED))],
    ['timeline rows', await count('contact_interaction', admin.from('contact_interaction').select('id', head).eq('workspace_id', workspaceId).contains('metadata', SEED))],
    ['captures', captureIds.length],
    ['decisions', captureIds.length ? await count('decision', admin.from('decision').select('id', head).in('capture_id', captureIds)) : 0],
    ['capture attendees', captureIds.length ? await count('capture_participant', admin.from('capture_participant').select('id', head).in('capture_id', captureIds)) : 0],
    ['calendar events', await count('local_calendar_event', admin.from('local_calendar_event').select('id', head).eq('user_id', userId).like('external_id', 'demo-%'))],
    ['documents', await count('document', admin.from('document').select('id', head).eq('workspace_id', workspaceId).contains('frontmatter', SEED))],
    ['claims', await count('claim', admin.from('claim').select('id', head).eq('workspace_id', workspaceId).in('id', claimIds(workspaceId)))],
    ['claim sources', await count('claim_source', admin.from('claim_source').select('id', head).in('claim_id', claimIds(workspaceId)))],
    ['claim links', await count('entity_link', admin.from('entity_link').select('id', head).eq('workspace_id', workspaceId).eq('source_type', 'claim').in('source_id', claimIds(workspaceId)))],
  ]
  console.log(`demo workspace: ${WORKSPACE_NAME} (${workspaceId})`)
  console.log(`demo person:    ${DEMO_USER_EMAIL} (${userId})`)
  for (const [label, n] of rows) console.log(`  ${label.padEnd(18)} ${n}`)
}

/**
 * A one-time sign-in link for a local `next dev` (:3000, or --port). The magic-link
 * token comes from the service role (no email is sent); the app's
 * /auth/demo-link route redeems it, only under next dev, on localhost, for
 * the demo person. Supabase's own action_link isn't used: it would leave the
 * session in a URL fragment, which the app's PKCE sign-in doesn't accept.
 */
async function printLink(admin: SupabaseClient): Promise<void> {
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: DEMO_USER_EMAIL })
  if (error || !data.properties?.hashed_token) throw new Error(`generateLink: ${error?.message ?? 'no token'}`)
  const link = new URL('/auth/demo-link', LOCAL_APP_ORIGIN)
  link.searchParams.set('token_hash', data.properties.hashed_token)
  console.log('')
  console.log(`sign in (one use; expires with the project's OTP expiry, an hour by default; needs next dev on ${LOCAL_APP_ORIGIN}):`)
  console.log(link.toString())
}

main().catch((err) => {
  console.error(`[demo-workspace] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
