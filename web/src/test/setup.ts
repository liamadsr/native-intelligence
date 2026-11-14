import { afterEach, vi } from 'vitest'

// Next's build-time server boundary is inert in the Node test runtime.
vi.mock('server-only', () => ({}))

// No test resolves a real name. The MCP SSRF guard's DNS check
// (src/lib/mcp-client/url-guard-dns.ts, before every MCP dial and OAuth
// fetch) sees one public address here; tests of the check itself inject
// their own lookup.
vi.mock('node:dns/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:dns/promises')>()),
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}))

/**
 * Global test setup — runs before every test file.
 *
 * Keep this file small. Per-module mocks belong in each test file so you can
 * see what's mocked at a glance. Only put truly global behavior here.
 *
 * IMPORTANT: we do NOT call vi.unstubAllGlobals() or vi.unstubAllEnvs() here
 * because many tests use module-level `vi.stubGlobal('fetch', ...)` (see
 * gmail-watch.test.ts) and expect those stubs to persist across all tests
 * in the file. Individual tests that need to reset globals should do it
 * themselves.
 */

// Consistent environment defaults for tests. Tests can override with vi.stubEnv.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co'
// Forced, not defaulted: a production build runs this suite with production's
// environment, where the pin is set (src/lib/supabase/project.ts). Left in
// place it would rename the session cookie under every test that builds one.
// A test that wants a pin stubs it.
process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF = ''
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key'

// Fail FAST on any fetch to the supabase host resolved above. A suite that
// forgets to mock a supabase client makes a REAL network request — usually an
// instant DNS failure against the test.supabase.co placeholder (the test
// "passes" with "fetch failed" stderr noise), but under machine load the
// resolver can stall past vitest's 5s timeout and every test awaiting that
// code path flakes (claim-extraction and live-agent/stage failed exactly this
// way). Rejecting immediately preserves the same failure surface (supabase-js
// reports "TypeError: fetch failed") without touching the network.
//
// Match the RESOLVED env value, not just the placeholder literal: in a shell
// that carries the app's real settings (`npm run build` is `vitest run && next
// build`, and a build has them) the real NEXT_PUBLIC_SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY are there, the `??=` defaults never assign, and
// a literal-only guard would silently let an unmocked suite do authenticated
// I/O against PROD. Suites that stub fetch themselves override this wrapper.
const supabaseTestUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const realFetch = globalThis.fetch
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.startsWith(supabaseTestUrl) || url.startsWith('https://test.supabase.co')) {
    return Promise.reject(
      new TypeError('fetch failed', {
        cause: new Error(
          'unit test attempted real network I/O to the supabase host — mock the supabase client (see src/test/setup.ts)',
        ),
      }),
    )
  }
  // Inngest's hosts (event API, REST API + app registration, the local dev
  // server). The send fence below stops `inngest.send` before it gets here;
  // this stops everything else in the SDK (a serve handler's PUT sync, a
  // run/cancel REST call) from reaching production Inngest from a test.
  if (/^https?:\/\/([^/]*\.)?(inn\.gs|inngest\.com)(:\d+)?(\/|$)|^https?:\/\/(localhost|127\.0\.0\.1):8288(\/|$)/.test(url)) {
    return Promise.reject(
      new TypeError('fetch failed', {
        cause: new Error('unit test attempted real network I/O to Inngest — mock it (see src/test/setup.ts)'),
      }),
    )
  }
  return realFetch(input, init)
}) as typeof fetch

