/**
 * Demo workspaces (migration 669): a workspace an admin flagged in
 * `demo_workspace`, where invited outsiders look around made-up data.
 *
 * What the flag changes, and where each part lives:
 *   - no seat needed for its members and guests, inside it only
 *     (src/lib/billing/access.ts, the dashboard layout, check_ai_usage_limit);
 *   - one small monthly AI cap shared by those visitors (the SQL gate and its
 *     ledger; `checkUsageLimits` adds the "inside it only" check per request);
 *   - the surfaces that bill a third party per use are off (the callers of
 *     `refuseInDemoWorkspace` below);
 *   - nothing real may be linked to it (the `refuse_in_demo_workspace`
 *     triggers, with the friendlier refusals in the routes);
 *   - it is put back to its made-up content every night (./reset.ts).
 *
 * Only an admin flags a workspace, with a row in `demo_workspace` (the table
 * is the service role's alone). This module never writes it.
 *
 * No `server-only` import and no `@/` alias: scripts/demo-workspace.ts runs
 * this under tsx.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** Where the gates send a visitor whose active workspace is not their demo workspace. */
export const DEMO_ENTER_PATH = '/account/enter-demo'

/** check_ai_usage_limit's reasons for a demo workspace's visitor (migration 669). */
export const DEMO_USAGE_REASON = 'demo_workspace'
export const DEMO_CAP_REACHED_REASON = 'demo_cost_limit_exceeded'
/** Added by checkUsageLimits: the visitor asked for AI outside the demo workspace. */
export const DEMO_ONLY_REASON = 'demo_workspace_only'

export const DEMO_CAP_REACHED_MESSAGE =
  'This demo workspace has used its AI budget for the month. Everything else still works, and the assistant is back on the 1st.'
export const DEMO_ONLY_MESSAGE =
  'Your access covers the demo workspace only. Switch back to it, or start a trial to use your own workspace.'

/** The costly surfaces a demo workspace switches off, with the words a person reads. */
export const DEMO_OFF = {
  sms: 'Text messages are switched off in the demo workspace.',
  phone_call: 'Phone calls are switched off in the demo workspace.',
  studio_generation: 'Generating video, images and sound is switched off in the demo workspace.',
  enrichment: 'Enrichment is switched off in the demo workspace.',
  company_research: 'Company research is switched off in the demo workspace.',
  cloud_browser: 'The cloud browser is switched off in the demo workspace.',
  coding_sandbox: 'Coding runs are switched off in the demo workspace.',
  seo: 'SEO lookups that cost money are switched off in the demo workspace.',
  prospecting: 'Prospecting is switched off in the demo workspace.',
  outbound_email: 'Sending email is switched off in the demo workspace.',
  call_notes: 'Call notes and recording are switched off in the demo workspace.',
  web_search: 'Web research is switched off in the demo workspace.',
  connector: 'Real accounts cannot be connected to or shared into the demo workspace.',
} as const

export type DemoOffSurface = keyof typeof DEMO_OFF

/** Thrown by refuseInDemoWorkspace. `code` is stable; `message` is for a person. */
export class DemoWorkspaceRefusal extends Error {
  readonly code = 'DEMO_WORKSPACE'
  constructor(readonly surface: DemoOffSurface) {
    super(DEMO_OFF[surface])
    this.name = 'DemoWorkspaceRefusal'
  }
}

export function isDemoWorkspaceRefusal(err: unknown): err is DemoWorkspaceRefusal {
  return err instanceof Error && (err as { code?: unknown }).code === 'DEMO_WORKSPACE'
}

/** The triggers' refusal (`refuse_in_demo_workspace`), as PostgREST reports it. */
export function isDemoWorkspaceDbRefusal(error: { message?: unknown; hint?: unknown } | null | undefined): boolean {
  if (!error) return false
  return error.hint === 'DEMO_WORKSPACE' || (typeof error.message === 'string' && error.message.startsWith('demo_workspace:'))
}

/** A client, or how to get one: built only when the flag is really read (a cached answer needs none). */
export type DemoClient = SupabaseClient | (() => SupabaseClient)

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
 * True for a flagged workspace. Reads `demo_workspace` through
 * is_demo_workspace(), so it works on a member's own client and on the
 * service client. Cached per process for a minute: the flag changes by hand,
 * rarely, and this sits in front of every costly call.
 *
 * FAIL CLOSED is the caller's choice: a failed read THROWS here, and
 * `refuseInDemoWorkspace` lets that through, so a costly call never runs on
 * "could not tell". A caller that only decorates the UI should catch.
 */
export async function isDemoWorkspace(client: DemoClient, workspaceId: string | null | undefined): Promise<boolean> {
  if (!workspaceId) return false
  const forTests = testLookup()
  if (forTests) return forTests(workspaceId)
  const hit = cache.get(workspaceId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.demo
  const supabase = typeof client === 'function' ? client() : client
  const { data, error } = await supabase.rpc('is_demo_workspace', { p_workspace_id: workspaceId })
  if (error) {
    // Before migration 669 there are no demo workspaces at all.
    if (error.code === 'PGRST202' || error.code === '42883') {
      cache.set(workspaceId, { demo: false, at: Date.now() })
      return false
    }
    throw new Error(`is_demo_workspace: ${error.message}`)
  }
  const demo = data === true
  cache.set(workspaceId, { demo, at: Date.now() })
  return demo
}

/**
 * The one gate in front of a costly surface: throws DemoWorkspaceRefusal when
 * `workspaceId` is a demo workspace. Put it where the workspace is known and
 * every spend passes.
 */
export async function refuseInDemoWorkspace(
  supabase: DemoClient,
  workspaceId: string | null | undefined,
  surface: DemoOffSurface,
): Promise<void> {
  if (await isDemoWorkspace(supabase, workspaceId)) throw new DemoWorkspaceRefusal(surface)
}
