/**
 * POST /api/internal/live-agent/tool — the third, server-side ceiling layer
 * (LIVE-AGENT-DESIGN §5.3). Runs the REAL factories (createLiveAgentTools +
 * buildLiveAgentReadTools) over a fixture database; only the two read tools
 * needed to exercise output sanitization / execute failure are stubbed.
 *
 * Pins: both gates; the ceiling RE-DERIVED from the token (per turn type, per
 * resolved persona — never from the request); prototype-safe lookups; input
 * validation with model-readable details; the get_project_details tenancy
 * preflight; search_contacts' contact_visible_to fence (and traverse's contact labels); eval isolation threaded into the tools (never short-circuited
 * here); get_attachment_content's image bytes stripped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TOOL_IMAGE_NOT_SHOWN } from '@/lib/ai/tools/tool-image'
import type { SupabaseClient } from '@supabase/supabase-js'
import { tool } from 'ai'
import { z } from 'zod'
import {
  createFakeSupabase,
  eqValue,
  meetingFixture,
  FIX,
  type FakeQuery,
  type FixtureOptions,
} from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import {
  LIVE_AGENT_SECRET_HEADER,
  LIVE_AGENT_TOKEN_HEADER,
  mintLiveAgentRunToken,
  type LiveAgentTokenClaims,
} from '@/lib/live-agent/live-agent-run-token'

const h = vi.hoisted(() => ({
  client: null as unknown as SupabaseClient,
  log: [] as unknown[],
  stagingCalls: [] as unknown[][],
  readCalls: [] as unknown[][],
  broadcasts: [] as unknown[],
  appends: [] as unknown[],
  events: [] as Array<{ event: string; props: Record<string, unknown> }>,
  /** runDecision calls (the shadow nudge.worth check), and what each one answers with. */
  decisions: [] as unknown[][],
  decide: null as null | (() => Promise<unknown>),
}))

// The shadow nudge.worth check's Jev call: recorded, answering with h.decide
// (default: at once). Nothing else in this route calls runDecision.
vi.mock('@/lib/ai/decisions/run-decision', () => ({
  runDecision: (...args: unknown[]) => {
    h.decisions.push([...args, { broadcastsBefore: h.broadcasts.length, appendsBefore: h.appends.length }])
    return h.decide ? h.decide() : Promise.resolve({ status: 'accepted', value: 'send', inferenceId: 'i1', version: 'nudge-worth-v1' })
  },
}))

vi.mock('@/lib/live-agent/nudge-channel', async (orig) => ({
  ...(await orig<typeof import('@/lib/live-agent/nudge-channel')>()),
  broadcastNudge: async (n: unknown) => {
    h.broadcasts.push(n)
    return true
  },
}))

// Recorded, then the real writer runs (say_to_user's chat-row persist).
vi.mock('@/lib/live-agent/conversation-writer', async (orig) => {
  const real = await orig<typeof import('@/lib/live-agent/conversation-writer')>()
  return {
    ...real,
    appendAgentMessage: (...args: Parameters<typeof real.appendAgentMessage>) => {
      h.appends.push(args[1])
      return real.appendAgentMessage(...args)
    },
  }
})

vi.mock('@/lib/posthog', async (orig) => ({
  ...(await orig<typeof import('@/lib/posthog')>()),
  trackServerEvent: (event: string, _ctx: unknown, props: Record<string, unknown> = {}) => {
    h.events.push({ event, props })
  },
}))

vi.mock('@/lib/admin', async (orig) => ({
  ...(await orig<typeof import('@/lib/admin')>()),
  getServiceClient: () => h.client,
}))

vi.mock('@/lib/live-agent/tools', async (orig) => {
  const real = await orig<typeof import('@/lib/live-agent/tools')>()
  return {
    ...real,
    createLiveAgentTools: (...args: Parameters<typeof real.createLiveAgentTools>) => {
      h.stagingCalls.push(args)
      return real.createLiveAgentTools(...args)
    },
  }
})

vi.mock('@/lib/live-agent/read-tools', async (orig) => {
  const real = await orig<typeof import('@/lib/live-agent/read-tools')>()
  return {
    ...real,
    buildLiveAgentReadTools: (...args: Parameters<typeof real.buildLiveAgentReadTools>) => {
      h.readCalls.push(args)
      return {
        ...real.buildLiveAgentReadTools(...args),
        // Stand-ins for two allowlisted reads, to observe sanitization + failure.
        get_attachment_content: tool({
          description: 'stub',
          inputSchema: z.object({ attachment_id: z.string() }),
          execute: async () => ({
            signed_url: 'https://signed.example/a.png',
            mime_type: 'image/png',
            __imageBase64: 'AAAA',
            __imageMimeType: 'image/png',
          }),
        }),
        get_notifications: tool({
          description: 'stub',
          inputSchema: z.object({}),
          execute: async (): Promise<{ ok: true }> => {
            throw new Error('notifications backend down')
          },
        }),
      }
    },
  }
})

// The connected-app transport: the lookup path runs chat's REAL adapter
// (callExternalMcpTool: fencing, token-expired shape); only the dial is stubbed.
const mcp = vi.hoisted(() => ({
  callTool: vi.fn<(...args: unknown[]) => Promise<{ content: unknown; isError: boolean }>>(),
}))
vi.mock('@/lib/mcp-client/index', async (orig) => ({
  ...(await orig<typeof import('@/lib/mcp-client/index')>()),
  callTool: (...args: unknown[]) => mcp.callTool(...args),
}))

const { POST } = await import('../route')
const { McpTokenExpiredError } = await import('@/lib/mcp-client/index')
const { _resetLiveMcpCallsForTests } = await import('@/lib/live-agent/mcp-lookups')

const SECRET = 'live-internal-secret'