// The same fence for Realtime. supabase-js opens its websocket at the first
// `channel(...).subscribe()`, so a suite that renders a component binding a
// postgres_changes channel (`createClient().channel(...)`, `useRowChanges`)
// without mocking it would hold a REAL socket to the resolved host (with real
// settings in the shell, production) for as long as the run lasts. In jsdom the connection's
// events then trip undici's "event must be an instance of Event" check as an
// uncaught exception, and vitest exits 1 although every test passed.
//
// This guard THROWS at construction, where the fetch guard rejects quietly, and
// that is deliberate. A failed fetch is an ordinary outcome the code under test
// already handles and settles once. A socket that errors or closes is not
// quiet: realtime-js schedules reconnect backoff timers, and the app's recovery
// paths (CHANNEL_ERROR / CLOSED → a catch-up refetch) fire on their own clock —
// flakiness and hidden I/O attempts, not a test. realtime-js calls this
// constructor inside `connect()` and rethrows its error ("WebSocket not
// available: <this message>") from the `subscribe()` call, so the failure lands
// on the line that needs the mock. Mock the channel — `useRowChanges`, or the
// client from '@/lib/supabase/client' — in the suite that renders it.
// A Proxy, not a subclass, so static members (OPEN, CLOSED, …) and `instanceof`
// behave exactly as on the real constructor for every other URL.
const supabaseSocketPrefixes = [supabaseTestUrl, 'https://test.supabase.co'].map((u) => u.replace(/^http/, 'ws'))
const RealWebSocket = globalThis.WebSocket
if (typeof RealWebSocket === 'function') {
  globalThis.WebSocket = new Proxy(RealWebSocket, {
    construct(target, args, newTarget) {
      const raw = args[0] as string | URL
      const url = typeof raw === 'string' ? raw : raw.href
      if (supabaseSocketPrefixes.some((prefix) => url.startsWith(prefix))) {
        throw new Error(
          'unit test attempted a real Realtime connection to the supabase host — mock the channel or the supabase client (see src/test/setup.ts)',
        )
      }
      return Reflect.construct(target, args, newTarget)
    },
  })
}

