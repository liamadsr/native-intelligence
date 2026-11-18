/**
 * Demo workspaces (migration 669): a workspace an admin flagged in
 * `demo_workspace`, where invited outsiders look around made-up data.
 *
 * What the flag changes, and where each part lives:
 *   - no seat needed for its members and guests, inside it only
 *     (src/lib/billing/access.ts, the dashboard layout, check_ai_usage_limit;
 *     `demoVisitorOutside` below is the "inside it only" half, asked by every
 *     usage check that knows where its work runs);
 *   - those visitors' AI spend is metered on the flag row, with NO cap by
 *     default; an admin may set one there as the off switch (the SQL gate
 *     and its ledger);
 *   - nothing real may be connected or linked to it: a mail, calendar or
 *     contacts account, an MCP server, a Slack workspace, a Stripe account, a
 *     business number, a shared email (refused where a connect starts, and by
 *     the `refuse_in_demo_workspace` triggers), and the desktop app's
 *     calendar sync is not taken there;
 *   - it is put back to its made-up content every night (./reset.ts).
 *
 * Everything else works there as in any workspace (the owner's decisions,
 * 2026-11-18): texts, phone calls, the cloud browser, coding runs, web
 * research, enrichment, SEO data, prospecting, Studio, call notes and
 * recording, and members inviting people where the workspace allows it. No
 * check for any of them lives here: less code in front of production paths.
 * (Mail the app itself sends works too. A person's own mailbox and calendar
 * do not answer there: src/lib/crm/email-client.ts, calendar-here.ts.)
 *
 * And a VISITOR (a member or guest with nothing of their own) is kept to the
 * demo workspace for everything, not only AI: `demoVisitorWorkspace` below is
 * asked by the request helpers (src/lib/api-auth.ts, src/lib/workspace.ts),
 * the chat mint, the tools' workspace routing, the MCP connector and every
 * connect start. A visitor connects nothing, anywhere.
 *
 * Only an admin flags a workspace, with a row in `demo_workspace` (the table
 * is the service role's alone). This module never writes it.
 *
 * Server-side only in effect: the flag is read with the service client
 * (loaded when first needed, so the constants here stay importable anywhere).
 */

/** Where the gates send a visitor whose active workspace is not their demo workspace. */
export const DEMO_ENTER_PATH = '/account/enter-demo'

/** check_ai_usage_limit's reasons for a demo workspace's visitor (migration 669). */
export const DEMO_USAGE_REASON = 'demo_workspace'
export const DEMO_CAP_REACHED_REASON = 'demo_cost_limit_exceeded'
/** Added by checkUsageLimits: the visitor asked for AI outside the demo workspace. */
export const DEMO_ONLY_REASON = 'demo_workspace_only'

/** Only where an admin set a cap on the flag row (`ai_cap_usd`): there is none by default. */
export const DEMO_CAP_REACHED_MESSAGE =
  'This demo workspace has used its AI budget for the month. Everything else still works, and the assistant is back on the 1st.'
export const DEMO_ONLY_MESSAGE =
  'Your access covers the demo workspace only. Switch back to it, or start a trial to use your own workspace.'

/** What a person reads where a demo workspace refuses something. */
export const DEMO_OFF = {
  connector: 'Real accounts cannot be connected to or shared into the demo workspace.',
} as const

/** The triggers' refusal (`refuse_in_demo_workspace`), as PostgREST reports it. */
export function isDemoWorkspaceDbRefusal(error: { message?: unknown; hint?: unknown } | null | undefined): boolean {
  if (!error) return false
  return error.hint === 'DEMO_WORKSPACE' || (typeof error.message === 'string' && error.message.startsWith('demo_workspace:'))
}

const TTL_MS = 60_000
const cache = new Map<string, { demo: boolean; at: number }>()

/** For tests, and after a reset. */
export function clearDemoWorkspaceCache(): void {
  cache.clear()
  visitorCache.clear()
  anyDemo = null
}