function claims(over: Partial<LiveAgentTokenClaims> = {}): Omit<LiveAgentTokenClaims, 'exp'> {
  return {
    captureId: FIX.captureId,
    workspaceId: FIX.workspaceId,
    userId: FIX.userId,
    currentMemberId: FIX.memberId,
    turnType: 'copilot',
    model: 'deepseek-v4-flash',
    isEvalCapture: false,
    allowAutoArchive: false,
    ...over,
  }
}

interface ExtraOptions {
  /** Contact rows the workspace-filtered search returns (defaults to one: ct-1). */
  contacts?: Array<{ id: string; full_name: string; email: string }>
  /**
   * `contact_visible_to(id, user)` answers by contact id: true/false, or
   * 'error' for an RPC error. A contact absent from the map is VISIBLE (ct-1 by default).
   */
  contactVisibility?: Record<string, boolean | 'error'>
  /** entity_link rows traverse reads (none by default). */
  edges?: Array<Record<string, unknown>>
}

/** The meeting fixture + contact rows + a workspace-scoped projects preflight. */
function withExtras(opts: FixtureOptions = {}, extra: ExtraOptions = {}) {
  const base = meetingFixture(opts)
  const contacts = extra.contacts ?? [{ id: 'ct-1', full_name: 'Ana Guest', email: 'ana@example.com' }]
  return (q: FakeQuery) => {
    if (q.table === 'contact' && q.op === 'select') {
      return { data: contacts, error: null }
    }
    if (q.table === 'entity_link' && q.op === 'select') {
      return { data: extra.edges ?? [], error: null }
    }
    if (q.table === 'rpc:contact_visible_to') {
      const args = q.payload as { p_contact_id: string; p_user_id: string }
      const v = extra.contactVisibility?.[args.p_contact_id] ?? true
      return v === 'error' ? { data: null, error: { message: 'rpc down' } } : { data: v, error: null }
    }
    if (q.table === 'projects' && q.columns === 'id') {
      const ok = eqValue(q, 'id') === FIX.projectId && eqValue(q, 'workspace_id') === FIX.workspaceId
      return { data: ok ? { id: FIX.projectId } : null, error: null }
    }
    return base(q)
  }
}

function useDb(opts: FixtureOptions = {}, extra: ExtraOptions = {}) {
  const fake = createFakeSupabase(withExtras(opts, extra))
  h.client = fake.client
  h.log = fake.log
  return fake
}

async function call(
  toolName: unknown,
  input: unknown,
  tokenClaims = claims(),
  headers: Record<string, string | null> = {},
) {
  const token = mintLiveAgentRunToken(tokenClaims)
  const hdrs: Record<string, string> = { 'content-type': 'application/json' }
  const secret = headers.secret === undefined ? SECRET : headers.secret
  if (secret !== null) hdrs[LIVE_AGENT_SECRET_HEADER] = secret
  const tok = headers.token === undefined ? token : headers.token
  if (tok !== null) hdrs[LIVE_AGENT_TOKEN_HEADER] = tok
  const res = await POST(
    new Request('https://app.test/api/internal/live-agent/tool', {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ toolName, input }),
    }),
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

beforeEach(() => {
  process.env.LIVE_AGENT_INTERNAL_SECRET = SECRET
  h.stagingCalls = []
  h.readCalls = []
  h.broadcasts = []
  h.appends = []
  h.events = []
  h.decisions = []
  h.decide = null
  useDb()
})

describe('gates', () => {
  it('401 without the internal secret', async () => {
    expect((await call('search_contacts', { query: 'a' }, claims(), { secret: null })).status).toBe(401)
    expect((await call('search_contacts', { query: 'a' }, claims(), { secret: 'wrong' })).status).toBe(401)
  })

  it('401 without a valid run token', async () => {
    expect((await call('search_contacts', { query: 'a' }, claims(), { token: null })).status).toBe(401)
    expect((await call('search_contacts', { query: 'a' }, claims(), { token: 'forged.sig' })).status).toBe(401)
  })

  it('400 on a missing toolName', async () => {
    expect((await call(undefined, {})).status).toBe(400)
    expect((await call(42, {})).status).toBe(400)
  })

  it('404 when the turn can’t be rebuilt (a batch token for a capture the caller doesn’t own)', async () => {
    useDb({ ownerUserId: 'someone-else' })
    const res = await call('search_contacts', { query: 'a' }, claims({ turnType: 'batch' }))
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('TURN_NOT_FOUND')
  })
})

describe('membership is RE-CHECKED on every call', () => {
  it('404 and NO tool runs once the caller’s member row is gone (revoked mid-token)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = useDb({ memberRevoked: true })
    const res = await call('search_contacts', { query: 'a' })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('TURN_NOT_FOUND')
    expect(h.stagingCalls).toHaveLength(0)
    expect(h.readCalls).toHaveLength(0)
    expect(fake.log.some((q) => q.table === 'contact')).toBe(false)
  })
})