// Scrub the app's settings so tests never inherit them from the shell. A build
// has the real ones (the eve agents' internal secrets among them) and `npm run
// build` runs this suite first, so without this a test driving the real
// run-skill/agent-run/chat control flow can mint real tokens and make live
// network calls (the salvage suite failed exactly this way: its "timed out"
// assertion received the production site's 404 HTML). Tests that need one of
// these set it explicitly per-test.
for (const flag of [
  'RUN_SKILL_INTERNAL_SECRET',
  'AGENT_RUN_INTERNAL_SECRET',
  'CHAT_INTERNAL_SECRET',
  'UTILITY_INTERNAL_SECRET',
  'LIVE_AGENT_INTERNAL_SECRET',
  // The cloud browser hands this to its sandbox's network policy when set
  // (src/lib/cloud-browser/host.ts). A test that needs it sets it itself.
  'VERCEL_AUTOMATION_BYPASS_SECRET',
  // Gateway usage-tracking rollout (docs/plans/gateway-usage-tracking.md):
  // the tagging/reporting flags flip real behavior (providerOptions on every
  // model call, admin dashboard source), and AI_GATEWAY_API_KEY would let an
  // unmocked test make a LIVE (billed) /v1/report call from a build's test
  // run. Tests covering these set them explicitly per-test.
  'GATEWAY_USER_TAGGING',
  'JEV_INPUT_USD_PER_MILLION',
  'GATEWAY_USAGE_REPORTING',
  'AI_GATEWAY_API_KEY',
  // The gateway client's other credential. With no API key it takes the
  // short-lived token in VERCEL_OIDC_TOKEN (local development's, from `vercel env
  // pull`). Left in place, a test that reaches a model or an embedding
  // without a mock makes a LIVE (billed) call during a production build and
  // then tries to record the spend. A document edit's re-index did exactly
  // that: one real embedding, a refused `billing/usage-log-failed` send, and a
  // failed build on a test that passes everywhere else. A test that needs the
  // token sets it itself.
  'VERCEL_OIDC_TOKEN',
  // eve and the code that fences it read these two: eve's provider selection
  // keys off VERCEL (agents/coding-agent/sandbox.ts reads it at module load),
  // the agents' localDevOffVercel() and the eval door off either, and the cloud
  // browser's relay origin off VERCEL_ENV. An inherited value flips those in any
  // test that does not pin it. Tests that need one set it explicitly per-test.
  'VERCEL_ENV',
  'VERCEL',
  // The gmail/outlook webhook routes fail CLOSED (401) when their secret is
  // unset in a built app. Scrub the secrets so the suites exercise the
  // documented dev-open default; tests covering fail-closed set them per-test.
  'GMAIL_WEBHOOK_TOKEN',
  'OUTLOOK_WEBHOOK_SECRET',
  // trackServerEvent constructs a REAL posthog-node client (flushAt:1 → an
  // immediate live /batch/ request) whenever this key is set, and a build has
  // it, so any route test that
  // forgets to mock @/lib/posthog would emit fake product events into the
  // production project. Scrubbed → getPostHogServerClient() returns null.
  // posthog-auth-session.test.ts sets its own value per-test.
  'NEXT_PUBLIC_POSTHOG_KEY',
  // NEXT_PUBLIC_APP_URL is the production address in a build. The eve dispatch
  // origin (src/lib/eve/dispatch-origin.ts) and the agents' spec-clients read
  // it, so an inherited value turns their localhost URL assertions into the
  // production host (and points unmocked internal calls at prod). Tests that
  // need a value set it explicitly per-test.
  'NEXT_PUBLIC_APP_URL',
  // Inngest. A build has the production event + signing keys,
  // and the Inngest client reads them ONCE, when `@/lib/inngest/client` first
  // loads. With the key present, any test whose code path reached a real
  // `inngest.send` (record.ts's defaultSend was one) POSTed a REAL event to
  // production Inngest, and prod `/api/inngest` then ran the router against
  // fixture ids ("invalid input syntax for type uuid: w1") minutes after every
  // deploy build. Scrubbed, the client is in cloud mode with no key and refuses
  // to send. The send fence below is the second wall.
  'INNGEST_EVENT_KEY',
  'INNGEST_SIGNING_KEY',
  'INNGEST_SIGNING_KEY_FALLBACK',
  'INNGEST_BASE_URL',
  'INNGEST_EVENT_API_BASE_URL',
  'INNGEST_API_BASE_URL',
  'INNGEST_DEV',
  'INNGEST_ENV',
  'INNGEST_SERVE_HOST',
  'INNGEST_SERVE_ORIGIN',
  'INNGEST_SERVE_PATH',
  // The app's own switch (src/lib/inngest/client.ts). Set in the build env the
  // day checkpointing has to go off; the suite must not change with it.
  'INNGEST_CHECKPOINTING',
  // The forward from the old domain (src/lib/old-domain-forward.ts): set in the
  // build env the day it is turned on; its tests set it themselves.
  'NI_FORWARD_OLD_DOMAIN',
  // Call notes and recording (src/lib/team-calls/egress.ts): set on the server the day
  // its egress service runs; the tests that need them set them per-test.
  'LIVEKIT_EGRESS',
  'TEAM_CALL_RECORDING',
  'TEAM_CALL_RECORDING_MAX',
  // Meeting links' key (src/lib/meeting-links/link.ts): the tests that need one set it.
  'MEETING_LINK_SECRET',
  // Billed or user-visible outbound services, also injected into the build
  // env. Unset locally, so every suite already runs (and passes) without them,
  // and the ones that need a key stub their own. Scrubbed, an unmocked path
  // fails on a missing key instead of sending a real email (Resend), touching
  // live Stripe, or spending on Exa / Deepgram / Anthropic.
  'RESEND_API_KEY',
  'STRIPE_SECRET_KEY',
  'PROD_STRIPE_SECRET_KEY',
  'EXA_API_KEY',
  'DEEPGRAM_API_KEY',
  'ANTHROPIC_API_KEY',
  // The eval runner's door (agents/chat-agent/lib/eval-auth.ts): a shell with
  // it switched on must not change what the channel suites see.
  'EVE_EVAL_AUTH_ENABLED',
  'EVE_EVAL_SECRET',
  'EVE_EVAL_USER_ID',
  'EVE_EVAL_WORKSPACE_ID',
  'EVE_EVAL_CONVERSATION_ID',
  'EVE_EVAL_AUTH_TOKEN',
  // The hosted service's own settings, also injected into the build env.
  // Each turns a feature on (Sentry, the email sender, the admins, the
  // desktop download); unset is the self-hosted default, and the tests that
  // need one set it per-test.
  'NEXT_PUBLIC_SENTRY_DSN',
  'SENTRY_ORG',
  'SENTRY_PROJECT',
  'EMAIL_FROM',
  'ADMIN_EMAILS',
  'APP_DOWNLOAD_URL',
  'APP_DOWNLOAD_URL_WINDOWS',
  'NEXT_PUBLIC_HAS_MAC_DOWNLOAD',
  'NEXT_PUBLIC_HAS_WINDOWS_DOWNLOAD',
]) {
  delete process.env[flag]
}

