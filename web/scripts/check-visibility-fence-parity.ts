/**
 * PARITY CHECK for the visibility fence (src/lib/views/visibility-fence.ts):
 * for one member of one workspace, count what RLS shows them (a session client
 * signed in as that user) against what the fence shows them (the service-role
 * client plus the fence, the chat cards' path: runListQuery), for contacts,
 * companies, actions and captures, and print a pass/fail table.
 *
 * Manual and DEV only. It refuses any project but DEV (edrjddsxjoigpbecqgfb),
 * and PROD (bzfthjzyzevjokbuhqci) by name. It reads only; signing in as the
 * member mints a session through a magic-link token the admin API returns (no
 * email is sent). Not wired into CI.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/check-visibility-fence-parity.ts <user_id> <workspace_id>
 *
 * Exit code 0 when every count matches, 1 otherwise.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { fenceOf, runListQuery, type CardScope } from '../src/lib/chat-cards/server'
import type { CardListEntity } from '../src/lib/chat-cards/kinds'

const DEV_PROJECT = 'edrjddsxjoigpbecqgfb'
const PROD_PROJECT = 'bzfthjzyzevjokbuhqci'

const env: Record<string, string> = { ...(process.env as Record<string, string>) }
for (const f of ['.env.local', '.env.development.local']) {
  try {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?\s*$/)
      if (m && !(m[1] in env)) env[m[1]] = m[2]
    }
  } catch {
    /* file optional */
  }
}

const url = env.NEXT_PUBLIC_SUPABASE_URL ?? ''
if (url.includes(PROD_PROJECT)) throw new Error('refusing: this is PROD. The parity check runs on DEV only.')
if (!url.includes(DEV_PROJECT)) throw new Error(`refusing: not the DEV project (${url || 'no NEXT_PUBLIC_SUPABASE_URL'})`)

const [userId, workspaceId] = process.argv.slice(2)
if (!userId || !workspaceId) throw new Error('usage: tsx scripts/check-visibility-fence-parity.ts <user_id> <workspace_id>')

const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

/** A session client signed in as the member: RLS applies to everything it reads. */
async function signInAs(id: string): Promise<SupabaseClient> {
  const { data: user, error } = await admin.auth.admin.getUserById(id)
  if (error || !user.user?.email) throw new Error(`no user ${id} with an email: ${error?.message ?? 'missing email'}`)
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email: user.user.email })
  if (linkError) throw linkError
  const anon = createClient(url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data: session, error: otpError } = await anon.auth.verifyOtp({ type: 'magiclink', token_hash: link.properties.hashed_token })
  if (otpError || !session.session) throw new Error(`could not sign in as ${id}: ${otpError?.message ?? 'no session'}`)
  return createClient(url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${session.session.access_token}` } },
  })
}

/**
 * What the person's own list counts under RLS, with the same per-entity
 * defaults the views query engine adds (buildEntityQuery): no merged contacts,
 * top-level actions, no eval captures.
 */
async function rlsCount(client: SupabaseClient, entity: CardListEntity): Promise<number> {
  const table = { contact: 'contact', company: 'company', action: 'actions', capture: 'captures' }[entity as 'contact']
  const q = client.from(table).select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId)
  if (entity === 'contact') q.is('merged_into_contact_id', null)
  if (entity === 'action') q.is('parent_id', null)
  if (entity === 'capture') q.neq('is_eval', true)
  const { count, error } = await q
  if (error) throw new Error(`${entity} (RLS): ${error.message}`)
  return count ?? 0
}

async function main() {
  const asUser = await signInAs(userId)
  const scope: CardScope = { supabase: admin, workspaceId, userId }
  const fence = await fenceOf(scope)
  console.log(`member ${fence.memberId ?? '(none)'}${fence.isAdmin ? ' (owner/admin)' : ''}, ${fence.visibleTeamIds.length} visible teams`)

  const rows: Array<{ entity: string; rls: number; fence: number; ok: boolean }> = []
  for (const entity of ['contact', 'company', 'action', 'capture'] as const) {
    const rls = await rlsCount(asUser, entity)
    const fenced = (await runListQuery(scope, fence, entity, { filters: [] }, 1)).count
    rows.push({ entity, rls, fence: fenced, ok: rls === fenced })
  }
  console.table(rows.map((r) => ({ entity: r.entity, 'RLS (as user)': r.rls, 'fence (service)': r.fence, result: r.ok ? 'pass' : 'FAIL' })))
  const failed = rows.filter((r) => !r.ok)
  console.log(failed.length ? `FAIL: ${failed.map((r) => r.entity).join(', ')}` : 'pass: every count matches')
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