describe('capture visibility is RE-CHECKED on every call (captures_select; no RLS on service role)', () => {
  it('404 and NO tool runs for a non-owner once the capture is PRIVATE', async () => {
    const fake = useDb({ ownerUserId: 'someone-else', visibility: 'private' })
    const res = await call('search_contacts', { query: 'a' })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('TURN_NOT_FOUND')
    expect(h.stagingCalls).toHaveLength(0)
    expect(h.readCalls).toHaveLength(0)
    expect(fake.log.some((q) => q.table === 'contact')).toBe(false)
  })

  it('a non-owner on a WORKSPACE-visible capture still runs', async () => {
    useDb({ ownerUserId: 'someone-else', visibility: 'workspace' })
    const res = await call('search_contacts', { query: 'a' })
    expect(res.status).toBe(200)
  })

  it('the owner on their own PRIVATE capture still runs', async () => {
    useDb({ visibility: 'private' })
    const res = await call('search_contacts', { query: 'a' })
    expect(res.status).toBe(200)
  })

  it('fails CLOSED for a non-owner when visibility is NULL (anything but an explicit workspace)', async () => {
    const fake = useDb({ ownerUserId: 'someone-else', visibility: null })
    const res = await call('search_contacts', { query: 'a' })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('TURN_NOT_FOUND')
    expect(h.stagingCalls).toHaveLength(0)
    expect(fake.log.some((q) => q.table === 'contact')).toBe(false)
  })

  it('the capture read SELECTS visibility (the check reads a real column, not a fixture default)', async () => {
    const fake = useDb()
    await call('search_contacts', { query: 'a' })
    const captureRead = fake.log.find((q) => q.table === 'captures' && q.columns.includes('is_eval'))
    expect(captureRead!.columns.split(',').map((c) => c.trim())).toContain('visibility')
  })
})

describe('search_contacts is fenced by contact_visible_to (service role: no RLS on contact)', () => {
  const PRIVATE = { id: 'ct-private', full_name: 'Ana Private', email: 'ana.p@example.com' }
  const SHARED = { id: 'ct-shared', full_name: 'Ana Shared', email: 'ana.s@example.com' }

  it('drops a contact the token user cannot see and keeps a visible one', async () => {
    const fake = useDb({}, { contacts: [PRIVATE, SHARED], contactVisibility: { 'ct-private': false, 'ct-shared': true } })
    const res = await call('search_contacts', { query: 'Ana' })
    expect(res.status).toBe(200)
    expect(res.body.output).toEqual({ contacts: [SHARED] })
    // Each row is fenced against the TOKEN's user — never a request-supplied one.
    const rpcs = fake.log.filter((q) => q.table === 'rpc:contact_visible_to')
    expect(rpcs.map((q) => q.payload)).toEqual([
      { p_contact_id: 'ct-private', p_user_id: FIX.userId },
      { p_contact_id: 'ct-shared', p_user_id: FIX.userId },
    ])
  })

  it('fails CLOSED: an RPC error drops the row', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    useDb({}, { contacts: [PRIVATE, SHARED], contactVisibility: { 'ct-private': 'error' } })
    const res = await call('search_contacts', { query: 'Ana' })
    expect(res.status).toBe(200)
    expect(res.body.output).toEqual({ contacts: [SHARED] })
  })

  it('over-fetches BEFORE the fence: hidden rows cannot crowd visible matches out', async () => {
    // Five hidden "Ana"s rank ahead of two visible ones; a 5-row fetch fenced
    // afterwards would have returned nothing.
    const hidden = Array.from({ length: 5 }, (_, i) => ({
      id: `ct-hidden-${i}`,
      full_name: `Ana Hidden ${i}`,
      email: `ana.h${i}@example.com`,
    }))
    const visible = [
      { id: 'ct-vis-1', full_name: 'Ana Visible', email: 'ana.v1@example.com' },
      { id: 'ct-vis-2', full_name: 'Ana Also', email: 'ana.v2@example.com' },
    ]
    const fake = useDb(
      {},
      {
        contacts: [...hidden, ...visible],
        contactVisibility: Object.fromEntries(hidden.map((c) => [c.id, false])),
      },
    )
    const res = await call('search_contacts', { query: 'Ana' })
    expect(res.status).toBe(200)
    expect(res.body.output).toEqual({ contacts: visible })
    const q = fake.log.find((x) => x.table === 'contact' && x.op === 'select')!
    expect(q.filters.find(([m]) => m === 'limit')).toEqual(['limit', 15])
  })

  it('never returns more than 5 visible contacts', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `ct-${i}`, full_name: `Ana ${i}`, email: `a${i}@x.com` }))
    useDb({}, { contacts: many })
    const res = await call('search_contacts', { query: 'Ana' })
    expect((res.body.output as { contacts: unknown[] }).contacts).toEqual(many.slice(0, 5))
  })

  it('a query with commas / parentheses / wildcards cannot alter the .or() filter', async () => {
    const fake = useDb()
    await call('search_contacts', { query: 'Ana%,id.neq.0),or(visibility.eq.private' })
    const q = fake.log.find((x) => x.table === 'contact' && x.op === 'select')!
    const or = q.filters.filter(([m]) => m === 'or')
    expect(or).toEqual([
      ['or', 'full_name.ilike.%Anaid.neq.0orvisibility.eq.private%,email.ilike.%Anaid.neq.0orvisibility.eq.private%'],
    ])
    // Still exactly the two intended conditions, workspace-scoped.
    expect(String(or[0][1]).split(',')).toHaveLength(2)
    expect(eqValue(q, 'workspace_id')).toBe(FIX.workspaceId)
  })

  it('a query of nothing but metacharacters returns no contacts without querying', async () => {
    const fake = useDb()
    const res = await call('search_contacts', { query: '%,()' })
    expect(res.body.output).toEqual({ contacts: [] })
    expect(fake.log.some((x) => x.table === 'contact')).toBe(false)
  })

  it('does not fence other tools’ output', async () => {
    const fake = useDb()
    await call('get_attachment_content', { attachment_id: 'att-1' })
    expect(fake.log.some((q) => q.table === 'rpc:contact_visible_to')).toBe(false)
  })
})

