import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The signature compare must stay CONSTANT-TIME, and that is not observable
 * behaviourally: `expected === provided` returns the identical boolean for every
 * signature case below, so a downgrade to `===` (or to a plain string compare
 * without the Uint8Array wrapper) would leave the whole suite green while
 * reopening a byte-at-a-time timing oracle over the hex digest. Spying on the
 * primitive is the only way to pin it — `importOriginal` is spread back in so the
 * helpers' own createHmac keeps working.
 */
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) }
})

/**
 * Tests for POST /api/webhooks/linear — the Linear→Native Intelligence receiver.
 *
 * The structural difference from the Jira sibling next door: this endpoint is
 * SIGNED. Linear hex-HMACs the raw request body with the app's signing secret
 * and sends it as `Linear-Signature`, so unlike Jira's forgeable receiver there
 * IS a real authentication boundary here, and these tests pin it:
 *
 *  - the signature is computed over the RAW BYTES. Re-serializing the parsed
 *    JSON before verifying would break on any payload whose key order or number
 *    formatting doesn't round-trip, so the test signs a body with deliberately
 *    non-canonical spacing and expects it to verify.
 *  - a missing `LINEAR_WEBHOOK_SECRET` FAILS CLOSED (503). An unverifiable
 *    delivery accepted "because the env isn't configured yet" is the whole
 *    security property, silently off.
 *  - a bad signature is 401 and dispatches nothing.
 *  - `webhookTimestamp` outside ±60s is rejected — Linear documents it as the
 *    replay guard, and a valid signature is replayable forever without it.
 *
 * Everything downstream of verification mirrors the Jira receiver on purpose,
 * because the reasoning is identical: the body is a WAKE-UP TRIGGER. Only issue
 * UUIDs are lifted out of it, capped at 25, pre-filtered to ids that already
 * have a link, and the response is derived from the CALLER'S OWN INPUT so the
 * endpoint can't be used as a cross-tenant "is this issue linked?" oracle.
 * linear-apply-remote re-fetches every issue over an authenticated call, which
 * is where correctness (as opposed to authenticity) actually lives — and which
 * is also what makes the unverified shape of `data.state` a non-problem.
 */

const SECRET = 'shhh-linear-signing-secret'

const hoisted = vi.hoisted(() => ({
  send: vi.fn(async () => ({ ids: ['e'] })),
  /** external_ids that have a linear link. `null` makes the lookup FAIL. */
  linkedIds: [] as string[] | null,
  /** Every link lookup the receiver made: its filters, for assertion. */
  lookups: [] as Array<{ provider?: string; ids?: string[]; columns?: string }>,
}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.send } }))

/**
 * The one database read the receiver makes: which of these ids are linked?
 * `.select('external_id').eq('provider','linear').in('external_id', […])`.
 */
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: () => {
      const call: { provider?: string; ids?: string[]; columns?: string } = {}
      hoisted.lookups.push(call)
      const chain: Record<string, unknown> = {
        select: (columns: string) => {
          call.columns = columns
          return chain
        },
        eq: (col: string, val: string) => {
          if (col === 'provider') call.provider = val
          return chain
        },
        in: (_col: string, ids: string[]) => {
          call.ids = ids
          return Promise.resolve(
            hoisted.linkedIds === null
              ? { data: null, error: { message: 'pooler down' } }
              : {
                  data: ids
                    .filter((id) => hoisted.linkedIds!.includes(id))
                    .map((id) => ({ external_id: id })),
                  error: null,
                },
          )
        },
      }
      return chain
    },
  }),
}))

const { POST } = await import('@/app/api/webhooks/linear/route')

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

/** A signed request over EXACTLY these bytes. */
function signed(body: string, headers: Record<string, string> = {}): Request {
  return new Request('http://x/api/webhooks/linear', {
    method: 'POST',
    body,
    headers: { 'linear-signature': sign(body), ...headers },
  })
}

/** An `Issue` update delivery, trimmed to the fields we might read. */
function deliveryBody(
  issueId: string,
  extra: Record<string, unknown> = {},
  at = Date.now(),
): string {
  return JSON.stringify({
    action: 'update',
    type: 'Issue',
    actor: { id: 'someone', name: 'Someone' },
    data: {
      id: issueId,
      identifier: 'ENG-1',
      title: 'Ship it',
      state: { id: 'st-1', name: 'Done', type: 'completed' },
    },
    updatedFrom: { stateId: 'st-0' },
    url: 'https://linear.app/acme/issue/ENG-1',
    organizationId: 'org-1',
    webhookId: 'wh-1',
    webhookTimestamp: at,
    ...extra,
  })
}

