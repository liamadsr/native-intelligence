/**
 * Per-user attribution for Vercel AI Gateway calls (Phase A of
 * docs/plans/gateway-usage-tracking.md).
 *
 * This is PURE ENRICHMENT. Every Gateway-routed generation can carry a
 * `providerOptions.gateway.user` id and a set of `tags`, which the Gateway's
 * `/v1/report` API then aggregates per user / per feature. Nothing here touches
 * billing, enforcement, the wallet, or `logUsage` — it only decorates the
 * outbound request so spend can be attributed after the fact.
 *
 * Behind the `GATEWAY_USER_TAGGING === 'all'` flag (the repo's staged-rollout
 * convention). Flag OFF → every function is a no-op:
 *   - `gatewayTelemetryValues` returns `null`
 *   - `gatewayTelemetry` returns `{}` (spread-safe: adds nothing to the options)
 * so the entire feature can be reverted by unsetting the env var, with zero
 * behavior change on any call site.
 *
 * Why two shapes:
 *   - `gatewayTelemetry(...)` returns `{ providerOptions: { gateway: {...} } }`
 *     ready to spread straight into a streamText/generateText/embed options
 *     object at a Next-app call site.
 *   - `gatewayTelemetryValues(...)` returns the bare `{ user?, tags }` so the
 *     eve spec-rebuild paths can stash the values on the spec payload and the
 *     agent-side model resolver can rebuild the providerOptions object itself
 *     (eve's selection keys are strict — see the eve paths in the plan).
 *
 * Constraints are Gateway-enforced (invalid values → HTTP 400 that would FAIL
 * the model call): user ≤256 chars, ≤10 tags, each tag 1–64 chars. We enforce
 * them defensively here so a stray long workspace id or an accidental extra tag
 * degrades gracefully (truncate / drop) instead of breaking generation.
 */

import { isProductionEnvironment } from '@/lib/app-env'

/** Bare telemetry values, for the eve spec-rebuild paths that reconstruct
 *  providerOptions on the agent side. `user` is omitted entirely when there's
 *  no identity (never sent as an empty string — an empty user would 400).
 *
 *  A `type` alias (not an `interface`) on purpose: the AI SDK v7 types
 *  `providerOptions` as `Record<string, JSONObject>`, and only an object-literal
 *  type alias structurally satisfies that index signature — an interface does
 *  not (interfaces lack an implicit index signature), so spreading this under
 *  `providerOptions.gateway` would fail typecheck if this were an interface. */
export type GatewayTelemetryValues = {
  user?: string
  tags: string[]
}

/** Gateway hard limits. Exported-adjacent constants kept local — these mirror
 *  the documented `/v1/report` tagging constraints, not app config. */
const MAX_USER_CHARS = 256
const MAX_TAG_CHARS = 64
const MAX_TAGS = 10

/**
 * The flag is read at CALL time (not module load) so ops can flip it via env
 * without a redeploy — same discipline as BILLING_FAIL_OPEN in
 * src/lib/ai/auth.ts.
 */
function taggingEnabled(): boolean {
  return process.env.GATEWAY_USER_TAGGING === 'all'
}

interface TelemetryOpts {
  workspaceId?: string | null
  /** Marks the call as originating from an eve runtime path (adds `runtime:eve`). */
  runtime?: 'eve'
  /** Extra caller-supplied tags appended after the standard ones (e.g. a skill slug). */
  extraTags?: string[]
}

/**
 * Compute the bare `{ user?, tags }` for a call, or `null` when the flag is off.
 *
 * Tag order is deliberate and stable so the Gateway taxonomy is predictable:
 *   1. `feature:<feature>`          — the usage taxonomy slug (matches ai_usage_logs.feature)
 *   2. `env:<production|development>` — a built app is production (app-env)
 *   3. `ws:<workspaceId>`           — when a workspace id is supplied
 *   4. `runtime:eve`                — when the call came through an eve path
 *   5. ...extraTags                 — caller extras (e.g. skill slug)
 *
 * Each tag is trimmed, empty tags dropped, each truncated to 64 chars, and the
 * whole list capped at 10 — the standard tags come first so caller extras are
 * what gets dropped if the cap is hit, never `feature`/`env`.
 */
export function gatewayTelemetryValues(
  userId: string | null | undefined,
  feature: string,
  opts?: TelemetryOpts,
): GatewayTelemetryValues | null {
  if (!taggingEnabled()) return null

  // A built app (the server) is production; `next dev` and everything else is
  // development, so the env tag always carries one of two values.
  const env = isProductionEnvironment() ? 'production' : 'development'
  const rawTags: string[] = [`feature:${feature}`, `env:${env}`]
  if (opts?.workspaceId) rawTags.push(`ws:${opts.workspaceId}`)
  if (opts?.runtime === 'eve') rawTags.push('runtime:eve')
  if (opts?.extraTags?.length) rawTags.push(...opts.extraTags)

  // Enforce the Gateway tag constraints defensively: trim, drop empties,
  // truncate each to 64 chars, cap the whole list at 10.
  const tags = rawTags
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => (t.length > MAX_TAG_CHARS ? t.slice(0, MAX_TAG_CHARS) : t))
    .slice(0, MAX_TAGS)

  const values: GatewayTelemetryValues = { tags }
  // Omit `user` entirely when there's no identity — an empty-string user is a
  // 400 from the Gateway, which would fail the model call. Falsy userId (null /
  // undefined / '') means feature+workspace attribution only.
  if (userId) {
    values.user = userId.length > MAX_USER_CHARS ? userId.slice(0, MAX_USER_CHARS) : userId
  }

  return values
}

/**
 * Spread-ready providerOptions for a Next-app call site. Returns `{}` when the
 * flag is off so `...gatewayTelemetry(...)` adds nothing to the options object.
 *
 *   const result = await generateText({
 *     model: aiModel(slug),
 *     ...gatewayTelemetry(user.id, 'generate_title', { workspaceId }),
 *     ...
 *   })
 *
 * On the direct-provider kill-switch path (USE_GATEWAY=false) and the direct
 * @ai-sdk/google path, an unknown `gateway` providerOptions key is simply
 * ignored, so spreading this in is safe everywhere.
 */
export function gatewayTelemetry(
  userId: string | null | undefined,
  feature: string,
  opts?: TelemetryOpts,
): { providerOptions?: { gateway: GatewayTelemetryValues } } {
  const values = gatewayTelemetryValues(userId, feature, opts)
  if (!values) return {}
  return { providerOptions: { gateway: values } }
}
