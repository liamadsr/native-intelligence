import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { inngest } from '@/lib/inngest/client'
import { claimAsanaWebhookSecret, loadAsanaWebhookAuth } from '@/lib/tasks/asana-config'

/**
 * POST /api/webhooks/asana/[syncStateId] — Asana → Dial8 read-back receiver.
 *
 * One receiver URL per `task_sync_state` row (the id is the path segment), so a
 * delivery identifies its workspace without a lookup table and a leaked/stale
 * URL can only ever address the one workspace it was registered for.
 *
 * Asana POSTs here in TWO distinct shapes:
 *
 *  1. HANDSHAKE — carries `X-Hook-Secret` and an empty body. It arrives WHILE
 *     our own `POST /webhooks` create call is still blocking (the create does
 *     not return 201 + the gid until we echo the header back with a 200). We
 *     store the secret and echo the header verbatim.
 *  2. DELIVERY — carries `X-Hook-Signature`, an HMAC-SHA256 hex digest of the
 *     RAW request body keyed by that secret, and a body of
 *     `{ events: [{ action, resource: { gid, resource_type }, … }] }`.
 *     A heartbeat (empty `events`) arrives roughly every 8h and is signed the
 *     same way; failing to 200 it for 24h makes Asana delete the webhook.
 *
 * The response is deliberately dumb and fast: Asana penalizes slow receivers
 * (and eventually unregisters them), and deliveries are AT-MOST-ONCE with no
 * replay, so anything we do inline is work we can lose. We verify, fan a single
 * Inngest event, and return — asana-apply-remote does the Asana/DB work, and
 * asana-reconcile is the safety net for anything that still goes missing.
 *
 * Style follows src/app/api/webhooks/github/route.ts: raw body first, HMAC with
 * a length-guarded timingSafeEqual, coded JSON replies.
 */

