import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for POST /api/webhooks/jira — the Jira→Native Intelligence receiver.
 *
 * This endpoint is UNAUTHENTICATED and that is a platform fact, not an
 * oversight: dynamic (REST-registered) webhooks cannot carry a shared secret at
 * all, and the bearer token the docs describe has no documented issuer or JWKS
 * and is reported not to arrive. So the tests below pin down the ONLY defence
 * that is actually available — the payload is a wake-up trigger and nothing in
 * it is ever trusted or written:
 *
 *  - No header is required and none is inspected. A delivery with no
 *    Authorization header, or a forged one, is treated identically, because
 *    hard-failing on an unverifiable header would break real deliveries while
 *    stopping no attacker.
 *  - The ONLY thing lifted out of the body is issue ids. Status, changelog,
 *    user, `matchedWebhookIds` — none of it is read, so none of it can be
 *    spoofed into a write. jira-apply-remote re-fetches over an authenticated
 *    call, which is where trust actually lives.
 *  - The fan-out is CAPPED regardless of what arrives (the body is
 *    attacker-controllable, so "one delivery costs at most 25 Jira reads" has to
 *    be true by construction) and FILTERED to ids that already have a link, so
 *    a forged delivery naming issues nobody linked costs nothing at all.
 *  - Malformed, unexpected and empty bodies all 200: a non-2xx buys a retry of
 *    the same bytes and counts toward Jira's failure backoff.
 *  - The only inline work is ONE indexed link lookup (the amplification bound
 *    below); no Jira call and no write ever happens here, because Jira measures
 *    receiver latency and retries anything slow.
 */

const hoisted = vi.hoisted(() => ({
  send: vi.fn(async () => ({ ids: ['e'] })),
  /** external_ids that have a jira link. `null` makes the lookup FAIL. */
  linkedIds: [] as string[] | null,
  /** Every link lookup the receiver made: its filters, for assertion. */
  lookups: [] as Array<{ provider?: string; ids?: string[]; columns?: string }>,
}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.send } }))

/**
 * The one database read the receiver makes: which of these ids are linked?
 * `.select('external_id').eq('provider','jira').in('external_id', […])`.
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

const { POST } = await import('@/app/api/webhooks/jira/route')

function req(body: string, headers: Record<string, string> = {}): Request {
  return new Request('http://x/api/webhooks/jira', { method: 'POST', body, headers })
}

/** A `jira:issue_updated` delivery, trimmed to the fields we might read. */
function delivery(issueId: string, extra: Record<string, unknown> = {}): Request {
  return req(
    JSON.stringify({
      timestamp: 1_700_000_000_000,
      webhookEvent: 'jira:issue_updated',
      issue_event_type_name: 'issue_generic',
      user: { accountId: 'someone' },
      issue: { id: issueId, key: 'ENG-1', fields: { status: { name: 'Done' } } },
      changelog: { items: [{ field: 'status', toString: 'Done' }] },
      ...extra,
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.send.mockResolvedValue({ ids: ['e'] })
  hoisted.lookups = []
  // Everything the tests name is linked unless a test says otherwise.
  hoisted.linkedIds = [
    '10001',
    '10009',
    '1',
    '2',
    ...Array.from({ length: 200 }, (_, i) => `id-${i}`),
  ]
})

// ---- The happy path --------------------------------------------------------

describe('jira receiver — deliveries', () => {
  it('fires ONE inngest event carrying just the issue id', async () => {
    const res = await POST(delivery('10001'))

    expect(res.status).toBe(200)
    expect(hoisted.send).toHaveBeenCalledTimes(1)
    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'tasks/jira-remote-change',
      data: { issueIds: ['10001'] },
    })
  })

  it('carries NOTHING else from the body — not the status, not the changelog', async () => {
    // The whole security model in one assertion: an attacker who forges a
    // delivery cannot state an outcome, only name an issue we then re-read.
    await POST(delivery('10001'))
    const [payload] = hoisted.send.mock.calls[0] as unknown as [{ data: Record<string, unknown> }]
    expect(Object.keys(payload.data)).toEqual(['issueIds'])
  })

  it('accepts a delivery with NO Authorization header at all', async () => {
    // Documented-but-unobserved bearer auth: requiring it would break real
    // deliveries, and trusting it would be theatre. We do neither.
    const res = await POST(delivery('10001'))
    expect(res.status).toBe(200)
    expect(hoisted.send).toHaveBeenCalled()
  })

  it('treats a FORGED Authorization header exactly like an absent one', async () => {
    const res = await POST(
      req(JSON.stringify({ issue: { id: '10001' } }), {
        authorization: 'Bearer totally-made-up',
      }),
    )
    expect(res.status).toBe(200)
    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'tasks/jira-remote-change',
      data: { issueIds: ['10001'] },
    })
  })

  it('handles a deleted-issue delivery the same way (no special casing)', async () => {
    // `jira:issue_deleted` needs no branch here: the re-fetch downstream 404s,
    // which is what marks the link.
    const res = await POST(
      req(JSON.stringify({ webhookEvent: 'jira:issue_deleted', issue: { id: '10009' } })),
    )
    expect(res.status).toBe(200)
    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'tasks/jira-remote-change',
      data: { issueIds: ['10009'] },
    })
  })

  it('normalizes a NUMERIC id — external_id is text', async () => {
    await POST(req(JSON.stringify({ issue: { id: 10001 } })))
    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'tasks/jira-remote-change',
      data: { issueIds: ['10001'] },
    })
  })
})

