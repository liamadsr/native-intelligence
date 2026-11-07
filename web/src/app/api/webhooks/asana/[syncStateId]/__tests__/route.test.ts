import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'

/**
 * Tests for POST /api/webhooks/asana/[syncStateId] — the Asana→Dial8 receiver.
 *
 * Invariants locked in:
 *  - HANDSHAKE: the secret is stored ONLY inside a single-use pending window we
 *    opened ourselves (webhook_pending_at). A CAS miss → 409 with the stored
 *    secret untouched — this is the defence against a secret-overwrite forgery,
 *    since the receiver URL is not itself a secret.
 *  - DELIVERY: a secret alone is not enough. `webhook_gid` must ALSO be set, so
 *    a claim stolen during a registration that never completed can't be used to
 *    sign anything: no gid was ever saved for it.
 *  - The X-Hook-Secret header is echoed back verbatim (Asana matches on the
 *    header, not the body).
 *  - DELIVERY: the HMAC is computed over the EXACT raw body text, never a
 *    re-serialized parse; a valid signature is accepted, an invalid one, a
 *    missing one, and an unequal-LENGTH one are all a clean 401 (timingSafeEqual
 *    throws on unequal lengths — the length guard must catch it first).
 *  - An unknown / never-handshaken sync state is 401, not 404.
 *  - Heartbeats (signed, empty events) → 200 with NO Inngest event; failing them
 *    for 24h makes Asana delete the webhook.
 *  - Task `changed` events → exactly ONE deduped Inngest event; non-task and
 *    non-changed events are ignored.
 *  - No Asana/API work happens inline (Asana penalizes slow receivers).
 */

const hoisted = vi.hoisted(() => ({
  send: vi.fn(async () => ({ ids: ['e'] })),
  claimAsanaWebhookSecret: vi.fn(),
  loadAsanaWebhookAuth: vi.fn(),
}))

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.send } }))
vi.mock('@/lib/tasks/asana-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    claimAsanaWebhookSecret: hoisted.claimAsanaWebhookSecret,
    loadAsanaWebhookAuth: hoisted.loadAsanaWebhookAuth,
  }
})

const { POST } = await import(
  '@/app/api/webhooks/asana/[syncStateId]/route'
)

const SECRET = 'shhh-asana-secret'
const SYNC_STATE_ID = 'tss-1'

const AUTH = {
  id: SYNC_STATE_ID,
  workspaceId: 'ws-1',
  accountId: 'acct-1',
  userId: 'u-1',
  webhookGid: 'wh-1',
  webhookSecret: SECRET,
  projectGid: 'proj-1',
}

function sign(body: string, secret = SECRET): string {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

function req(body: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://x/api/webhooks/asana/${SYNC_STATE_ID}`, {
    method: 'POST',
    body,
    headers,
  })
}

const params = Promise.resolve({ syncStateId: SYNC_STATE_ID })

/** A signed delivery for the given body text. */
function signed(body: string): Request {
  return req(body, { 'x-hook-signature': sign(body) })
}

const TASK_EVENT = (gid: string) => ({
  action: 'changed',
  resource: { gid, resource_type: 'task' },
})

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.send.mockResolvedValue({ ids: ['e'] })
  hoisted.claimAsanaWebhookSecret.mockResolvedValue(true)
  hoisted.loadAsanaWebhookAuth.mockResolvedValue(AUTH)
})

// ---- Handshake -------------------------------------------------------------