const delivery = (issueId: string, extra: Record<string, unknown> = {}) =>
  signed(deliveryBody(issueId, extra))

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('LINEAR_WEBHOOK_SECRET', SECRET)
  hoisted.send.mockResolvedValue({ ids: ['e'] })
  hoisted.lookups = []
  hoisted.linkedIds = [
    'iss-1',
    'iss-2',
    'iss-9',
    ...Array.from({ length: 200 }, (_, i) => `id-${i}`),
  ]
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ---- Signature verification: the boundary ---------------------------------

describe('linear receiver — signature', () => {
  it('accepts a correctly signed delivery and dispatches the issue id', async () => {
    const res = await POST(delivery('iss-1'))

    expect(res.status).toBe(200)
    expect(hoisted.send).toHaveBeenCalledTimes(1)
    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'tasks/linear-remote-change',
      data: { issueIds: ['iss-1'], organizationId: 'org-1' },
    })
    // The ACCEPT path runs through the constant-time compare too — a `===` fast
    // path that only falls back to it on mismatch would still leak.
    expect(vi.mocked(timingSafeEqual)).toHaveBeenCalledTimes(1)
  })

  it('401s an invalid signature and dispatches nothing', async () => {
    const body = deliveryBody('iss-1')
    const res = await POST(
      new Request('http://x/api/webhooks/linear', {
        method: 'POST',
        body,
        headers: { 'linear-signature': sign(body, 'wrong-secret') },
      }),
    )

    expect(res.status).toBe(401)
    expect(hoisted.send).not.toHaveBeenCalled()
    // Not even the link lookup runs — verification comes first.
    expect(hoisted.lookups).toHaveLength(0)
  })

  it('401s a MISSING signature header', async () => {
    const res = await POST(
      new Request('http://x/api/webhooks/linear', {
        method: 'POST',
        body: deliveryBody('iss-1'),
      }),
    )
    expect(res.status).toBe(401)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('401s a signature of the right SHAPE but the wrong value', async () => {
    // A same-length hex string: the compare must be over content, and a
    // length-only pre-check must not be mistaken for verification.
    const body = deliveryBody('iss-1')
    const wrong = sign(body).replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))
    const res = await POST(
      new Request('http://x/api/webhooks/linear', {
        method: 'POST',
        body,
        headers: { 'linear-signature': wrong },
      }),
    )
    expect(res.status).toBe(401)
    expect(hoisted.send).not.toHaveBeenCalled()
    // …and it was REJECTED BY THE CONSTANT-TIME COMPARE, not by a `===` that
    // leaks how many leading bytes were right.
    expect(vi.mocked(timingSafeEqual)).toHaveBeenCalledTimes(1)
  })

  it('verifies the RAW BYTES, not a re-serialization of the parsed body', async () => {
    // Two hazards in one body.
    //
    // Non-canonical spacing and key order: JSON.stringify(JSON.parse(body))
    // produces different bytes, so a receiver that re-serializes before hashing
    // rejects this — and would reject a share of real deliveries.
    //
    // MULTI-BYTE characters: for an ASCII body latin1 and utf8 produce identical
    // bytes, so an encoding divergence in the HMAC input (a `Buffer.from(raw,
    // 'latin1')`, a re-decode of the body) is invisible. An issue title with an
    // accent or an emoji is routine in real Linear data, and every such delivery
    // would 401 — earning Linear's three-strike retries and eventually a
    // silently disabled webhook, leaving read-back on the 6-hourly sweep alone.
    const body =
      '{ "webhookTimestamp": ' +
      Date.now() +
      ',\n  "type":"Issue",  "action":"update",\n' +
      '  "organizationId":"org-1", "data": {"id": "iss-1", "title":"Café ☕ émoji"} }'

    const res = await POST(signed(body))

    expect(res.status).toBe(200)
    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'tasks/linear-remote-change',
      data: { issueIds: ['iss-1'], organizationId: 'org-1' },
    })
  })

  it('FAILS CLOSED with 503 when LINEAR_WEBHOOK_SECRET is unset', async () => {
    // The alternative — "no secret configured, so accept everything" — silently
    // turns the one real authentication boundary this integration has into a
    // public write trigger.
    vi.stubEnv('LINEAR_WEBHOOK_SECRET', '')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await POST(delivery('iss-1'))

    expect(res.status).toBe(503)
    expect(hoisted.send).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

// ---- Replay guard ----------------------------------------------------------

describe('linear receiver — timestamp', () => {
  it('accepts a delivery inside the ±60s window', async () => {
    const res = await POST(signed(deliveryBody('iss-1', {}, Date.now() - 30_000)))
    expect(res.status).toBe(200)
    expect(hoisted.send).toHaveBeenCalled()
  })

  it('rejects a STALE delivery even though the signature is valid', async () => {
    // A captured delivery stays perfectly signed forever; the timestamp is the
    // only thing that expires it.
    const res = await POST(signed(deliveryBody('iss-1', {}, Date.now() - 10 * 60_000)))

    expect(res.status).toBe(401)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('rejects a delivery timestamped far in the FUTURE', async () => {
    const res = await POST(signed(deliveryBody('iss-1', {}, Date.now() + 10 * 60_000)))
    expect(res.status).toBe(401)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('rejects a delivery with NO usable timestamp', async () => {
    // Signature-valid but unbounded in time. Treated as a replay rather than
    // waved through: Linear always sends it, so its absence is anomalous.
    const body = JSON.stringify({ type: 'Issue', data: { id: 'iss-1' } })
    const res = await POST(signed(body))
    expect(res.status).toBe(401)
    expect(hoisted.send).not.toHaveBeenCalled()
  })
})

// ---- Event filtering -------------------------------------------------------

describe('linear receiver — event types', () => {
  it('200s and ignores a non-Issue resource type', async () => {
    // Linear also delivers Comment, Project, Cycle, Reaction and the
    // OAuthApp-revoked notification on the same app-level webhook. Every one of
    // them must be a clean no-op rather than a crash.
    for (const type of ['Comment', 'Project', 'Cycle', 'OAuthApp', 'IssueLabel']) {
      hoisted.send.mockClear()
      const res = await POST(signed(deliveryBody('iss-1', { type })))
      expect(res.status).toBe(200)
      expect(hoisted.send).not.toHaveBeenCalled()
    }
  })

  it('handles a REMOVE action the same way as an update (no special casing)', async () => {
    // A deleted issue needs no branch here: the authenticated re-fetch
    // downstream answers null, which is what marks the link.
    const res = await POST(signed(deliveryBody('iss-9', { action: 'remove' })))
    expect(res.status).toBe(200)
    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'tasks/linear-remote-change',
      data: { issueIds: ['iss-9'], organizationId: 'org-1' },
    })
  })
})

// ---- Defensive parsing -----------------------------------------------------

describe('linear receiver — untrusted body', () => {
  it('200s an unparseable body without dispatching', async () => {
    // Signed garbage is still garbage; a non-2xx just buys a retry of the same
    // bytes and counts toward Linear's 3-strike disable.
    const res = await POST(signed('not json at all'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ skipped: 'unparseable_body' })
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('200s a top-level array or scalar', async () => {
    expect((await POST(signed('[1,2,3]'))).status).toBe(200)
    expect((await POST(signed('"hello"'))).status).toBe(200)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('200s an Issue delivery with a missing / blank / wrongly-typed id', async () => {
    for (const data of [{}, { id: '' }, { id: null }, { id: 42 }, { id: { n: 1 } }, 'str']) {
      hoisted.send.mockClear()
      const res = await POST(
        signed(
          JSON.stringify({ type: 'Issue', data, webhookTimestamp: Date.now() }),
        ),
      )
      expect(res.status).toBe(200)
      expect(hoisted.send).not.toHaveBeenCalled()
    }
  })

  it('tolerates an ARRAY of issues and dedupes them', async () => {
    const res = await POST(
      signed(
        JSON.stringify({
          type: 'Issue',
          data: [{ id: 'iss-1' }, { id: 'iss-2' }, { id: 'iss-1' }],
          organizationId: 'org-1',
          webhookTimestamp: Date.now(),
        }),
      ),
    )
    expect(res.status).toBe(200)
    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'tasks/linear-remote-change',
      data: { issueIds: ['iss-1', 'iss-2'], organizationId: 'org-1' },
    })
  })

  it('CAPS the fan-out at 25 no matter how many ids the body claims', async () => {
    const data = Array.from({ length: 200 }, (_, i) => ({ id: `id-${i}` }))
    const res = await POST(
      signed(
        JSON.stringify({ type: 'Issue', data, webhookTimestamp: Date.now() }),
      ),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ issues: 25 })
    const [payload] = hoisted.send.mock.calls[0] as unknown as [
      { data: { issueIds: string[] } },
    ]
    expect(payload.data.issueIds).toHaveLength(25)
  })

  it('omits organizationId when the body does not carry a usable one', async () => {
    // The org id is a defence-in-depth hint for the read-back, never a
    // requirement — a delivery without one still converges.
    await POST(
      signed(
        JSON.stringify({
          type: 'Issue',
          data: { id: 'iss-1' },
          organizationId: 42,
          webhookTimestamp: Date.now(),
        }),
      ),
    )
    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'tasks/linear-remote-change',
      data: { issueIds: ['iss-1'] },
    })
  })
})

// ---- The amplification bound -----------------------------------------------

describe('linear receiver — only ids that already have a link are enqueued', () => {
  it('dispatches NOTHING for a delivery naming unlinked issues', async () => {
    hoisted.linkedIds = []
    const res = await POST(delivery('iss-1'))

    expect(res.status).toBe(200)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('enqueues ONLY the linked subset', async () => {
    hoisted.linkedIds = ['iss-2']
    const data = [{ id: 'iss-1' }, { id: 'iss-2' }, { id: 'iss-3' }]

    await POST(
      signed(
        JSON.stringify({
          type: 'Issue',
          data,
          organizationId: 'org-1',
          webhookTimestamp: Date.now(),
        }),
      ),
    )

    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'tasks/linear-remote-change',
      data: { issueIds: ['iss-2'], organizationId: 'org-1' },
    })
  })

  /**
   * The oracle regression, inherited from the Jira review. Signature
   * verification makes this endpoint far harder to probe than Jira's, but it is
   * not a reason to leak: an app-level signing secret is shared by every tenant
   * of the app, so anyone who can sign (including a Linear org that installed
   * the app legitimately) could otherwise enumerate which issue UUIDs have a
   * Native Intelligence link ANYWHERE in the fleet.
   */
  it('answers a LINKED and an UNLINKED id with a byte-identical body', async () => {
    hoisted.linkedIds = ['iss-1']
    const body = deliveryBody('iss-1', {}, 1_800_000_000_000)
    vi.setSystemTime(1_800_000_000_000)

    const linked = await POST(signed(body))
    const linkedBody = await linked.text()

    hoisted.linkedIds = []
    const unlinked = await POST(signed(body))
    const unlinkedBody = await unlinked.text()

    expect(unlinked.status).toBe(linked.status)
    expect(unlinkedBody).toBe(linkedBody)
    expect(hoisted.send).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('reports the count the CALLER sent, not the count that matched', async () => {
    hoisted.linkedIds = ['iss-2']
    const data = [{ id: 'iss-1' }, { id: 'iss-2' }, { id: 'iss-3' }, { id: 'iss-4' }]

    const res = await POST(
      signed(
        JSON.stringify({ type: 'Issue', data, webhookTimestamp: Date.now() }),
      ),
    )

    expect(await res.json()).toEqual({ ok: true, issues: 4 })
  })

  it('asks ONE indexed question, scoped to the linear provider', async () => {
    await POST(delivery('iss-1'))

    expect(hoisted.lookups).toHaveLength(1)
    expect(hoisted.lookups[0]).toMatchObject({
      columns: 'external_id',
      provider: 'linear',
      ids: ['iss-1'],
    })
  })

  it('fails CLOSED when the lookup itself fails', async () => {
    hoisted.linkedIds = null
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await POST(delivery('iss-1'))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ skipped: 'link_lookup_failed' })
    expect(hoisted.send).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

// ---- Never punish a delivery -----------------------------------------------

describe('linear receiver — failure handling', () => {
  it('still 200s when the inngest send fails', async () => {
    // Linear retries 3× (+1min/+1h/+6h) and may then DISABLE the webhook
    // outright. The reconcile sweep is the recovery path; earning strikes here
    // buys nothing.
    hoisted.send.mockRejectedValue(new Error('inngest down'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await POST(delivery('iss-1'))

    expect(res.status).toBe(200)
    errSpy.mockRestore()
  })

  it('does no de-duplication of its own (the CAS downstream is the guard)', async () => {
    await POST(delivery('iss-1'))
    await POST(delivery('iss-1'))
    expect(hoisted.send).toHaveBeenCalledTimes(2)
  })

  it('carries NOTHING from the body except ids and the org hint', async () => {
    // The unverified-shape trap in one assertion: the receiver never reads
    // `data.state` or `updatedFrom`, so their exact shape cannot matter.
    await POST(delivery('iss-1'))
    const [payload] = hoisted.send.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ]
    expect(Object.keys(payload.data).sort()).toEqual(['issueIds', 'organizationId'])
  })
})