// ---- Defensive parsing -----------------------------------------------------

describe('jira receiver — untrusted body', () => {
  it('200s an unparseable body without dispatching', async () => {
    const res = await POST(req('not json at all'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ skipped: 'unparseable_body' })
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('200s a top-level array or scalar', async () => {
    expect((await POST(req('[1,2,3]'))).status).toBe(200)
    expect((await POST(req('"hello"'))).status).toBe(200)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('200s a body with no issue at all (heartbeat-ish)', async () => {
    const res = await POST(req(JSON.stringify({ webhookEvent: 'jira:issue_updated' })))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, issues: 0 })
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('200s an issue with a missing / blank / wrongly-typed id', async () => {
    for (const issue of [{}, { id: '' }, { id: null }, { id: { nested: true } }, 'string']) {
      hoisted.send.mockClear()
      const res = await POST(req(JSON.stringify({ issue })))
      expect(res.status).toBe(200)
      expect(hoisted.send).not.toHaveBeenCalled()
    }
  })

  it('tolerates an ARRAY of issues and dedupes them', async () => {
    // Defensive only — the documented shape is one issue per delivery — but
    // JRACLOUD-94048 (inconsistent webhook payload fields) is open, so the
    // receiver bends rather than breaks.
    const res = await POST(
      req(JSON.stringify({ issue: [{ id: '1' }, { id: '2' }, { id: '1' }] })),
    )
    expect(res.status).toBe(200)
    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'tasks/jira-remote-change',
      data: { issueIds: ['1', '2'] },
    })
  })

  it('CAPS the fan-out at 25 no matter how many ids the body claims', async () => {
    // The body is attacker-controllable; the cost of one delivery must be
    // bounded by our own code, not by the sender's restraint.
    const issue = Array.from({ length: 200 }, (_, i) => ({ id: `id-${i}` }))
    const res = await POST(req(JSON.stringify({ issue })))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ issues: 25 })
    const [payload] = hoisted.send.mock.calls[0] as unknown as [{ data: { issueIds: string[] } }]
    expect(payload.data.issueIds).toHaveLength(25)
  })
})

// ---- The amplification bound -----------------------------------------------

/**
 * REGRESSION (review finding: "forged webhook delivery amplifies into unbounded
 * authenticated Jira calls across every tenant").
 *
 * The 25-id cap bounds IDS, not WORK: downstream, those 25 ids used to resolve
 * to every matching link in the fleet — across all workspaces, no limit — and
 * each link cost one authenticated Jira GET charged against that tenant's share
 * of the app-wide Atlassian quota. Jira issue ids are small sequential integers
 * starting at 10000 on every site, so a guess hits real links in essentially
 * every connected workspace, and the endpoint is unauthenticated and always
 * 200s. One HTTP POST, N tenants degraded.
 *
 * The filter below is not authentication and doesn't pretend to be — an attacker
 * who knows a real linked id still causes that issue to be re-read, which is
 * what a genuine delivery does anyway. It removes the AMPLIFICATION: naming ids
 * nobody linked is free.
 */