type DemoLookup = (workspaceId: string) => boolean | Promise<boolean>
// On globalThis, not in the module: a test that resets modules gets a fresh
// copy of this file and must still see the suite's answer.
const TEST_LOOKUP = Symbol.for('ni.demoWorkspaceLookupForTests')
const testLookup = (): DemoLookup | null => (globalThis as Record<symbol, unknown>)[TEST_LOOKUP] as DemoLookup | null ?? null

/**
 * TESTS ONLY (src/test/setup.ts): answer isDemoWorkspace without the
 * database. The suite's fake clients have no is_demo_workspace(), and this
 * check sits in the connect paths and the usage checks, so the setup file
 * answers "not a demo" for all of them; a test about a demo workspace passes
 * its own answer, and one about the real read passes null.
 */
export function setDemoWorkspaceLookupForTests(lookup: DemoLookup | null): void {
  ;(globalThis as Record<symbol, unknown>)[TEST_LOOKUP] = lookup
  cache.clear()
}

/**
 * The flag, as read: true, false, or null when it could not be read.
 *
 * Always read by the service role (is_demo_workspace() is its alone,
 * migration 669), whoever is asking: the answer is then the same for every
 * caller, so one cached answer per workspace is true for everyone. Cached per
 * process for a minute; an unreadable answer is never cached.
 */
