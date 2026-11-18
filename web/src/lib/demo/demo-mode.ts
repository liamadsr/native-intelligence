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
/** How long an answer that could not be read stands in: long enough that a database blip is not re-asked (and logged) on every request, short enough to heal. */
const FAILED_TTL_MS = 10_000
/**
 * How long one read may take. These reads are shared by everyone asking at
 * once, and they sit in front of nearly every request: one that stalls (the
 * service client has no time limit of its own) would hold them all until the
 * connection gave up, minutes later. Past this it is an unreadable answer,
 * like any other failure.
 */
export const READ_TIMEOUT_MS = 4_000

/**
 * `query`'s answer, or a rejection once READ_TIMEOUT_MS has passed. The
 * request itself is cancelled too where the client can (a PostgREST builder's
 * `abortSignal`); where it cannot, it is left to end by itself, unheard.
 */
function inTime<T>(query: PromiseLike<T>): Promise<T> {
  const stop = new AbortController()
  const builder = query as PromiseLike<T> & { abortSignal?: (signal: AbortSignal) => PromiseLike<T> }
  const running = typeof builder.abortSignal === 'function' ? builder.abortSignal(stop.signal) : query
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no answer in ${READ_TIMEOUT_MS} ms`))
      stop.abort()
    }, READ_TIMEOUT_MS)
    Promise.resolve(running).then(
      (answer) => {
        clearTimeout(timer)
        resolve(answer)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/** The most entries either cache holds; past it the oldest go. A workspace or a person costs one small entry. */
const MAX_ENTRIES = 5_000

/**
 * A small cache for one kind of read: answers kept for a while, the oldest
 * dropped past MAX_ENTRIES, and one read shared by everyone who asks for the
 * same key while it is in flight.
 */
class ReadCache<V> {
  private readonly entries = new Map<string, { value: V; until: number }>()
  private readonly inFlight = new Map<string, Promise<V>>()

  get(key: string): { value: V } | null {
    const hit = this.entries.get(key)
    if (!hit) return null
    if (Date.now() >= hit.until) {
      this.entries.delete(key)
      return null
    }
    return { value: hit.value }
  }

  set(key: string, value: V, ttlMs: number): void {
    this.entries.delete(key)
    this.entries.set(key, { value, until: Date.now() + ttlMs })
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  /** The cached answer, else `read()`'s, which stores its own answer with `set`. Concurrent askers share one read. */
  async load(key: string, read: () => Promise<V>): Promise<V> {
    const hit = this.get(key)
    if (hit) return hit.value
    const running = this.inFlight.get(key)
    if (running) return running
    const started = read().finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, started)
    return started
  }

  clear(): void {
    this.entries.clear()
    this.inFlight.clear()
  }

  get size(): number {
    return this.entries.size
  }
}

/** true / false as read; null: could not be read (kept only FAILED_TTL_MS). */
const cache = new ReadCache<boolean | null>()

/** For tests, and after a reset. */
export function clearDemoWorkspaceCache(): void {
  cache.clear()
  visitorCache.clear()
  anyDemo = null
  anyDemoInFlight = null
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
 * process for a minute; an unreadable answer for ten seconds, so a database
 * blip is one read and one log line, not one per request.
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
  return cache.load(workspaceId, async () => {
    const failed = (message: string): null => {
      console.error('[demo-workspace] flag read failed:', message)
      cache.set(workspaceId, null, FAILED_TTL_MS)
      return null
    }
    try {
      const { getServiceClient } = await import('@/lib/supabase/service')
      const { data, error } = await inTime(getServiceClient().rpc('is_demo_workspace', { p_workspace_id: workspaceId }))
      if (error) {
        // Before migration 669 there are no demo workspaces at all.
        if (error.code === 'PGRST202' || error.code === '42883') {
          cache.set(workspaceId, false, TTL_MS)
          return false
        }
        return failed(error.message)
      }
      const demo = data === true
      cache.set(workspaceId, demo, TTL_MS)
      return demo
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err))
    }
  })
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
  anyDemoInFlight = null
}

/** The visitor's demo workspace, or null (not a visitor, or unreadable: kept only FAILED_TTL_MS). */
const visitorCache = new ReadCache<string | null>()
/** true / false as read; null: could not be read. */
let anyDemo: { exists: boolean | null; until: number } | null = null
let anyDemoInFlight: Promise<boolean | null> | null = null

/**
 * Does any demo workspace exist? For a caller that would otherwise ask the
 * database about one person on every page render (the trial wall): with no
 * demo workspace at all, nobody can be a visitor. True when it cannot tell.
 */
export async function anyDemoWorkspaceExists(): Promise<boolean> {
  // Under the suite's lookups the database is not asked: let the caller go on.
  if (testVisitorLookup()) return true
  return (await anyDemoWorkspace()) !== false
}

/** One small read a minute per process, shared by everyone asking at once; with none, nobody is ever asked about. Null: could not tell. */
async function anyDemoWorkspace(): Promise<boolean | null> {
  if (anyDemo && Date.now() < anyDemo.until) return anyDemo.exists
  if (anyDemoInFlight) return anyDemoInFlight
  const read = async (): Promise<boolean | null> => {
    const answer = (exists: boolean | null): boolean | null => {
      anyDemo = { exists, until: Date.now() + (exists === null ? FAILED_TTL_MS : TTL_MS) }
      return exists
    }
    try {
      const { getServiceClient } = await import('@/lib/supabase/service')
      const { data, error } = await inTime(getServiceClient().from('demo_workspace').select('workspace_id').limit(1))
      if (error) {
        // Before migration 669 the table is not there: no demo workspaces.
        if (error.code === '42P01' || error.code === 'PGRST205') return answer(false)
        console.error('[demo-workspace] flag table read failed:', error.message)
        return answer(null)
      }
      return answer(((data as unknown[] | null) ?? []).length > 0)
    } catch (err) {
      console.error('[demo-workspace] flag table read failed:', err instanceof Error ? err.message : err)
      return answer(null)
    }
  }
  anyDemoInFlight = read().finally(() => {
    anyDemoInFlight = null
  })
  return anyDemoInFlight
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
 * Cached per person for a minute (bounded, and one read shared by everyone
 * asking at once). With no demo workspace at all it costs one shared read a
 * minute. A read that fails answers null, is logged once and stands for ten
 * seconds: the fence does not hold meanwhile, and no one who is not a visitor
 * is ever refused by it.
 */
export async function demoVisitorWorkspace(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null
  const forTests = testVisitorLookup()
  if (forTests) return forTests(userId)
  return visitorCache.load(userId, async () => {
    const failed = (message: string): null => {
      console.error('[demo-workspace] visitor read failed:', message)
      visitorCache.set(userId, null, FAILED_TTL_MS)
      return null
    }
    try {
      const exists = await anyDemoWorkspace()
      // Could not tell whether any demo workspace exists: already logged there.
      if (exists === null) {
        visitorCache.set(userId, null, FAILED_TTL_MS)
        return null
      }
      if (!exists) return null
      const { getServiceClient } = await import('@/lib/supabase/service')
      const service = getServiceClient()
      const seat = await inTime(service.rpc('demo_seat_workspace', { p_user_id: userId }))
      if (seat.error) return failed(seat.error.message)
      let workspaceId: string | null = typeof seat.data === 'string' && seat.data ? seat.data : null
      if (workspaceId) {
        const gate = await inTime(service.rpc('check_ai_usage_limit', { p_user_id: userId, p_chatgpt_plan: true }))
        if (gate.error) return failed(gate.error.message)
        const row = (Array.isArray(gate.data) ? gate.data[0] : gate.data) as { reason?: string | null } | null | undefined
        if (row?.reason !== DEMO_USAGE_REASON && row?.reason !== DEMO_CAP_REACHED_REASON) workspaceId = null
      }
      visitorCache.set(userId, workspaceId, TTL_MS)
      return workspaceId
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err))
    }
  })
}

/** True when this person is a demo workspace's visitor and `workspaceId` is not that workspace: theirs to use nowhere else. */
export async function demoVisitorElsewhere(userId: string | null | undefined, workspaceId: string | null | undefined): Promise<boolean> {
  const home = await demoVisitorWorkspace(userId)
  return !!home && home !== workspaceId
}

/** TESTS ONLY: how many entries the two caches hold, and their bound. */
export function demoCacheSizesForTests(): { flags: number; visitors: number; max: number } {
  return { flags: cache.size, visitors: visitorCache.size, max: MAX_ENTRIES }
}