describe('list_contacts / get_contact are fenced inside the tool (service role: no RLS on contact)', () => {
  const PRIVATE = { id: 'ct-private', full_name: 'Ana Private', email: 'ana.p@example.com' }
  const SHARED = { id: 'ct-shared', full_name: 'Ana Shared', email: 'ana.s@example.com' }

  it("list_contacts never returns another member's private contact", async () => {
    useDb({}, { contacts: [PRIVATE, SHARED], contactVisibility: { 'ct-private': false } })
    const res = await call('list_contacts', {})
    expect(res.status).toBe(200)
    const out = res.body.output as { contacts: Array<{ id: string }>; count: number }
    expect(out.contacts.map((c) => c.id)).toEqual(['ct-shared'])
    expect(out.count).toBe(1)
  })

  it("get_contact by name skips another member's private contact", async () => {
    useDb({}, { contacts: [PRIVATE, SHARED], contactVisibility: { 'ct-private': false } })
    const res = await call('get_contact', { name: 'Ana' })
    expect(res.status).toBe(200)
    expect((res.body.output as { contact?: { id: string } }).contact?.id).toBe('ct-shared')
  })

  it("get_contact by id is not-found for another member's private contact", async () => {
    useDb({}, { contacts: [PRIVATE], contactVisibility: { 'ct-private': false } })
    const res = await call('get_contact', { contact_id: 'ct-private' })
    expect(res.status).toBe(200)
    expect(res.body.output).toEqual({ success: false, error: 'Contact not found' })
  })
})

describe('find / search contact hits are fenced inside the tool (service role: no RLS on contact)', () => {
  const PRIVATE = { id: 'ct-private', full_name: 'Ana Private', email: 'ana.p@example.com' }
  const SHARED = { id: 'ct-shared', full_name: 'Ana Shared', email: 'ana.s@example.com' }

  it("find never returns another member's private contact, fenced against the TOKEN user", async () => {
    const fake = useDb({}, { contacts: [PRIVATE, SHARED], contactVisibility: { 'ct-private': false } })
    const res = await call('find', { query: 'Ana', types: ['contact'] })
    expect(res.status).toBe(200)
    const out = res.body.output as { results: Array<{ result_id: string }> }
    expect(out.results.map((r) => r.result_id)).toEqual(['ct-shared'])
    expect(JSON.stringify(res.body)).not.toContain('Ana Private')
    const rpcs = fake.log.filter((q) => q.table === 'rpc:contact_visible_to')
    expect(new Set(rpcs.map((q) => (q.payload as { p_user_id: string }).p_user_id))).toEqual(new Set([FIX.userId]))
  })

  it("search never returns another member's private contact", async () => {
    useDb({}, { contacts: [PRIVATE, SHARED], contactVisibility: { 'ct-private': false } })
    const res = await call('search', { query: 'Ana', types: ['contact'] })
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.body)).toContain('ct-shared')
    expect(JSON.stringify(res.body)).not.toContain('ct-private')
    expect(JSON.stringify(res.body)).not.toContain('Ana Private')
  })

  it('find fails CLOSED: an RPC error drops the row', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    useDb({}, { contacts: [PRIVATE, SHARED], contactVisibility: { 'ct-private': 'error' } })
    const res = await call('find', { query: 'Ana', types: ['contact'] })
    expect(res.status).toBe(200)
    const out = res.body.output as { results: Array<{ result_id: string }> }
    expect(out.results.map((r) => r.result_id)).toEqual(['ct-shared'])
  })
})

describe('traverse contact labels are fenced inside the tool (service role: no RLS on contact)', () => {
  const PRIVATE = { id: 'ct-private', full_name: 'Ana Private', email: 'ana.p@example.com' }
  const SHARED = { id: 'ct-shared', full_name: 'Ana Shared', email: 'ana.s@example.com' }
  const edges = [
    { target_type: 'contact', target_id: 'ct-private', relation: 'related_to' },
    { target_type: 'contact', target_id: 'ct-shared', relation: 'related_to' },
  ]

  it("keeps a hidden contact's node but never its name, fenced against the TOKEN user", async () => {
    const fake = useDb({}, { contacts: [PRIVATE, SHARED], contactVisibility: { 'ct-private': false }, edges })
    const res = await call('traverse', { entity_type: 'project', entity_id: FIX.projectId, direction: 'outbound' })
    expect(res.status).toBe(200)
    const out = res.body.output as { outbound: Array<{ target_id: string; label: string | null }> }
    expect(out.outbound.map((e) => [e.target_id, e.label])).toEqual([
      ['ct-private', 'Contact (private)'],
      ['ct-shared', 'Ana Shared'],
    ])
    expect(JSON.stringify(res.body)).not.toContain('Ana Private')
    const rpcs = fake.log.filter((q) => q.table === 'rpc:contact_visible_to')
    expect(new Set(rpcs.map((q) => (q.payload as { p_user_id: string }).p_user_id))).toEqual(new Set([FIX.userId]))
  })
})

describe('the ceiling is RE-DERIVED from the token (structural, fail-closed)', () => {
  it.each(['create_action', 'accept_proposal', 'publish_prospect_list', 'push_action_to_linear', 'web_search', '__proto__', 'constructor'])(
    'refuses %s on a plain copilot turn',
    async (name) => {
      const res = await call(name, {})
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('TOOL_OUT_OF_CEILING')
    },
  )

  it('a paired NOTES turn cannot reach the talk tools', async () => {
    for (const name of ['say_to_user', 'ask_user']) {
      const res = await call(name, { message: 'hi', kind: 'info' }, claims({ turnType: 'notes' }))
      expect(res.status, name).toBe(403)
      expect(res.body.code).toBe('TOOL_OUT_OF_CEILING')
    }
  })

  it('an ASSIST-ONLY copilot cannot reach a record writer — assist-only is re-resolved from the recipe row', async () => {
    useDb({ recipes: { 'r-assist': { system_prompt: 'x', agent_config: { capture_mode: 'assist_only' }, model: null } } })
    for (const name of ['propose_change', 'write_summary', 'record_commitment', 'set_capture_title']) {
      const res = await call(name, {}, claims({ recipeId: 'r-assist' }))
      expect(res.status, name).toBe(403)
    }
  })

  it('a narrowed persona cannot reach a read it narrowed away', async () => {
    useDb({ recipes: { 'r-narrow': { system_prompt: 'x', agent_config: { enabled_tools: ['actions'] }, model: null } } })
    const res = await call('find', { query: 'x' }, claims({ recipeId: 'r-narrow' }))
    expect(res.status).toBe(403)
  })

  it('search_tools (read-only discovery) is always permitted', async () => {
    const res = await call('search_tools', { query: 'labels' })
    expect(res.status).toBe(200)
  })
})

