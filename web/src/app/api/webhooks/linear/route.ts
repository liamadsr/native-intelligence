import { createHmac, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { inngest } from '@/lib/inngest/client'
import { LINEAR_PROVIDER } from '@/lib/tasks/linear-config'

/**
 * POST /api/webhooks/linear — Linear → Native Intelligence read-back receiver.
 *
 * ONE global URL, like the Jira sibling — but for the opposite reason, and with
 * the opposite security posture.
 *
 * Linear's webhooks are APP-LEVEL: the URL, the resource types and the signing
 * secret are configured ONCE in the OAuth app console, and Linear then
 * auto-provisions a webhook for every organization that authorizes the app.
 * There is nothing to register per account, nothing to refresh (no 30-day Jira
 * expiry), and nothing to tear down on disconnect — which is why this
 * integration has no `linear-webhook.ts`, no ensure-webhook function and no
 * webhook half in its cron. A delivery therefore names an issue and an
 * organization and nothing else; `action_external_task` is the router.
 *
 * ── This endpoint IS authenticated ──────────────────────────────────────────
 * `Linear-Signature` is a hex HMAC-SHA256 over the RAW request body using the
 * app's signing secret. That is a real boundary (Jira offers no equivalent for
 * REST-registered webhooks), and three details make it one rather than a
 * gesture:
 *  - the digest is taken over the exact bytes `await request.text()` returned.
 *    Parsing and re-serializing first would break on any payload whose key
 *    order, unicode escaping or number formatting doesn't round-trip — i.e. it
 *    would reject genuine deliveries while proving nothing about forged ones.
 *  - the compare is TIMING-SAFE. A byte-at-a-time `===` over a hex digest is a
 *    classic forgery oracle, and the caller here is by definition remote and
 *    unauthenticated.
 *  - a MISSING secret is 503, never "skip verification". An unconfigured
 *    environment must not silently downgrade this route to a public write
 *    trigger.
 *
 * `webhookTimestamp` (ms since epoch, also mirrored in `Linear-Timestamp`) is
 * the replay guard: a signature stays valid forever, so a captured delivery
 * could otherwise be replayed indefinitely. Anything outside ±60s is refused.
 *
 * ── Verified is not the same as TRUSTED ─────────────────────────────────────
 * Even a perfectly signed body is treated as a WAKE-UP TRIGGER and nothing else.
 * The only thing lifted out of it is issue UUIDs; `linear-apply-remote` then
 * re-reads each issue over an authenticated call against the workspace's own
 * token and applies what Linear itself reports. That is deliberate on two
 * counts:
 *  - the signing secret is APP-level, so every organization that installs the
 *    app shares the same key. A signature proves "some installer of this app",
 *    not "the owner of these issues" — believing payload fields would let one
 *    tenant state outcomes about another's links.
 *  - research could not confirm the exact shape of `data.state` or of the
 *    `updatedFrom` key for a state change. Reading neither makes that
 *    uncertainty structurally irrelevant rather than a latent bug.
 *
 * Amplification is bounded the same way as the Jira receiver: at most 25 ids
 * leave here per delivery, and only ids that ALREADY have a link — which makes a
 * delivery naming issues nobody linked cost one indexed SELECT and stop.
 * `linear-apply-remote` bounds the actual work (per-run link cap, self-chain,
 * throttle).
 *
 * Respond FAST. Linear's delivery timeout is 5 seconds and it retries three
 * times (+1min / +1h / +6h) before it may DISABLE the webhook outright — so
 * nothing slow, and nothing that earns a non-2xx, happens here. The 6-hourly
 * reconcile sweep is the recovery path for anything dropped, which is also how
 * dev environments read back at all: the app console holds ONE webhook URL
 * (production), so a dev connection's deliveries land on the prod receiver,
 * match no dev link, and are dropped.
 *
 * Duplicate deliveries need no handling: `applyRemoteTaskState`'s
 * compare-and-swap makes a repeat a no-op.
 */

/** Issue ids per delivery. */
const MAX_ISSUE_IDS = 25

/** How far a delivery's own timestamp may be from ours. */
const MAX_TIMESTAMP_SKEW_MS = 60_000

/** Defensively read an issue id out of an untrusted node. */
function issueIdOf(node: unknown): string | null {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null
  const id = (node as { id?: unknown }).id
  // Linear issue ids are UUIDs — always strings, never numeric (the Jira
  // receiver's number-coercion has no counterpart here).
  return typeof id === 'string' && id.length > 0 ? id : null
}

/**
 * Constant-time hex-digest comparison, matching the Asana and GitHub receivers'
 * shape exactly (`new Uint8Array(Buffer.from(…))` — Buffer alone no longer
 * satisfies the ArrayBufferView parameter type).
 *
 * timingSafeEqual THROWS on differing lengths, so the guard is required — and a
 * length difference leaks nothing beyond "not a sha256 hex digest".
 */
function signatureMatches(expected: string, provided: string): boolean {
  const a = new Uint8Array(Buffer.from(expected, 'utf8'))
  const b = new Uint8Array(Buffer.from(provided, 'utf8'))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.LINEAR_WEBHOOK_SECRET
  if (!secret) {
    // FAIL CLOSED. Accepting unverified deliveries "until the env is set" would
    // turn the one real authentication boundary this integration has into an
    // open write trigger, and would do it silently.
    console.error('[linear-webhook] LINEAR_WEBHOOK_SECRET is not set; refusing deliveries.')
    return NextResponse.json({ error: 'webhook not configured' }, { status: 503 })
  }

  const provided = request.headers.get('linear-signature')
  if (!provided) {
    return NextResponse.json({ error: 'missing signature' }, { status: 401 })
  }

  // RAW BYTES, read once, hashed before anything parses them.
  const raw = await request.text()
  const expected = createHmac('sha256', secret).update(raw).digest('hex')
  if (!signatureMatches(expected, provided)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }

  // ── Verified. Everything below treats the body as data, not as testimony. ──

  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    // 200, not 4xx: a non-2xx earns a retry of the same unparseable bytes and
    // counts toward the three failures that can disable the webhook.
    return NextResponse.json({ ok: true, skipped: 'unparseable_body' })
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return NextResponse.json({ ok: true, skipped: 'unexpected_body' })
  }

  const body = payload as Record<string, unknown>

  // Replay guard. Rejected — not 200'd — because a stale delivery is either an
  // attack or a clock problem, and both deserve to be visible in Linear's own
  // delivery log rather than silently absorbed.
  const timestamp = body.webhookTimestamp
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return NextResponse.json({ error: 'missing timestamp' }, { status: 401 })
  }
  if (Math.abs(Date.now() - timestamp) > MAX_TIMESTAMP_SKEW_MS) {
    return NextResponse.json({ error: 'stale delivery' }, { status: 401 })
  }

  // One app-level webhook carries every resource type the console subscribes to
  // — Comment, Project, Cycle, and the OAuthApp revocation notice among them.
  // Anything that isn't an Issue is a clean, cheap 200.
  if (body.type !== 'Issue') {
    return NextResponse.json({ ok: true, ignored: 'not_an_issue' })
  }

  // `data` is documented as one Issue-shaped object. An array is accepted purely
  // as defensive parsing of an untrusted body.
  const raw_data = body.data
  const nodes = Array.isArray(raw_data) ? raw_data : [raw_data]
  const issueIds = [
    ...new Set(nodes.map(issueIdOf).filter((id): id is string => id !== null)),
  ]

  if (issueIds.length === 0) {
    return NextResponse.json({ ok: true, issues: 0 })
  }

  // The only bound this endpoint owns: at most 25 ids leave here, whatever the
  // body claims. It bounds IDS, not WORK — one id can match links in several
  // workspaces, and the per-link cost is bounded in linear-apply-remote.
  const capped = issueIds.slice(0, MAX_ISSUE_IDS)

  /**
   * The organization the delivery claims to come from — a HINT, forwarded for
   * linear-apply-remote's defence-in-depth check against each workspace's stored
   * `organization_id`. Deliberately not required and never authoritative: the
   * signature already establishes authenticity, and the authenticated re-fetch
   * establishes truth.
   */
  const organizationId =
    typeof body.organizationId === 'string' && body.organizationId.length > 0
      ? body.organizationId
      : null

  // ONE indexed read — the amplification bound. Ids that match no link cost
  // exactly this query and nothing more.
  //
  // ITS RESULT NEVER REACHES THE WIRE — see the response shape below.
  let known: string[]
  try {
    const supabase = getServiceClient()
    const { data, error } = await supabase
      .from('action_external_task')
      .select('external_id')
      .eq('provider', LINEAR_PROVIDER)
      .in('external_id', capped)
    if (error) throw new Error(error.message)
    known = [...new Set((data ?? []).map((row) => String(row.external_id)))]
  } catch (err) {
    // Fail CLOSED — the reconcile sweep repairs a dropped delivery within six
    // hours, whereas enqueueing unfiltered during a database blip hands the
    // amplification back to whoever is POSTing at the time.
    console.error('[linear-webhook] could not resolve issue ids to links:', err)
    return NextResponse.json({ ok: true, skipped: 'link_lookup_failed' })
  }

  // Fire-and-forget, and only for ids that matched.
  if (known.length > 0) {
    try {
      await inngest.send({
        name: 'tasks/linear-remote-change',
        data: {
          issueIds: known,
          ...(organizationId ? { organizationId } : {}),
        },
      })
    } catch (err) {
      console.error('[linear-webhook] inngest.send failed:', err)
    }
  }

  // ONE response shape, derived ENTIRELY from what the caller sent.
  //
  // Reporting the post-filter count would make this a cross-tenant oracle
  // ("does this issue UUID have a Native Intelligence link anywhere?"), which the signature
  // does not prevent: the signing secret is app-level and shared by every
  // organization that installs the app. The filter's result stays internal,
  // where it gates the enqueue and nothing else.
  return NextResponse.json({ ok: true, issues: capped.length })
}
