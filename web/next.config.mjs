import { withSentryConfig } from '@sentry/nextjs'
import { createMDX } from 'fumadocs-mdx/next'
import { withEve } from 'eve/next'

/**
 * The deployment's build id (as /api/version and NEXT_PUBLIC_BUILD_ID report
 * it). Stamped on every /api response as `x-ni-build`, so an open window
 * notices a new deploy from the responses it already gets and reloads when
 * idle (src/lib/deploy-reload.ts). Empty off Vercel.
 */
const BUILD_ID = process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ?? ''

// The cloud browser's relay host (docs/plans/cloud-browser.md, decision 6)
// serves only the relay: its routes (/api/browser-relay/*) and the files it
// downloads (/cloud-browser/*). Anything else on it goes to the app.
export const RELAY_HOST_REDIRECT = {
  source: '/:path((?!api/browser-relay/|cloud-browser/).*)',
  has: [{ type: 'host', value: 'browser-relay.dial8.ai' }],
  destination: 'https://dial8.ai/:path',
  permanent: false,
}

/**
 * The Content-Security-Policy on every response. It limits where scripts and
 * workers load from (no third-party host can run code as dial8.ai) and nothing
 * else: with no default-src, connect-src, img-src, frame-src and the rest stay
 * open, because the desktop app runs these same pages and its IPC is a fetch to
 * ipc://localhost. Every script is first-party today: PostHog's lazy scripts
 * come through the /ingest rewrite, ONNX Runtime from /ort (copy-ort-runtime.mjs).
 * - 'unsafe-inline': Next's inline bootstrap and RSC payload scripts, and the
 *   theme and cache-buster scripts. A nonce would make every page dynamic (no
 *   static marketing or docs pages); a nonce, hash or 'strict-dynamic' would
 *   also make browsers ignore 'unsafe-inline'.
 * - 'wasm-unsafe-eval': ONNX Runtime in the voice-embedding worker.
 * - blob: the mic capture's AudioWorklet loads from a blob URL (worklets follow
 *   script-src), and Turbopack starts every worker from a blob: bootstrap.
 * - 'unsafe-eval' in dev only, for React's and Turbopack's dev tooling.
 */
export function contentSecurityPolicy({ dev = process.env.NODE_ENV === 'development' } = {}) {
  return [
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:${dev ? " 'unsafe-eval'" : ''}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ')
}

export async function headers() {
  const headers = [
    {
      source: '/(.*)',
      headers: [
        { key: 'Content-Security-Policy', value: contentSecurityPolicy() },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=63072000; includeSubDomains; preload',
        },
        {
          key: 'Permissions-Policy',
          value: 'microphone=(self), camera=(), geolocation=()',
        },
      ],
    },
    // ONNX Runtime's files sit under their version (copy-ort-runtime.mjs), so
    // one URL never changes: cache the 21 MB binary for good.
    {
      source: '/ort/:path*',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
    },
  ]

  // Every /api response names its deployment: open windows reload on a new
  // deploy when idle (src/lib/deploy-reload.ts).
  if (BUILD_ID) {
    // TODO(rename-compat): `x-dial8-build` is what a window opened before the rename
    // reads; without it that window would never notice a deploy and reload. Drop it
    // once those windows are gone.
    headers.push({ source: '/api/:path*', headers: [{ key: 'x-ni-build', value: BUILD_ID }, { key: 'x-dial8-build', value: BUILD_ID }] })
  }

  // Keep Vercel preview deployments out of the search index. VERCEL_ENV is
  // 'production' | 'preview' | 'development'; it's only set on Vercel. Any
  // non-production Vercel deploy gets a blanket X-Robots-Tag: noindex so the
  // preview URL can't be crawled or indexed.
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    headers.push({
      source: '/:path*',
      headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
    })
  }

  return headers
}

/**
 * Which desktop downloads this deployment offers, as build-time flags the
 * browser bundle can read: '1' when APP_DOWNLOAD_URL (macOS) or
 * APP_DOWNLOAD_URL_WINDOWS is set, else ''. /api/download reads the URLs
 * themselves (src/lib/app-download.ts).
 * @param {Record<string, string | undefined>} [env]
 */
