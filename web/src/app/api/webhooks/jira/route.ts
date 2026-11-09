import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { inngest } from '@/lib/inngest/client'
import { JIRA_PROVIDER } from '@/lib/tasks/jira-config'

/**
 * POST /api/webhooks/jira — Jira → Native Intelligence read-back receiver.
 *
 * ONE global URL, no `[syncStateId]` segment, and that is not a simplification:
 * Atlassian's registration schema says "only a single URL per app is allowed to
 * be registered", so a per-tenant receiver path is not expressible. Deliveries
 * therefore carry no indication of which Native Intelligence workspace they belong to — the
 * issue id is resolved against `action_external_task` downstream, across
 * workspaces.
 *
 * ── This endpoint is UNAUTHENTICATED, by platform design ────────────────────
 * There is no way to secure it and we do not pretend otherwise. In particular
 * the URL carries NO secret segment, and that is deliberate rather than an
 * oversight: Atlassian permits a single delivery URL per app, so any secret in
 * it would be one static value shared by every tenant, present in every
 * registration and in every customer's webhook list — a value that reads as a
 * credential while providing none of the properties of one. The authenticated
 * re-fetch below is the boundary instead, and the amplification a forged
 * delivery could otherwise cause is bounded here (the 25-id cap and the
 * known-link filter) and downstream (jira-apply-remote's per-run link cap, its
 * self-chain and its 30/min throttle). Concretely:
 *  - Dynamic (REST-registered) webhooks cannot carry a shared secret at all.
 *    The `secret`/HMAC scheme in Atlassian's docs belongs exclusively to
 *    admin-UI webhooks; the feature request to extend it here is JRACLOUD-96162.
 *  - The docs claim an `Authorization: Bearer` JWT signed with the app's client
 *    secret, but there is no documented issuer or JWKS endpoint for it, and
 *    developers report it not arriving. We do not read it and we do not require
 *    it: hard-failing on an unverifiable header would break the integration for
 *    an undocumented, unstable behaviour.
 *  - `X-Atlassian-Webhook-*` headers are retry metadata, not identity. Anyone
 *    can forge them.
 *
 * So the payload is treated as a WAKE-UP TRIGGER and NOTHING ELSE. No field in
 * the body is trusted, believed or written anywhere: we lift issue ids out of
 * it, and `jira-apply-remote` then re-fetches each issue over an authenticated
 * call, which is where the actual trust boundary lives. An attacker who forges
 * a delivery achieves exactly one thing — Native Intelligence re-reads an issue it already had
 * permission to read, and applies whatever Jira genuinely says.
 *
 * The response is deliberately dumb and fast. Jira retries a non-2xx up to 5
 * times over 5–15 minutes and drops to one attempt per interval after 30 minutes
 * of failures, and a 3LO app cannot inspect what it missed
 * (`GET /webhook/failed` is Connect-apps-only). Anything slow here is latency we
 * pay on every delivery; the reconcile sweep is the recovery path for anything
 * lost.
 *
 * Deliveries may also arrive MORE THAN ONCE ("some webhooks might be delivered
 * more than once"). No de-duplication happens here — it isn't needed:
 * `applyRemoteTaskState`'s compare-and-swap makes a repeat delivery a no-op, so
 * an idempotency table keyed on `X-Atlassian-Webhook-Identifier` would only
 * duplicate a guarantee that already exists further in.
 */

/** Issue ids per delivery. A bulk operation can name far more; see below. */
const MAX_ISSUE_IDS = 25

/** Defensively read an issue id out of an untrusted node. */
function issueIdOf(node: unknown): string | null {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null
  const id = (node as { id?: unknown }).id
  if (typeof id === 'string' && id.length > 0) return id
  // Jira has been observed to serialize the id as a number in some payloads;
  // `action_external_task.external_id` is text, so normalize rather than drop.
  if (typeof id === 'number' && Number.isFinite(id)) return String(id)
  return null
}