describe('asana receiver — handshake', () => {
  it('stores the secret while pending and echoes X-Hook-Secret back', async () => {
    const res = await POST(req('', { 'x-hook-secret': 'brand-new' }), { params })

    expect(res.status).toBe(200)
    expect(res.headers.get('x-hook-secret')).toBe('brand-new')
    expect(hoisted.claimAsanaWebhookSecret).toHaveBeenCalledWith(SYNC_STATE_ID, 'brand-new')
    // Nothing else runs on the handshake path.
    expect(hoisted.loadAsanaWebhookAuth).not.toHaveBeenCalled()
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('409s when the CAS matches no pending row — the live secret is NOT overwritten', async () => {
    // The gate: the claim only lands inside a single-use window we opened on our
    // way into POST /webhooks. Without it, anyone who can POST this URL could
    // replace the verification key and then sign forged deliveries.
    hoisted.claimAsanaWebhookSecret.mockResolvedValue(false)

    const res = await POST(req('', { 'x-hook-secret': 'attacker-chosen' }), { params })

    expect(res.status).toBe(409)
    expect(res.headers.get('x-hook-secret')).toBeNull()
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('takes the handshake path even when a signature header is also present', async () => {
    // X-Hook-Secret is the discriminator; a request carrying both must not be
    // treated as a delivery signed with an unknown key.
    const res = await POST(
      req('', { 'x-hook-secret': 'new', 'x-hook-signature': 'deadbeef' }),
      { params },
    )
    expect(res.status).toBe(200)
    expect(hoisted.claimAsanaWebhookSecret).toHaveBeenCalled()
  })
})

// ---- Signature verification ------------------------------------------------

describe('asana receiver — signature verification', () => {
  it('accepts a delivery whose signature matches the RAW body', async () => {
    const body = JSON.stringify({ events: [TASK_EVENT('task-1')] })
    const res = await POST(signed(body), { params })
    expect(res.status).toBe(200)
  })

  it('verifies against the exact raw text, not a re-serialized parse', async () => {
    // Same JSON value, different bytes (key order + whitespace). Signing the raw
    // text must pass; anything that re-serialized before hashing would fail here.
    const body = '{\n  "events" : [ {"resource":{"resource_type":"task","gid":"task-9"},"action":"changed"} ]\n}'
    const res = await POST(signed(body), { params })
    expect(res.status).toBe(200)
    expect(hoisted.send).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ taskGids: ['task-9'] }) }),
    )
  })

  it('401s on a WRONG signature', async () => {
    const body = JSON.stringify({ events: [TASK_EVENT('task-1')] })
    const res = await POST(req(body, { 'x-hook-signature': sign(body, 'other-secret') }), {
      params,
    })
    expect(res.status).toBe(401)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('401s when the signature header is missing entirely', async () => {
    const res = await POST(req(JSON.stringify({ events: [] })), { params })
    expect(res.status).toBe(401)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('401s (never 500s) on a TRUNCATED signature of unequal length', async () => {
    // timingSafeEqual throws on unequal-length buffers; the length guard must
    // short-circuit or a malformed header becomes a 500.
    const body = JSON.stringify({ events: [TASK_EVENT('task-1')] })
    const res = await POST(req(body, { 'x-hook-signature': 'abc123' }), { params })
    expect(res.status).toBe(401)
  })

  it('401s on a body tampered with after signing', async () => {
    const body = JSON.stringify({ events: [TASK_EVENT('task-1')] })
    const signature = sign(body)
    const tampered = JSON.stringify({ events: [TASK_EVENT('task-EVIL')] })
    const res = await POST(req(tampered, { 'x-hook-signature': signature }), { params })
    expect(res.status).toBe(401)
  })

  it('401s for an unknown sync state — indistinguishable from an unregistered one', async () => {
    hoisted.loadAsanaWebhookAuth.mockResolvedValue(null)
    const body = JSON.stringify({ events: [] })
    const res = await POST(signed(body), { params })
    expect(res.status).toBe(401)
  })

  it('401s for a sync state that never completed a handshake (no secret)', async () => {
    hoisted.loadAsanaWebhookAuth.mockResolvedValue({ ...AUTH, webhookSecret: null })
    const body = JSON.stringify({ events: [] })
    const res = await POST(signed(body), { params })
    expect(res.status).toBe(401)
  })

  it('REGRESSION: 401s a PERFECTLY SIGNED delivery when no webhook_gid was ever saved', async () => {
    // The stolen-claim case. Someone racing Asana to an open pending window
    // lands their own secret — but our create call then never gets its challenge
    // answered, so no gid is ever persisted. Verifying on the secret alone would
    // hand that attacker a signing key for real actions; requiring the gid makes
    // the theft inert (it costs one registration attempt, which the next cron
    // tick retries).
    hoisted.loadAsanaWebhookAuth.mockResolvedValue({ ...AUTH, webhookGid: null })
    const body = JSON.stringify({ events: [TASK_EVENT('task-1')] })

    const res = await POST(signed(body), { params })

    expect(res.status).toBe(401)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('accepts the same delivery once the gid IS recorded', async () => {
    // The control for the test above: the signature and body are identical, so
    // the gid requirement is provably the only thing rejecting it.
    hoisted.loadAsanaWebhookAuth.mockResolvedValue({ ...AUTH, webhookGid: 'wh-1' })
    const body = JSON.stringify({ events: [TASK_EVENT('task-1')] })

    const res = await POST(signed(body), { params })

    expect(res.status).toBe(200)
    expect(hoisted.send).toHaveBeenCalledTimes(1)
  })
})

// ---- Deliveries ------------------------------------------------------------

describe('asana receiver — deliveries', () => {
  it('200s a signed HEARTBEAT without dispatching anything', async () => {
    // Empty events every ~8h. 24h of failures here and Asana deletes the webhook.
    const body = JSON.stringify({ events: [] })
    const res = await POST(signed(body), { params })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, heartbeat: true })
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('fires ONE inngest event carrying every changed task gid', async () => {
    const body = JSON.stringify({
      events: [TASK_EVENT('task-1'), TASK_EVENT('task-2')],
    })
    const res = await POST(signed(body), { params })

    expect(res.status).toBe(200)
    expect(hoisted.send).toHaveBeenCalledTimes(1)
    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'tasks/asana-remote-change',
      data: { syncStateId: SYNC_STATE_ID, workspaceId: 'ws-1', taskGids: ['task-1', 'task-2'] },
    })
  })

  it('DEDUPES repeated gids in one batch (one re-GET, not five)', async () => {
    const body = JSON.stringify({
      events: [TASK_EVENT('task-1'), TASK_EVENT('task-1'), TASK_EVENT('task-1')],
    })
    await POST(signed(body), { params })

    const [payload] = hoisted.send.mock.calls[0] as unknown as [
      { data: { taskGids: string[] } },
    ]
    expect(payload.data.taskGids).toEqual(['task-1'])
  })

  it('ignores non-task resources and non-changed actions', async () => {
    const body = JSON.stringify({
      events: [
        { action: 'changed', resource: { gid: 'proj-1', resource_type: 'project' } },
        { action: 'added', resource: { gid: 'task-new', resource_type: 'task' } },
        { action: 'deleted', resource: { gid: 'task-gone', resource_type: 'task' } },
        TASK_EVENT('task-keep'),
      ],
    })
    await POST(signed(body), { params })

    const [payload] = hoisted.send.mock.calls[0] as unknown as [
      { data: { taskGids: string[] } },
    ]
    expect(payload.data.taskGids).toEqual(['task-keep'])
  })

  it('200s with tasks:0 and no dispatch when nothing in the batch is relevant', async () => {
    const body = JSON.stringify({
      events: [{ action: 'changed', resource: { gid: 'p', resource_type: 'project' } }],
    })
    const res = await POST(signed(body), { params })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, tasks: 0 })
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('still 200s when the inngest send fails (never re-punish a delivery)', async () => {
    // Asana is at-most-once: a non-200 wins us nothing and counts toward the
    // 24h teardown. The reconcile sweep is the recovery path.
    hoisted.send.mockRejectedValue(new Error('inngest down'))
    const body = JSON.stringify({ events: [TASK_EVENT('task-1')] })
    const res = await POST(signed(body), { params })
    expect(res.status).toBe(200)
  })

  it('200s an unparseable body that carried a VALID signature', async () => {
    const res = await POST(signed('not json at all'), { params })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ skipped: 'unparseable_body' })
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('tolerates a non-array events key', async () => {
    const body = JSON.stringify({ events: { nope: true } })
    const res = await POST(signed(body), { params })
    expect(res.status).toBe(200)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('skips events with a missing/blank gid', async () => {
    const body = JSON.stringify({
      events: [
        { action: 'changed', resource: { resource_type: 'task' } },
        { action: 'changed', resource: { gid: '', resource_type: 'task' } },
        TASK_EVENT('task-ok'),
      ],
    })
    await POST(signed(body), { params })
    const [payload] = hoisted.send.mock.calls[0] as unknown as [
      { data: { taskGids: string[] } },
    ]
    expect(payload.data.taskGids).toEqual(['task-ok'])
  })
})
