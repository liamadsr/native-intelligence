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
 * research, enrichment, SEO data, prospecting, Studio, email, call notes and
 * recording, and members inviting people where the workspace allows it. No
 * check for any of them lives here: less code in front of production paths.
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
}

type DemoLookup = (workspaceId: string) => boolean | Promise<boolean>
// On globalThis, not in the module: a test that resets modules gets a fresh
// copy of this file and must still see the suite's answer.
const TEST_LOOKUP = Symbol.for('ni.demoWorkspaceLookupForTests')
const testLookup = (): DemoLookup | null => (globalThis as Record<symbol, unknown>)[TEST_LOOKUP] as DemoLookup | null ?? null

/**
 * TESTS ONLY (src/test/setup.ts): answer isDemoWorkspace without the
 * database. The suite's fake clients have no is_demo_workspace(), and this
 * check now sits in front of every costly call, so the setup file answers
 * "not a demo" for all of them; a test about a demo workspace passes its own
 * answer, and one about the real read passes null.
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
 * 'demo_workspace'), for work that runs in `workspaceId`: true when that
 * workspace is known NOT to be a demo. Their place covers the demo workspace
 * only; anywhere else they hold no seat. The SQL gate is per person and
 * cannot see this, so every caller that knows where the work runs asks here.
 *
 * Only positive evidence refuses: no workspace named, or a flag that could
 * not be read, is not "outside". Such work is metered on the demo workspace
 * like the rest of a visitor's, and bounded only where an admin set a cap.
 */
export async function demoVisitorOutside(
  row: { reason?: string | null } | null | undefined,
  workspaceId: string | null | undefined,
): Promise<boolean> {
  if (row?.reason !== DEMO_USAGE_REASON || !workspaceId) return false
  return (await readDemoWorkspace(workspaceId)) === false
}