export function downloadFlags(env = process.env) {
  return {
    NEXT_PUBLIC_HAS_MAC_DOWNLOAD: env.APP_DOWNLOAD_URL?.trim() ? '1' : '',
    NEXT_PUBLIC_HAS_WINDOWS_DOWNLOAD: env.APP_DOWNLOAD_URL_WINDOWS?.trim() ? '1' : '',
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow an isolated build dir so a second `next dev` on this repo can run
  // without colliding on `.next/dev/lock`. Inert unless NEXT_DEV_DIST_DIR is set.
  ...(process.env.NEXT_DEV_DIST_DIR
    ? { distDir: process.env.NEXT_DEV_DIST_DIR }
    : {}),
  // Local worktrees can share node_modules through a symlink outside the
  // checkout. Turbopack needs a root containing both paths to resolve it.
  ...(process.env.NEXT_DEV_TURBOPACK_ROOT
    ? { turbopack: { root: process.env.NEXT_DEV_TURBOPACK_ROOT } }
    : {}),
  // Expose Vercel's deployment environment to the browser bundle so the client
  // Sentry init can tell production from preview. NODE_ENV is 'production' for
  // both deployed environments, so without this preview client errors would
  // leak into Sentry.
  env: {
    NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV,
    // The build id the browser bundle was built for (as /api/version reports
    // it): the desktop bots overlay reloads when the main window's differs
    // (src/lib/build-id.ts).
    NEXT_PUBLIC_BUILD_ID: BUILD_ID,
    // The commit itself, for the desktop automation bridge's info().buildId
    // (src/lib/automation): empty off Vercel.
    NEXT_PUBLIC_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA ?? '',
    // Whether each desktop download is set, for the buttons and links that
    // offer it (src/lib/app-download.ts hides one whose file isn't).
    ...downloadFlags(),
  },
  headers,
  async redirects() {
    return [
      // The old Tailwind-template /company page was removed; point any lingering
      // links or indexed URLs at the real About page.
      { source: '/company', destination: '/about', permanent: true },
      // The retired Compute and Coding tools settings pages (chat and loops
      // run on eve only); old links land on Settings.
      { source: '/account/settings/compute', destination: '/account/settings', permanent: false },
      { source: '/account/settings/coding-tools', destination: '/account/settings', permanent: false },
      // The retired AI Models settings page (the server picks the model per
      // turn); old links land on Settings.
      { source: '/account/settings/ai-models', destination: '/account/settings', permanent: false },
      // Integrations became Connectors (Claude's word; MCP servers live there
      // too). Old links, bookmarks and in-flight OAuth returns keep landing.
      { source: '/account/settings/integrations', destination: '/account/settings/connectors', permanent: false },
      { source: '/account/settings/integrations/:path*', destination: '/account/settings/connectors/:path*', permanent: false },
      RELAY_HOST_REDIRECT,
    ]
  },
  async rewrites() {
    return [
      {
        source: '/ingest/static/:path*',
        destination: 'https://us-assets.i.posthog.com/static/:path*',
      },
      {
        source: '/ingest/:path*',
        destination: 'https://us.i.posthog.com/:path*',
      },
      {
        source: '/ingest/decide',
        destination: 'https://us.i.posthog.com/decide',
      },
    ]
  },
  skipTrailingSlashRedirect: true,
  // The build's type check runs against tsconfig.build.json, which drops
  // tests, fixtures and scripts. Checking the full tsconfig.json (tests
  // included) ran past the default Node heap in next build's TypeScript step.
  // `npm run typecheck` still checks everything.
  typescript: {
    tsconfigPath: 'tsconfig.build.json',
  },
}

const withMDX = createMDX()

/**
 * Sentry's build plugin (source-map upload, Vercel cron monitors), only when
 * the deployment reports to a Sentry: NEXT_PUBLIC_SENTRY_DSN set. Without a
 * DSN the config is left as it is, so the build neither needs Sentry nor
 * uploads anything. Source maps go up only with SENTRY_ORG and SENTRY_PROJECT
 * too (and SENTRY_AUTH_TOKEN, which the plugin reads itself).
 * @template {object} C
 * @param {C} config
 * @param {Record<string, string | undefined>} [env]
 */
export function withSentry(config, env = process.env) {
  if (!env.NEXT_PUBLIC_SENTRY_DSN?.trim()) return config
  const org = env.SENTRY_ORG?.trim() || undefined
  const project = env.SENTRY_PROJECT?.trim() || undefined
  return withSentryConfig(config, {
    // For all available options, see:
    // https://www.npmjs.com/package/@sentry/webpack-plugin#options

    org,

    project,

    // No org or project: nowhere to upload source maps to.
    sourcemaps: { disable: !org || !project },

    // Only print logs for uploading source maps in CI
    silent: !env.CI,

    // For all available options, see:
    // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

    // Upload a larger set of source maps for prettier stack traces (increases build time)
    widenClientFileUpload: true,

    // Uncomment to route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
    // This can increase your server load as well as your hosting bill.
    // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
    // side errors will fail.
    // tunnelRoute: "/monitoring",

    webpack: {
      // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
      // See the following for more information:
      // https://docs.sentry.io/product/crons/
      // https://vercel.com/docs/cron-jobs
      automaticVercelMonitors: true,

      // Tree-shaking options for reducing bundle size
      treeshake: {
        // Automatically tree-shake Sentry logger statements to reduce bundle size
        removeDebugLogging: true,
      },
    },
  })
}

const sentryWrapped = withSentry(withMDX(nextConfig))

// Mount the eve agents into this Next app: same origin, one dev server, one
// Vercel deploy. In dev, withEve boots an eve dev server per agent alongside
// `next dev` and rewrites the eve routes to them. See docs/plans/eve-migration-plan.md.
//
// Those dev servers run with `--no-default-extensions` (patches/eve+0.79.1.patch;
// withEve has no option for it): `eve dev` otherwise mounts eve's bundled
// self-modification subagent, which edits the agents' own source, and the chat
// agent routed "a local agent on my Mac" there instead of start_local_agent
// (docs/plans/local-agents.md "Watch out for"). Production builds never had it.
// Regenerate the patch on an eve upgrade (postinstall fails if it stops applying).
//
// Multi-agent form: dedicated mounts, ALL under agents/*.
//   - `onboarding-researcher` -> ./agents/onboarding-researcher (signup research agent)
//   - `skill-runner`          -> ./agents/skill-runner          (Phase 2: headless run_skill)
//   - `coding-agent`          -> ./agents/coding-agent          (Phase 3: cloud coding runs)
//   - `work-agent`            -> ./agents/work-agent            (Loops v3: approved work runs)
//   - `chat-agent`            -> ./agents/chat-agent            (Phase 4: main chat)
//   - `utility`               -> ./agents/utility               (WS-4: one-shot generators)
//   - `live-agent`            -> ./agents/live-agent            (WS-1: live meeting agent)
//   - `web-research`          -> ./agents/web-research          (free tier: web search on the person's plan)
//
// Named agents mount under /eve/<name>/v1/* (eve 0.58+; the pre-0.58
// /eve/agents/<name>/eve/v1/* shape now 404s) — so the skill-runner's routes are
// /eve/skill-runner/v1/{session, session/:id, session/:id/stream, health, info}.
// eve's client joins `/eve/v1/...` onto a `/eve/<name>` host, so every *_MOUNT
// constant is `/eve/<name>`.
//
// WHY THE EXPLICIT MAP (not eve 0.55+ workspace auto-discovery): withEve()
// would discover `agents/<name>/` members on its own, but discovery silently
// EXCLUDES any member that has its own package.json, so a stray
// agents/<name>/package.json (eve's dev-time optional-package auto-install
// has created these before) would unmount that agent with no build error. The
// map keeps "what is mounted" explicit and reviewable; it mounts at the same
// /eve/<name>/v1/* prefix discovery would. (Members must still have NO
// package.json: eve's project-root lookup stops at the nearest one, and one
// without `eve` fails `eve dev` with "No eve project contains ...".)
//
// Mount names become Vercel Build Output service names as `eve-<name>`, and
// Vercel requires that name to "contain only lowercase letters, hyphens, and
// underscores" — NO DIGITS anywhere. A mount named `web2` → `eve-web2` is
// rejected at build on the `2`. Every mount below is digit-free.
//
// No agent root may live at a directory literally named `agent`: eve's
// project discovery (discover/project.js) treats any directory with that
// exact basename as a nested agent whose appRoot is its PARENT, so a mount at
// ./agent resolves appRoot to the REPO ROOT and `eve build` emits its Vercel
// Build Output to <repo>/.vercel/output instead of <serviceRoot>/.vercel/output
// — which Vercel's per-service build (@vercel/static-build) rejects with
// "No Output Directory named '.output' found" (vercel/eve#472). Roots under
// agents/<name> hit the flat-agent-root branch instead and emit correctly
// into their own directory, which the service build accepts as Build Output
// API v3.
export default withEve(sentryWrapped, {
  agents: {
    'onboarding-researcher': './agents/onboarding-researcher',
    'skill-runner': './agents/skill-runner',
    'coding-agent': './agents/coding-agent',
    'work-agent': './agents/work-agent',
    'chat-agent': './agents/chat-agent',
    utility: './agents/utility',
    'live-agent': './agents/live-agent',
    'web-research': './agents/web-research',
  },
})