describe('dispatch', () => {
  it('runs the REAL tool under the token’s tenancy', async () => {
    const fake = useDb()
    const res = await call('search_contacts', { query: 'Ana' })
    expect(res.status).toBe(200)
    expect(res.body.output).toEqual({ contacts: [{ id: 'ct-1', full_name: 'Ana Guest', email: 'ana@example.com' }] })
    const q = fake.log.find((x) => x.table === 'contact')
    expect(eqValue(q!, 'workspace_id')).toBe(FIX.workspaceId)
    // The capture's team/project and the assisted member come from the rows.
    const args = h.stagingCalls[0]
    expect(args.slice(0, 8)).toEqual([
      FIX.userId,
      h.client,
      FIX.workspaceId,
      FIX.captureId,
      FIX.teamId,
      FIX.projectId,
      FIX.memberId,
      FIX.memberName,
    ])
  })

  it('400 INPUT_INVALID with the Zod details the model can self-correct from', async () => {
    const res = await call('search_contacts', { query: 5 })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('INPUT_INVALID')
    expect(String(res.body.details)).toMatch(/query/)
  })

  it('500 TOOL_EXECUTE_FAILED when the real execute throws', async () => {
    const res = await call('get_notifications', {})
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'notifications backend down', code: 'TOOL_EXECUTE_FAILED' })
  })

  it('strips get_attachment_content’s inline image bytes (signed-URL fallback)', async () => {
    const res = await call('get_attachment_content', { attachment_id: 'att-1' })
    expect(res.status).toBe(200)
    expect(res.body.output).toEqual({ signed_url: 'https://signed.example/a.png', mime_type: 'image/png', image: TOOL_IMAGE_NOT_SHOWN })
  })
})

describe('get_project_details tenancy preflight (service-role client)', () => {
  it('refuses a project id outside the token’s workspace before the tool reads it', async () => {
    const fake = useDb()
    const res = await call('get_project_details', { project_id: 'proj-from-another-workspace' })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('NOT_FOUND_IN_WORKSPACE')
    expect(fake.log.some((q) => q.table === 'milestone')).toBe(false)
  })

  it('runs for a project in the workspace', async () => {
    const res = await call('get_project_details', { project_id: FIX.projectId })
    expect(res.status).toBe(200)
  })
})

describe('eval isolation is threaded into the tools, exactly as the cloud route threads it', () => {
  it('from the token claim', async () => {
    await call('search_contacts', { query: 'a' }, claims({ isEvalCapture: true }))
    expect(h.stagingCalls[0][9]).toEqual({ isEvalCapture: true })
    expect(h.readCalls[0][4]).toEqual({ omitPrivateCaptures: true })
  })

  it('from the capture row even if the claim says otherwise (isolation only tightens)', async () => {
    useDb({ isEval: true })
    await call('search_contacts', { query: 'a' }, claims({ isEvalCapture: false }))
    expect(h.stagingCalls[0][9]).toEqual({ isEvalCapture: true })
  })

  it('a real capture runs with isolation off', async () => {
    await call('search_contacts', { query: 'a' })
    expect(h.stagingCalls[0][9]).toEqual({ isEvalCapture: false })
    expect(h.readCalls[0][4]).toBeUndefined()
  })
})