describe('jira receiver — only ids that already have a link are enqueued', () => {
  it('dispatches NOTHING for a delivery naming unlinked issues', async () => {
    hoisted.linkedIds = []
    const res = await POST(delivery('10001'))

    expect(res.status).toBe(200)
    // The OBSERVABLE assertion is the absence of the dispatch, not the body —
    // see the byte-identical-response regression below.
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('enqueues ONLY the linked subset of a 25-id sweep', async () => {
    // The shape of the attack: ids 10000–10024, of which one happens to exist.
    hoisted.linkedIds = ['10007']
    const issue = Array.from({ length: 25 }, (_, i) => ({ id: String(10000 + i) }))

    await POST(req(JSON.stringify({ issue })))

    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'tasks/jira-remote-change',
      data: { issueIds: ['10007'] },
    })
  })

  /**
   * REGRESSION (round-1 audit, webhook-security issue 0): the filter's own
   * result must never reach the wire.
   *
   * Reporting the POST-filter count turned this unauthenticated, always-200
   * endpoint into a free cross-tenant oracle: POST one id at a time, read
   * `{issues:1}` vs `{issues:0}`, and enumerate exactly which Jira issue ids
   * have a Native Intelligence link ANYWHERE in the fleet — which is precisely the target list
   * for the half of the amplification the filter does not close (a genuinely
   * linked id still fans out to every matching link in every workspace).
   *
   * So the body is derived from the CALLER'S OWN INPUT and nothing else. The
   * filtering stays, internally, where it still gates the enqueue.
   */
  it('answers a LINKED and an UNLINKED id with a byte-identical body', async () => {
    hoisted.linkedIds = ['10001']
    const linked = await POST(delivery('10001'))
    const linkedBody = await linked.text()

    hoisted.linkedIds = []
    const unlinked = await POST(delivery('10001'))
    const unlinkedBody = await unlinked.text()

    expect(unlinked.status).toBe(linked.status)
    expect(unlinkedBody).toBe(linkedBody)
    // …and the difference that MATTERS still happened, out of the attacker's
    // sight: only the linked delivery was dispatched.
    expect(hoisted.send).toHaveBeenCalledTimes(1)
  })

  it('reports the count the CALLER sent, not the count that matched', async () => {
    hoisted.linkedIds = ['10007']
    const issue = Array.from({ length: 4 }, (_, i) => ({ id: String(10005 + i) }))

    const res = await POST(req(JSON.stringify({ issue })))

    expect(await res.json()).toEqual({ ok: true, issues: 4 })
  })

  it('asks ONE indexed question, scoped to the jira provider', async () => {
    await POST(delivery('10001'))

    expect(hoisted.lookups).toHaveLength(1)
    expect(hoisted.lookups[0]).toMatchObject({
      columns: 'external_id',
      provider: 'jira',
      ids: ['10001'],
    })
  })

  it('fails CLOSED when the lookup itself fails', async () => {
    // A dropped delivery is repaired by the 6-hourly reconcile sweep; enqueueing
    // unfiltered during a database blip would hand the amplification straight
    // back to whoever is POSTing at the time.
    hoisted.linkedIds = null
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await POST(delivery('10001'))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ skipped: 'link_lookup_failed' })
    expect(hoisted.send).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

// ---- Never punish a delivery -----------------------------------------------

describe('jira receiver — failure handling', () => {
  it('still 200s when the inngest send fails', async () => {
    // A non-2xx earns 5 retries over 5–15 minutes and counts toward the 30-minute
    // slow-down, buying nothing: the reconcile sweep is the recovery path, and a
    // 3LO app can't even query Atlassian for what it dropped.
    hoisted.send.mockRejectedValue(new Error('inngest down'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await POST(delivery('10001'))

    expect(res.status).toBe(200)
    errSpy.mockRestore()
  })

  it('does no de-duplication of its own (the CAS downstream is the guard)', async () => {
    // Jira may deliver the same event more than once. Both deliveries dispatch;
    // applyRemoteTaskState's compare-and-swap makes the second a no-op, so an
    // idempotency table here would only duplicate a guarantee that exists.
    await POST(delivery('10001'))
    await POST(delivery('10001'))
    expect(hoisted.send).toHaveBeenCalledTimes(2)
  })
})