/** Asana delivery envelope (compact events — never trust them for state). */
interface AsanaWebhookEvent {
  action?: string
  resource?: { gid?: string; resource_type?: string }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ syncStateId: string }> },
): Promise<Response> {
  const { syncStateId } = await params

  // The raw text, ALWAYS first: the signature is computed over the exact bytes
  // Asana sent. Re-serializing the parsed JSON (key order, whitespace, unicode
  // escapes) would produce a different string and fail every valid delivery.
  const rawBody = await request.text()

  const handshakeSecret = request.headers.get('x-hook-secret')
  if (handshakeSecret) {
    return handleHandshake(syncStateId, handshakeSecret)
  }

  const auth = await loadAsanaWebhookAuth(syncStateId)
  // BOTH columns are required, and the gid is the load-bearing half.
  //
  // No secret is the obvious case: no key, nothing to verify, nothing to trust.
  // But a secret WITHOUT a gid means no registration we know of ever completed —
  // e.g. a handshake claimed the pending window and the create then failed, or
  // someone raced Asana to that window. Accepting deliveries on the strength of
  // such a secret would let whoever planted it drive real actions. Requiring the
  // gid makes a stolen claim inert: it can break one registration attempt (which
  // the next cron tick retries) and nothing more.
  //
  // 401 (not 404) throughout — an unknown id, an unregistered one and a
  // half-registered one must be indistinguishable from outside.
  if (!auth?.webhookSecret || !auth.webhookGid) {
    return NextResponse.json({ error: 'Unknown or unregistered webhook' }, { status: 401 })
  }

  const signature = request.headers.get('x-hook-signature')
  if (!signature || !verifySignature(auth.webhookSecret, rawBody, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Signature verified — parse. A malformed body past a valid signature is
  // Asana's problem, not an attack; 200 it so the webhook isn't torn down.
  let payload: { events?: AsanaWebhookEvent[] }
  try {
    payload = JSON.parse(rawBody || '{}') as { events?: AsanaWebhookEvent[] }
  } catch {
    return NextResponse.json({ ok: true, skipped: 'unparseable_body' })
  }

  const events = Array.isArray(payload.events) ? payload.events : []
  // Heartbeat: signed, empty, every ~8h. MUST be 200'd — 24h of failures and
  // Asana deletes the registration.
  if (events.length === 0) {
    return NextResponse.json({ ok: true, heartbeat: true })
  }

  // Only task `changed` events matter (that's all we register a filter for, but
  // an older registration or a filter change could deliver more). Deduped: one
  // task edited five times in a batch is one re-GET later.
  const taskGids = [
    ...new Set(
      events
        .filter((e) => e?.action === 'changed' && e?.resource?.resource_type === 'task')
        .map((e) => e.resource?.gid)
        .filter((gid): gid is string => typeof gid === 'string' && gid.length > 0),
    ),
  ]

  if (taskGids.length === 0) {
    return NextResponse.json({ ok: true, tasks: 0 })
  }

  // ONE event for the whole batch; the fan-out is the function's business.
  // Fire-and-forget: a dropped send costs us this batch, which the reconcile
  // sweep repairs — failing the delivery instead would earn a retry we can't
  // rely on anyway (Asana is at-most-once) and slow the receiver.
  try {
    await inngest.send({
      name: 'tasks/asana-remote-change',
      data: { syncStateId, workspaceId: auth.workspaceId, taskGids },
    })
  } catch (err) {
    console.error('[asana-webhook] inngest.send failed:', err)
  }

  return NextResponse.json({ ok: true, tasks: taskGids.length })
}

/**
 * Handshake path — the ONLY way `webhook_secret` is ever written.
 *
 * SECURITY: the write is a compare-and-swap gated on `webhook_pending_at` — a
 * window WE open (openAsanaWebhookPending) immediately before calling
 * `POST /webhooks`, which the claim itself NULLs and which expires after two
 * minutes. Without a gate this endpoint would be a secret OVERWRITE oracle: the
 * URL is not itself a secret (it is handed to Asana, sits in their config, and
 * is guessable to anyone who learns a sync state id), so an attacker could POST
 * an `X-Hook-Secret` of their choosing, replace the live verification key, and
 * sign forged deliveries that move real actions.
 *
 * The claim deliberately REPLACES any existing secret: that is how a
 * re-registration swaps keys without a coverage gap — the outgoing webhook keeps
 * delivering and verifying until the new handshake lands. Single-use + a short
 * TTL is what makes that safe; "already registered" is not the gate, "we are
 * expecting a handshake right now, and only one" is.
 *
 * LOSING THE RACE FAILS SAFE. If someone beats Asana to an open window, their
 * secret lands but our create call never gets its challenge answered, so no gid
 * is ever saved for it — and the delivery path above refuses anything without a
 * gid. The planted key verifies nothing. ensureAsanaWebhook simply opens a fresh
 * window and retries on the next cron tick.
 *
 * A second handshake against a window already consumed (a stale retry, or the
 * attacker arriving after Asana) matches 0 rows and is refused with 409 rather
 * than clobbering the key that is now live.
 */
async function handleHandshake(syncStateId: string, secret: string): Promise<Response> {
  const claimed = await claimAsanaWebhookSecret(syncStateId, secret)
  if (!claimed) {
    console.warn(
      `[asana-webhook] refused handshake for sync state ${syncStateId} — ` +
        'no open pending window (unknown id, never opened, expired, or already claimed).',
    )
    return NextResponse.json({ error: 'No pending webhook registration' }, { status: 409 })
  }

  // Echo the header back VERBATIM. Asana matches on the header, not the body.
  return new NextResponse(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Hook-Secret': secret },
  })
}

/**
 * Constant-time HMAC check over the raw body.
 *
 * Asana sends the digest as bare lowercase hex (no `sha256=` prefix, unlike
 * GitHub). timingSafeEqual THROWS on unequal-length buffers — a truncated or
 * junk signature — so the length is compared first and returns a clean false
 * (→ 401) rather than a 500.
 */
function verifySignature(secret: string, rawBody: string, signature: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  const expectedBuf = new Uint8Array(Buffer.from(expected))
  const providedBuf = new Uint8Array(Buffer.from(signature))
  if (expectedBuf.length !== providedBuf.length) return false
  return crypto.timingSafeEqual(expectedBuf, providedBuf)
}