describe('the time guard (copilot ticks): assist-only reads stop at 25 s, every nudge goes stale at 45 s', () => {
  const NOW = Date.parse('2026-10-18T12:00:00Z')
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  /** A tick whose window was flushed `ageMs` ago (a record-writing copilot). */
  const tick = (ageMs: number, over: Partial<LiveAgentTokenClaims> = {}) =>
    claims({ turnKind: 'tick', windowFlushedAt: NOW - ageMs, ...over })
  /** The same tick on an ASSIST-ONLY copilot (talks, writes no record). */
  const assistTick = (ageMs: number) => tick(ageMs, { recipeId: 'r-assist' })
  const useAssistDb = () =>
    useDb({
      recipes: {
        'r-assist': {
          system_prompt: 'x',
          // A raw tool name in enabled_tools narrows the reads to it (read-tool-names.ts).
          agent_config: { capture_mode: 'assist_only', enabled_tools: ['get_attachment_content'] },
          model: null,
        },
      },
    })
  const chatWrites = (log: FakeQuery[]) => log.filter((q) => q.table === 'chat_messages' || q.table === 'chat_conversations')

  it('assist-only: a read at 24.9 s runs; at 25.1 s it is refused with a normal tool result (no error, nothing run)', async () => {
    useAssistDb()
    const ok = await call('get_attachment_content', { attachment_id: 'a1' }, assistTick(24_900))
    expect(ok.status).toBe(200)
    expect((ok.body.output as Record<string, unknown>).signed_url).toBe('https://signed.example/a.png')

    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const refused = await call('get_attachment_content', { attachment_id: 'a1' }, assistTick(25_100))
    expect(refused.status).toBe(200)
    expect(refused.body.output).toEqual({
      refused: 'time_up',
      message: 'This moment has passed. Say what you have now in one line, or stay silent.',
    })
    expect(info).toHaveBeenCalledWith('[live-agent] time guard: refused get_attachment_content at 25100 ms')
    info.mockRestore()
  })

  it('a record-writing copilot (not assist-only) keeps its reads at 30 s', async () => {
    const res = await call('get_attachment_content', { attachment_id: 'a1' }, tick(30_000))
    expect(res.status).toBe(200)
    expect(res.body.output).not.toHaveProperty('refused')
    expect((res.body.output as Record<string, unknown>).signed_url).toBe('https://signed.example/a.png')
  })

  it('say_to_user at 44 s persists and broadcasts as usual', async () => {
    const res = await call('say_to_user', { message: 'Ask about the budget.' }, tick(44_000))
    expect(res.status).toBe(200)
    expect(h.appends).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ kind: 'say_to_user' }) })])
    expect(h.broadcasts).toEqual([expect.objectContaining({ message: 'Ask about the budget.' })])
    // One id: the row is written under the broadcast's id (ui_message.id).
    const nudgeId = (h.broadcasts[0] as { id: string }).id
    expect((h.appends[0] as { messageId?: string }).messageId).toBe(nudgeId)
    expect((res.body.output as { id?: string }).id).toBe(nudgeId)
  })

  it.each([
    ['a record-writing copilot', false],
    ['an assist-only copilot', true],
  ] as const)('%s: say_to_user at 46 s is dropped as stale (no chat row, no broadcast, a stale nudge-drop event)', async (_label, assist) => {
    const fake = assist ? useAssistDb() : useDb()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const res = await call('say_to_user', { message: 'Ask about the budget.' }, assist ? assistTick(46_000) : tick(46_000))
    info.mockRestore()
    expect(res.status).toBe(200)
    expect(res.body.output).toMatchObject({ dropped: 'stale', delivered: false })
    expect(h.broadcasts).toHaveLength(0)
    expect(h.appends).toHaveLength(0)
    expect(chatWrites(fake.log)).toHaveLength(0)
    expect(h.events).toEqual([
      {
        event: 'live_agent_nudge_drop',
        props: { capture_id: FIX.captureId, stage: 'time_guard', reason: 'stale', age_ms: 46_000 },
      },
    ])
  })

  it('without a flush time the window clock starts at the turn start (token mint)', async () => {
    useAssistDb()
    const token = mintLiveAgentRunToken(claims({ turnKind: 'tick', recipeId: 'r-assist' }))
    vi.setSystemTime(NOW + 25_100)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const res = await call('get_attachment_content', { attachment_id: 'a1' }, claims(), { token })
    info.mockRestore()
    expect(res.body.output).toMatchObject({ refused: 'time_up' })
  })

  it('write tools still run past the cutoff', async () => {
    const res = await call('search_projects', { query: 'x' }, tick(60_000))
    expect(res.status).toBe(200)
    expect(res.body.output).not.toHaveProperty('refused')
  })

  it('batch, notes and pre-guard tokens are unguarded', async () => {
    const batch = await call('get_attachment_content', { attachment_id: 'a1' }, claims({ turnType: 'batch', turnKind: 'batch', windowFlushedAt: NOW - 120_000 }))
    expect(batch.status).toBe(200)
    expect(batch.body.output).not.toHaveProperty('refused')
    const notes = await call('get_attachment_content', { attachment_id: 'a1' }, tick(120_000, { turnType: 'notes' }))
    expect(notes.body.output).not.toHaveProperty('refused')
    useAssistDb()
    const legacy = await call('say_to_user', { message: 'hi' }, claims({ recipeId: 'r-assist', windowFlushedAt: NOW - 120_000 }))
    expect(legacy.body.output).not.toHaveProperty('dropped')
  })
})