/**
 * The Inngest send fence: no test sends a real event, whatever env it runs in.
 *
 * Every send the SDK makes (`inngest.send`, and `step.sendEvent` inside a
 * function) goes through `Inngest.prototype._send`. Replaced here, it records
 * the attempt and rejects WITHOUT touching the network, and the `afterEach`
 * below fails the test that made it, so a code path that swallows the
 * rejection (recordAgentEvents never throws into its caller) still cannot pass
 * silently. A suite that exercises a send mocks it explicitly: pass a `send`
 * dep, `vi.spyOn(inngest, 'send')`, or `vi.mock('@/lib/inngest/client')`; each
 * shadows this prototype method, so the fence only ever sees forgotten mocks.
 * src/test/__tests__/inngest-send-fence.test.ts proves the fence.
 */
// vi.hoisted: vi.mock below is hoisted above every other statement in this file.
// The fence test drains `attempts` itself (globalThis key) after proving a send
// is caught, so its own afterEach passes.
const { INNGEST_SEND_FENCE_MESSAGE, inngestSendAttempts } = vi.hoisted(() => {
  const state = {
    INNGEST_SEND_FENCE_MESSAGE:
      'unit test attempted a REAL Inngest send — mock it (a `send` dep, vi.spyOn(inngest, "send") or vi.mock("@/lib/inngest/client")); see src/test/setup.ts',
    inngestSendAttempts: [] as string[],
  }
  ;(globalThis as { __inngestSendFence?: typeof state }).__inngestSendFence = state
  return state
})
vi.mock('inngest', async (importOriginal) => {
  // Lazy: only suites that load the SDK pay for importing it. The class is the
  // SAME object `inngest/next` and every other SDK entry use (the package is
  // external, so Node's module cache holds one copy), so patching its prototype
  // fences every client the suite builds.
  const mod = await importOriginal<typeof import('inngest')>()
  const proto = mod.Inngest.prototype as unknown as { _send: (arg: { payload: unknown }) => Promise<never> }
  proto._send = function fencedSend({ payload }: { payload: unknown }) {
    const names = (Array.isArray(payload) ? payload : [payload])
      .map((p) => (p && typeof p === 'object' && 'name' in p ? String((p as { name: unknown }).name) : '?'))
      .join(', ')
    inngestSendAttempts.push(names)
    return Promise.reject(new Error(`${INNGEST_SEND_FENCE_MESSAGE} [${names}]`))
  }
  return mod
})
afterEach(() => {
  if (!inngestSendAttempts.length) return
  const names = inngestSendAttempts.splice(0).join('; ')
  throw new Error(`${INNGEST_SEND_FENCE_MESSAGE} [${names}]`)
})

/**
 * `ResizeObserver`, which jsdom does not implement.
 *
 * WHY THIS IS GLOBAL AND NOT A PER-FILE MOCK. `react-resizable-panels` reads
 * `element.ownerDocument.defaultView.ResizeObserver` in a LAYOUT EFFECT, so a
 * component tree containing a resizable split does not degrade in jsdom — it
 * throws "n is not a constructor" during commit and takes the whole render
 * down, before any of the page under test is on screen. Any suite mounting a
 * page that happens to contain a split pane (Mail, and now the Prospecting list
 * detail) would otherwise have to mock the resize library by hand just to
 * render, which pins the mock instead of the page.
 *
 * Deliberately INERT: it observes nothing and never fires. jsdom reports zero
 * for every measurement anyway, so a real implementation would only produce
 * fake layout numbers. Suites that need to assert on resize behaviour should
 * stub this per-file with something that does fire.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