export async function POST(request: Request): Promise<Response> {
  // Never throws on a malformed body: a parse failure is 200'd, because a
  // non-2xx buys us a retry of the same unparseable bytes and counts toward
  // Jira's failure backoff.
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ ok: true, skipped: 'unparseable_body' })
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return NextResponse.json({ ok: true, skipped: 'unexpected_body' })
  }

  // The documented shape is ONE delivery, ONE `issue` (`jira:issue_updated` /
  // `jira:issue_deleted`). An array is accepted alongside it purely as
  // defensive parsing of an untrusted body — JRACLOUD-94048 ("Inconsistent
  // Field Data in Webhook Payloads") is open, so the receiver is built to
  // tolerate a shape drifting rather than to insist on one. Anything else — a
  // heartbeat, a sprint/version event that slipped a filter, a shape added
  // later — falls through to a clean 200 with nothing dispatched.
  const raw = (payload as { issue?: unknown }).issue
  const nodes = Array.isArray(raw) ? raw : [raw]
  const issueIds = [
    ...new Set(nodes.map(issueIdOf).filter((id): id is string => id !== null)),
  ]

  if (issueIds.length === 0) {
    return NextResponse.json({ ok: true, issues: 0 })
  }

  // The first bound, and the only one this endpoint owns: at most 25 issue ids
  // leave here per delivery, whatever the (attacker-controllable) body claims.
  //
  // It bounds IDS, not WORK. One id can match links in many workspaces and each
  // link costs one authenticated Jira read, so the read count is bounded in
  // jira-apply-remote instead — MAX_LINKS_PER_RUN per invocation, remainder
  // self-chained, whole run behind a 30/min throttle. Saying "25 reads" here
  // would be a comforting invariant the code does not hold.
  const capped = issueIds.slice(0, MAX_ISSUE_IDS)

  // ONE indexed read — the amplification bound.
  //
  // Without it, any anonymous caller can name 25 plausible issue ids (Jira ids
  // are small sequential integers starting at 10000 on EVERY site, so a guess
  // hits real links across unrelated tenants) and make us resolve them to every
  // matching link in the fleet and issue one authenticated Jira GET per link,
  // charged against each tenant's own Atlassian quota. Filtering to ids that
  // already have a link here costs one query on the (provider, external_id)
  // index and makes a forged delivery for an unknown issue exactly free.
  //
  // It is NOT authentication and doesn't pretend to be: an attacker who knows a
  // real linked issue id still gets a re-read of that issue. That is the same
  // outcome a genuine delivery produces, and jira-apply-remote's throttle bounds
  // the rate of it.
  //
  // ITS RESULT NEVER REACHES THE WIRE — see the single response shape below.
  let known: string[]
  try {
    const supabase = getServiceClient()
    const { data, error } = await supabase
      .from('action_external_task')
      .select('external_id')
      .eq('provider', JIRA_PROVIDER)
      .in('external_id', capped)
    if (error) throw new Error(error.message)
    known = [...new Set((data ?? []).map((row) => String(row.external_id)))]
  } catch (err) {
    // Fail CLOSED. A dropped delivery is repaired by the reconcile sweep within
    // six hours; enqueueing unfiltered on a database blip would hand the
    // amplification back to whoever is POSTing at the time.
    console.error('[jira-webhook] could not resolve issue ids to links:', err)
    return NextResponse.json({ ok: true, skipped: 'link_lookup_failed' })
  }

  // Fire-and-forget, and only for ids that matched: a dropped send costs us this
  // delivery, which the reconcile sweep repairs. Failing the request instead
  // would earn a retry we don't need and slow a receiver Jira measures.
  if (known.length > 0) {
    try {
      await inngest.send({
        name: 'tasks/jira-remote-change',
        data: { issueIds: known },
      })
    } catch (err) {
      console.error('[jira-webhook] inngest.send failed:', err)
    }
  }

  // ONE response shape, derived ENTIRELY from what the caller sent.
  //
  // `issues: known.length` — the POST-filter count — turned this endpoint into a
  // free cross-tenant oracle: it is unauthenticated, always 200s, and answers
  // "does this Jira issue id have a Native Intelligence link ANYWHERE in the fleet?" one id at
  // a time. That is exactly the reconnaissance an attacker needs for the half of
  // the amplification the filter does NOT close — a genuinely linked id still
  // fans out to every workspace that links it. So the filter's result stays
  // internal, where it gates the enqueue and nothing else.
  return NextResponse.json({ ok: true, issues: capped.length })
}