describe('the shadow nudge.worth check: after delivery, never awaited, never changes the result', () => {
  const NOW = Date.parse('2026-10-18T12:00:00Z')
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  const tick = (ageMs: number, over: Partial<LiveAgentTokenClaims> = {}) =>
    claims({ turnKind: 'tick', windowFlushedAt: NOW - ageMs, ...over })
  /** The fixture plus a goal for the call and the thread's say_to_user rows (this nudge's too, once written). */
  function useNudgeDb(opts: FixtureOptions = {}) {
    const base = withExtras(opts)
    const fake = createFakeSupabase((q) => {
      if (q.table === 'meeting_goal' && q.op === 'select') {
        return { data: { id: 'g1', calendar_event_id: 'ev', starts_at: '2026-10-18T11:00:00Z', capture_id: FIX.captureId,
          goal: 'Leave with a pilot start date', source: 'chat', updated_at: '2026-10-18T10:00:00Z' }, error: null }
      }
      if (q.table === 'chat_messages' && q.op === 'select' && eqValue(q, 'role') === 'assistant') {
        const written = h.appends.map((a) => ({
          ui_message: { id: (a as { messageId: string }).messageId, role: 'assistant', parts: [{ type: 'text', text: 'THIS NUDGE' }], metadata: { kind: 'say_to_user' } },
          created_at: '2026-10-18T11:59:59Z',
        }))
        return { data: [...written, { ui_message: { id: 'old-1', role: 'assistant', parts: [{ type: 'text', text: 'Ask who signs off on the budget.' }], metadata: { kind: 'say_to_user' } }, created_at: '2026-10-18T11:50:00Z' }], error: null }
      }
      return base(q)
    })
    h.client = fake.client
    h.log = fake.log
    return fake
  }
  const settle = () => vi.waitFor(() => expect(h.decisions).toHaveLength(1))

  it('fires runDecision(nudge.worth, shadow) after the nudge was written and broadcast, with its message_id', async () => {
    useNudgeDb()
    const res = await call('say_to_user', { message: 'Ask for a pilot start date.', kind: 'suggestion' },
      tick(10_000, { recentTail: 'Priya: We are keen to get going soon.' }))
    expect(res.status).toBe(200)
    const nudgeId = (res.body.output as { id: string }).id
    await settle()
    const [kind, input, ctx, order] = h.decisions[0] as [string, Record<string, unknown>, Record<string, unknown>, Record<string, number>]
    expect(kind).toBe('nudge.worth')
    expect(ctx).toEqual({ userId: FIX.userId, workspaceId: FIX.workspaceId, runId: FIX.captureId, mode: 'shadow', messageId: nudgeId })
    expect(input).toEqual({
      nudge: 'Ask for a pilot start date.',
      kind: 'suggestion',
      goal: 'Leave with a pilot start date',
      // This nudge's own row is left out of what was already told.
      alreadyTold: ['Ask who signs off on the budget.'],
      recent: 'Priya: We are keen to get going soon.',
    })
    // After delivery: the row and the broadcast were both done before Jev was asked.
    expect(order).toEqual({ broadcastsBefore: 1, appendsBefore: 1 })
  })

  it('the tool result resolves before the decision promise (zero added latency)', async () => {
    useNudgeDb()
    let release!: (v: unknown) => void
    let decided = false
    h.decide = () => new Promise((resolve) => { release = (v) => { decided = true; resolve(v) } })
    const res = await call('say_to_user', { message: 'Ask for a pilot start date.' }, tick(10_000))
    expect(res.status).toBe(200)
    expect(res.body.output).toMatchObject({ delivered: true })
    await settle()
    // The response is in hand while Jev is still thinking.
    expect(decided).toBe(false)
    release({ status: 'accepted', value: 'hold', inferenceId: 'i2', version: 'nudge-worth-v1' })
    await vi.waitFor(() => expect(decided).toBe(true))
  })

  it('a Jev failure never reaches the result: one log line', async () => {
    useNudgeDb()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.decide = () => Promise.reject(new Error('jev down'))
    const res = await call('say_to_user', { message: 'Ask for a pilot start date.' }, tick(10_000))
    expect(res.status).toBe(200)
    expect(res.body.output).toMatchObject({ delivered: true })
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[live-agent] nudge.worth shadow skipped:', 'jev down'))
    warn.mockRestore()
  })

  it('a stale nudge (dropped by the time guard) never calls Jev', async () => {
    useNudgeDb()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const res = await call('say_to_user', { message: 'Ask about the budget.' }, tick(46_000))
    info.mockRestore()
    expect(res.body.output).toMatchObject({ dropped: 'stale' })
    await new Promise((r) => setTimeout(r, 20))
    expect(h.decisions).toHaveLength(0)
  })

  it('an eval capture never calls Jev (claim or row)', async () => {
    useNudgeDb()
    await call('say_to_user', { message: 'Ask about the budget.' }, tick(10_000, { isEvalCapture: true }))
    useNudgeDb({ isEval: true })
    await call('say_to_user', { message: 'Ask about the budget.' }, tick(10_000))
    await new Promise((r) => setTimeout(r, 20))
    expect(h.broadcasts).toHaveLength(2)
    expect(h.decisions).toHaveLength(0)
  })

  it('no other tool calls Jev, and a nudge with no recentTail sends recent null', async () => {
    useNudgeDb()
    await call('search_contacts', { query: 'a' }, tick(10_000))
    await call('say_to_user', { message: 'Ask about the budget.' }, tick(10_000))
    await settle()
    expect((h.decisions[0][1] as { recent: unknown }).recent).toBeNull()
  })
})