export async function readDemoWorkspace(workspaceId: string | null | undefined): Promise<boolean | null> {
  if (!workspaceId) return false
  const forTests = testLookup()
  if (forTests) {
    try {
      return await forTests(workspaceId)
    } catch {
      return null
    }
  }
  const hit = cache.get(workspaceId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.demo
  try {
    const { getServiceClient } = await import('@/lib/supabase/service')
    const { data, error } = await getServiceClient().rpc('is_demo_workspace', { p_workspace_id: workspaceId })
    if (error) {
      // Before migration 669 there are no demo workspaces at all.
      if (error.code === 'PGRST202' || error.code === '42883') {
        cache.set(workspaceId, { demo: false, at: Date.now() })
        return false
      }
      console.error('[demo-workspace] flag read failed:', error.message)
      return null
    }
    const demo = data === true
    cache.set(workspaceId, { demo, at: Date.now() })
    return demo
  } catch (err) {
    console.error('[demo-workspace] flag read failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * True for a flagged workspace. Never throws.
 *
 * AN UNREADABLE FLAG IS "NOT A DEMO" (logged above), everywhere. A read
 * error must never change what a workspace that is not flagged gets. For a
 * workspace that IS a demo, the app-side refusals of a connect are then
 * skipped for as long as the read fails; what still holds is in the
 * database, not here: the triggers that refuse linking anything real, and
 * the AI cap where an admin set one (check_ai_usage_limit).
 */
export async function isDemoWorkspace(workspaceId: string | null | undefined): Promise<boolean> {
  return (await readDemoWorkspace(workspaceId)) === true
}

/**
 * A usage row that let a demo workspace's visitor in (reason
 * 'demo_workspace'), for work that runs in `workspaceId`: true unless that
 * workspace is known to BE a demo. Their place covers the demo workspace
 * only; anywhere else they hold no seat. The SQL gate is per person and
 * cannot see this, so every usage check asks here with where its work runs.
 *
 * REFUSES WHEN IT CANNOT TELL: no workspace named, or a flag that could not
 * be read, is "outside". A check that forgot to say where its work runs then
 * stops a visitor (a bug that shows) instead of letting them spend anywhere
 * (one that does not). This never touches anyone but a demo visitor: every
 * other reason returns false before anything is read.
 */
export async function demoVisitorOutside(
  row: { reason?: string | null } | null | undefined,
  workspaceId: string | null | undefined,
): Promise<boolean> {
  if (row?.reason !== DEMO_USAGE_REASON) return false
  if (!workspaceId) return true
  return (await readDemoWorkspace(workspaceId)) !== true
}

// ── Who is a visitor ───────────────────────────────────────────────────────

type VisitorLookup = (userId: string) => string | null | Promise<string | null>
const TEST_VISITOR_LOOKUP = Symbol.for('ni.demoVisitorLookupForTests')
const testVisitorLookup = (): VisitorLookup | null => (globalThis as Record<symbol, unknown>)[TEST_VISITOR_LOOKUP] as VisitorLookup | null ?? null

/** TESTS ONLY (src/test/setup.ts): answer demoVisitorWorkspace without the database; null for the real read. */
export function setDemoVisitorLookupForTests(lookup: VisitorLookup | null): void {
  ;(globalThis as Record<symbol, unknown>)[TEST_VISITOR_LOOKUP] = lookup
  visitorCache.clear()
  anyDemo = null
}

const visitorCache = new Map<string, { workspaceId: string | null; at: number }>()
let anyDemo: { exists: boolean; at: number } | null = null

/**
 * Does any demo workspace exist? For a caller that would otherwise ask the
 * database about one person on every page render (the trial wall): with no
 * demo workspace at all, nobody can be a visitor. True when it cannot tell.
 */
export async function anyDemoWorkspaceExists(): Promise<boolean> {
  // Under the suite's lookups the database is not asked: let the caller go on.
  if (testVisitorLookup()) return true
  try {
    return await anyDemoWorkspace()
  } catch {
    return true
  }
}

/** One small read a minute per process; with none, nobody is ever asked about. */
async function anyDemoWorkspace(): Promise<boolean> {
  if (anyDemo && Date.now() - anyDemo.at < TTL_MS) return anyDemo.exists
  const { getServiceClient } = await import('@/lib/supabase/service')
  const { data, error } = await getServiceClient().from('demo_workspace').select('workspace_id').limit(1)
  if (error) {
    // Before migration 669 the table is not there: no demo workspaces.
    if (error.code === '42P01' || error.code === 'PGRST205') {
      anyDemo = { exists: false, at: Date.now() }
      return false
    }
    throw new Error(error.message)
  }
  anyDemo = { exists: ((data as unknown[] | null) ?? []).length > 0, at: Date.now() }
  return anyDemo.exists
}

/**
 * The demo workspace this person is a VISITOR of, else null.
 *
 * A visitor is a member or guest of a demo workspace who has nothing of
 * their own: the usage gate's own answer for them is the demo branch
 * (check_ai_usage_limit, migration 669). A person in a demo workspace who
 * holds a seat, a plan, credits or a granted free period is not one.
 *
 * This is the fence for everything that is NOT an AI call: a visitor's
 * requests run in the demo workspace and nowhere else (src/lib/api-auth.ts,
 * src/lib/workspace.ts), and a visitor connects nothing, anywhere. Without
 * it, "free inside the demo" is free everywhere a paid surface has its own
 * per-workspace budget (a workspace of their own making has a fresh one).
 *
 * Cached per person for a minute. With no demo workspace at all it costs one
 * shared read a minute. A read that fails answers null and is logged: the
 * fence then does not hold for that request, and no one who is not a visitor
 * is ever refused by it.
 */
export async function demoVisitorWorkspace(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null
  const forTests = testVisitorLookup()
  if (forTests) return forTests(userId)
  const hit = visitorCache.get(userId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.workspaceId
  try {
    if (!(await anyDemoWorkspace())) return null
    const { getServiceClient } = await import('@/lib/supabase/service')
    const service = getServiceClient()
    const seat = await service.rpc('demo_seat_workspace', { p_user_id: userId })
    if (seat.error) throw new Error(seat.error.message)
    let workspaceId: string | null = typeof seat.data === 'string' && seat.data ? seat.data : null
    if (workspaceId) {
      const gate = await service.rpc('check_ai_usage_limit', { p_user_id: userId, p_chatgpt_plan: true })
      if (gate.error) throw new Error(gate.error.message)
      const row = (Array.isArray(gate.data) ? gate.data[0] : gate.data) as { reason?: string | null } | null | undefined
      if (row?.reason !== DEMO_USAGE_REASON && row?.reason !== DEMO_CAP_REACHED_REASON) workspaceId = null
    }
    visitorCache.set(userId, { workspaceId, at: Date.now() })
    return workspaceId
  } catch (err) {
    console.error('[demo-workspace] visitor read failed:', err instanceof Error ? err.message : err)
    return null
  }
}