describe('connected-app lookups (copilot turns): read-only, re-derived, bounded', () => {
  const JIRA = {
    id: 'srv-jira',
    user_id: FIX.userId,
    display_name: 'Jira',
    server_url: 'https://mcp.example.com/mcp',
    transport: 'streamable_http',
    auth_type: 'none',
    is_enabled: true,
    disabled_tools: [] as string[],
    require_approval_tools: [] as string[],
    tools_cache: [
      { name: 'getJiraIssue', description: 'Get an issue', annotations: { readOnlyHint: true } },
      // Mislabeled by the server: a write name with a read-only hint.
      { name: 'create_issue', description: 'Create', annotations: { readOnlyHint: true } },
      { name: 'list_projects', description: 'List', annotations: {} },
    ],
  }
  const LOOKUP = 'mcp__jira__getJiraIssue'
  const withLookups = (over: Partial<LiveAgentTokenClaims> = {}) => claims({ mcpLookups: true, ...over })
  const mcpReads = (log: unknown[]) => (log as FakeQuery[]).filter((q) => q.table === 'connected_mcp_server')

  beforeEach(() => {
    _resetLiveMcpCallsForTests()
    mcp.callTool.mockReset()
    mcp.callTool.mockResolvedValue({ isError: false, content: [{ type: 'text', text: 'ENG-1: In Progress' }] })
    useDb({ mcpServers: [JIRA] })
  })

  it('runs a lookup through chat’s adapter path on the token user’s own server; the result is fenced', async () => {
    const res = await call(LOOKUP, { key: 'ENG-1' }, withLookups())
    expect(res.status).toBe(200)
    expect(mcp.callTool).toHaveBeenCalledTimes(1)
    const [row, remote, args, opts] = mcp.callTool.mock.calls[0] as [Record<string, unknown>, string, unknown, { signal: AbortSignal }]
    expect(row.id).toBe('srv-jira')
    expect(remote).toBe('getJiraIssue')
    expect(args).toEqual({ key: 'ENG-1' })
    expect(opts.signal).toBeInstanceOf(AbortSignal)
    const output = res.body.output as { success: boolean; content: Array<{ text: string }> }
    expect(output.success).toBe(true)
    expect(output.content[0].text).toContain('ENG-1: In Progress')
    expect(output.content[0].text).toMatch(/UNTRUSTED/)
    // The servers are read by the TOKEN's user, enabled only.
    const read = mcpReads(h.log)[0]
    expect(eqValue(read, 'user_id')).toBe(FIX.userId)
    expect(eqValue(read, 'is_enabled')).toBe(true)
  })

  it('a write is unreachable: a mislabeled write and an unannotated name are out of the ceiling', async () => {
    for (const name of ['mcp__jira__create_issue', 'mcp__jira__list_projects', 'mcp__jira__mcp_confirm_call', 'mcp__nope__get_x']) {
      const res = await call(name, {}, withLookups())
      expect(res.status, name).toBe(403)
      expect(res.body.code).toBe('TOOL_OUT_OF_CEILING')
    }
    expect(mcp.callTool).not.toHaveBeenCalled()
  })

  it('a token without the mcpLookups stamp gets nothing, and the servers are never read', async () => {
    const res = await call(LOOKUP, {}, claims())
    expect(res.status).toBe(403)
    expect(mcpReads(h.log)).toHaveLength(0)
    expect(mcp.callTool).not.toHaveBeenCalled()
  })

  it('never on a notes or batch turn, or an eval capture', async () => {
    expect((await call(LOOKUP, {}, withLookups({ turnType: 'notes' }))).status).toBe(403)
    expect((await call(LOOKUP, {}, withLookups({ isEvalCapture: true }))).status).toBe(403)
    useDb({ mcpServers: [JIRA], isEval: true })
    expect((await call(LOOKUP, {}, withLookups())).status).toBe(403)
    expect(mcp.callTool).not.toHaveBeenCalled()
  })

  it('a workspace tool call never reads the connected servers', async () => {
    const res = await call('list_labels', {}, withLookups())
    expect(res.status).toBe(200)
    expect(mcpReads(h.log)).toHaveLength(0)
  })

  it('re-derived from the live rows: a tool disabled mid-call drops out at once', async () => {
    useDb({ mcpServers: [{ ...JIRA, disabled_tools: ['getJiraIssue'] }] })
    expect((await call(LOOKUP, {}, withLookups())).status).toBe(403)
    useDb({ mcpServers: [{ ...JIRA, require_approval_tools: ['getJiraIssue'] }] })
    expect((await call(LOOKUP, {}, withLookups())).status).toBe(403)
    expect(mcp.callTool).not.toHaveBeenCalled()
  })

  it('at most 3 per turn: the 4th is a normal refusal and never dials', async () => {
    const token = withLookups()
    const tokenString = mintLiveAgentRunToken(token)
    const send = () =>
      POST(
        new Request('https://app.test/api/internal/live-agent/tool', {
          method: 'POST',
          headers: { 'content-type': 'application/json', [LIVE_AGENT_SECRET_HEADER]: SECRET, [LIVE_AGENT_TOKEN_HEADER]: tokenString },
          body: JSON.stringify({ toolName: LOOKUP, input: {} }),
        }),
      ).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }))
    for (let i = 0; i < 3; i++) expect((await send()).status).toBe(200)
    const fourth = await send()
    expect(fourth.status).toBe(200)
    expect(fourth.body.output).toEqual({ refused: 'mcp_limit', message: "This call's 3 lookups are used. Answer with what you have." })
    expect(mcp.callTool).toHaveBeenCalledTimes(3)
    // Another turn (a fresh token) has its own three. A distinct claim, so the
    // token differs even when minted in the same millisecond.
    expect((await call(LOOKUP, {}, withLookups({ turnKind: 'tick' }))).status).toBe(200)
    expect(mcp.callTool).toHaveBeenCalledTimes(4)
  })

  it('an expired connection answers a normal tool result: re-authorise in Settings, do not retry', async () => {
    mcp.callTool.mockRejectedValue(new McpTokenExpiredError('Jira'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await call(LOOKUP, {}, withLookups())
    err.mockRestore()
    expect(res.status).toBe(200)
    expect(res.body.output).toEqual({
      success: false,
      code: 'MCP_TOKEN_EXPIRED',
      error: "That connection needs to be re-authorised in Settings; don't try it again this call.",
    })
  })

  it('a non-object input is refused before anything dials', async () => {
    const res = await call(LOOKUP, ['x'], withLookups())
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('INPUT_INVALID')
    expect(mcp.callTool).not.toHaveBeenCalled()
  })

  describe('the time guard covers lookups (assist-only copilots only)', () => {
    const NOW = Date.parse('2026-10-18T12:00:00Z')
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(NOW)
    })
    afterEach(() => vi.useRealTimers())
    const useAssistDb = () =>
      useDb({
        mcpServers: [JIRA],
        recipes: { 'r-assist': { system_prompt: 'x', agent_config: { capture_mode: 'assist_only' }, model: null } },
      })

    it('assist-only: refused past 25 s without dialing, and the refusal does not use up the cap', async () => {
      useAssistDb()
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      const late = await call(LOOKUP, {}, withLookups({ recipeId: 'r-assist', turnKind: 'tick', windowFlushedAt: NOW - 25_100 }))
      info.mockRestore()
      expect(late.status).toBe(200)
      expect(late.body.output).toEqual({ refused: 'time_up', message: 'This moment has passed. Say what you have now in one line, or stay silent.' })
      expect(mcp.callTool).not.toHaveBeenCalled()
      const early = await call(LOOKUP, {}, withLookups({ recipeId: 'r-assist', turnKind: 'tick', windowFlushedAt: NOW - 10_000 }))
      expect((early.body.output as { success: boolean }).success).toBe(true)
    })

    it('a record-writing copilot keeps its lookups past the cutoff', async () => {
      const res = await call(LOOKUP, {}, withLookups({ turnKind: 'tick', windowFlushedAt: NOW - 30_000 }))
      expect((res.body.output as { success: boolean }).success).toBe(true)
    })
  })
})
