/**
 * PARITY: the eve live-agent turn the cloud route DISPATCHES vs. the turn the
 * eve mount's internal routes REBUILD (LIVE-AGENT-DESIGN §12 Steps 2–5).
 *
 * Each case drives `POST /api/ai/live-agent` end to end over a fixture database
 * with the eve session intercepted (the route's model call IS an eve task
 * session), takes the run token the route actually minted, verifies it, and
 * rebuilds the SAME turn from those claims (rebuildLiveAgentSpec /
 * rebuildLiveAgentContextBlock) over the same database:
 *
 *   - the claims ................... what the route minted: turn type (mode ×
 *                                    live_role), recipe override, eval flag,
 *                                    member, tenancy
 *   - the task message ............. byte-identical: Block 2 (dynamic context,
 *                                    the connected-MCP block, the attached-
 *                                    package manifest, the serialized capture
 *                                    state + corrections log) rebuilt from the
 *                                    claims, then Block 3 (the transcript)
 *   - the system prompt ............ every layer present exactly when it must
 *                                    be: the base (or the assist-only base), web
 *                                    guidance, the persona, the notes rider, the
 *                                    batch riders
 *   - the initial tool set ......... get_package seeded exactly when the route's
 *                                    old map seeded it (a LIVE turn with a
 *                                    non-empty manifest, unless narrowed away)
 *   - the ceiling .................. assist-only / notes strips by name; every
 *                                    advertised tool carries the REAL tool's
 *                                    description
 *   - web access ................... spec.webAccess ⇔ the route's own predicate
 *   - the model .................... the spec's Gateway slug === the model the
 *                                    route's usage row names (recipe override →
 *                                    workspace 'live_agent' default → default)
 *   - pair_notes / attribution ..... the route's response ⇔ spec.pairNotes
 *   - persona resolution order ..... explicit recipe → edition / workspace
 *                                    default (live vs batch mode) → the
 *                                    assist-only safety net → the built-in
 *                                    ASSISTANT_PERSONA, incl. an eval capture in
 *                                    an edition workspace (asserted by persona
 *                                    text, so a resolution bug on BOTH sides
 *                                    still fails)
 *
 * The route's own persona resolution (it still resolves one, for pair_notes and
 * the usage row's model — with the SAME fenced resolver) and the spec rebuild's
 * are held equal here.
 *
 * And every CASE is held BYTE FOR BYTE to the frozen pre-port reference
 * (fixtures/live-agent-pre-port.json — what the AI-SDK route handed
 * generateText, captured at 43a05289): the system prompt, Block 2, the whole
 * message, the ordered initial tool set, the exact ceiling, every tool
 * description, the model, the attribution tags and pair_notes. Two deltas are
 * documented (here and in the golden's `_about`), both by design:
 *   1. PINNED_READS below.
 *   2. The message shape. The pre-port route sent Block 2 and Block 3 as TWO
 *      user-content parts, Block 2 carrying an ephemeral
 *      providerOptions.anthropic.cacheControl; the eve task message is ONE
 *      string, Block 2 + '\n\n---\n\n' + Block 3 (composeLiveAgentMessage),
 *      with no hand-threaded breakpoint (LIVE-AGENT-DESIGN §10 retires it;
 *      §3.2 has the route build one message string). The message assertion
 *      below hard-codes that separator.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Tool } from 'ai'
import { createFakeSupabase, eqValue, meetingFixture, FIX, type FixtureOptions } from './helpers/live-turn-fixture'
import { clearProductDocCache } from '@/lib/workspace/product-doc'
import { PRODUCT_FACTS_HEADING } from '../product-facts'
import { liveRecentTail, verifyLiveAgentRunToken, type LiveAgentTokenClaims } from '../live-agent-run-token'
import { liveTurnTypeFromRequest } from '../ceiling'
import { liveTurnKind } from '../turn-budget'
import { cutRiders, type RiderId } from '../riders'
import {
  ASSISTANT_PERSONA,
  BASE_SYSTEM_PROMPT,
  BATCH_SUMMARY_REQUIRED,
  BATCH_USER_NOTES_GUIDANCE,
  LIVE_ASSIST_BASE_PROMPT,
  LIVE_NOTES_PAIRING_PROMPT,
} from '../prompts'
import { WEB_ACCESS_GUIDANCE } from '@/lib/ai/web-access-prompt'
import { DEFAULT_MODEL, gatewayModelSlug, deepseekSurfacePolicy } from '@/lib/ai/models'
import { createLiveAgentTools } from '../tools'
import { buildLiveAgentReadTools } from '../read-tools'
import { MCP_LOOKUPS_LINE, composeLiveAgentMessage, composeLiveAgentTranscriptBlock } from '../turn-composition'
import GOLDEN from './fixtures/live-agent-pre-port.json'
import { ALL_CATEGORY_IDS } from '@/lib/ai/tool-registry'

const h = vi.hoisted(() => ({
  client: null as unknown as SupabaseClient,
  captured: [] as Array<{ message: string; runToken: string }>,
  usage: [] as Array<Record<string, unknown>>,
  /** The usage check's answer: undefined (allowed, not on a ChatGPT plan) unless a case sets it. */
  usageRow: undefined as Record<string, unknown> | undefined,
}))

vi.mock('@/lib/ai/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/ai/auth')>()),
  authenticateUser: async () => ({ user: { id: 'user-owner-1', email: 'owner@example.com' }, supabase: h.client }),
  checkUsageLimits: async () => h.usageRow,
  logUsage: async (_uid: string, row: Record<string, unknown>) => {
    h.usage.push(row)
  },
}))
vi.mock('@/lib/workspace', async (orig) => ({
  ...(await orig<typeof import('@/lib/workspace')>()),
  getCurrentWorkspaceId: async () => 'ws-1',
}))
vi.mock('@/lib/admin', async (orig) => ({
  ...(await orig<typeof import('@/lib/admin')>()),
  getServiceClient: () => h.client,
}))
vi.mock('@/lib/crm/contacts', async (orig) => ({
  ...(await orig<typeof import('@/lib/crm/contacts')>()),
  seedSelfParticipant: async () => {},
}))
vi.mock('@/lib/live-agent/conversation-writer', async (orig) => ({
  ...(await orig<typeof import('@/lib/live-agent/conversation-writer')>()),
  syncProposalsCard: async () => {},
}))
vi.mock('@/lib/flows/emit-capture-processed', () => ({ emitCaptureProcessed: async () => {} }))
// The route's model call: capture the run token it minted (off the client it
// built) and the message, and answer with a quiet completed turn.
let lastRunToken = ''
vi.mock('@/lib/live-agent/eve-turn', async (orig) => {
  const actual = await orig<typeof import('@/lib/live-agent/eve-turn')>()
  return {
    ...actual,
    liveAgentEveClient: (a: Parameters<typeof actual.liveAgentEveClient>[0]) => {
      lastRunToken = a.runToken
      return actual.liveAgentEveClient(a)
    },
  }
})
vi.mock('@/lib/eve/task-session', async () => {
  const { fakeTaskResponse, quietTurn } = await import('./helpers/fake-eve-turn')
  return {
    createTaskSession: async (_client: unknown, opts: { message: string }) => {
      h.captured.push({ message: opts.message, runToken: lastRunToken })
      return fakeTaskResponse(quietTurn())
    },
    cancelTaskSession: async () => true,
  }
})

const { POST } = await import('@/app/api/ai/live-agent/route')
const { rebuildLiveAgentSpec, rebuildLiveAgentContextBlock } = await import('../live-agent-spec')

type Body = {
  capture_id: string
  recent_chunks?: string[]
  corrections_log?: Array<{ field: string; agentProposed: string; userCorrected: string }>
  recipe_id?: string
  mode?: 'live' | 'batch'
  live_role?: 'copilot' | 'notes'
  prior_transcript?: string
}

/**
 * Every fixture persona carries an explicit every-category-on selection (as the
 * seeded system personas do, migrations 151/268). The frozen reference was
 * captured when a persona with NO selection inherited every read; since
 * Sequence step 1 a persona row's NULL config is core-only, so the fixtures
 * must SAY inherit-all to keep producing the recorded surfaces.
 */
const INHERIT_ALL = { enabled_tools: [...ALL_CATEGORY_IDS], disabled_tools: [] }
const ASSIST_RECIPE = { system_prompt: 'ASSIST PERSONA', agent_config: { capture_mode: 'assist_only', ...INHERIT_ALL }, model: null }

/**
 * Seeded SYSTEM personas an edition names (src/lib/editions/manifest.ts: sales →
 * live 'sales-live', batch 'sales-post-call'). The live one is ASSIST-ONLY, as
 * the sales edition relies on (the pair_notes path). The rest are
 * `settings.default_agents` override targets.
 */
const SYSTEM_RECIPES: NonNullable<FixtureOptions['systemRecipesBySlug']> = {
  'sales-live': { id: 'r-sales-live', system_prompt: 'SALES LIVE PERSONA', agent_config: { capture_mode: 'assist_only', ...INHERIT_ALL }, model: null },
  'sales-post-call': { id: 'r-sales-post', system_prompt: 'SALES POST-CALL PERSONA', agent_config: INHERIT_ALL, model: null },
  'plain-live': { id: 'r-plain-live', system_prompt: 'PLAIN LIVE PERSONA', agent_config: INHERIT_ALL, model: null },
  'assist-batch': { id: 'r-assist-batch', system_prompt: 'ASSIST BATCH PERSONA', agent_config: { capture_mode: 'assist_only', ...INHERIT_ALL }, model: null },
}
const SALES: FixtureOptions = { settings: { edition: 'sales' }, systemRecipesBySlug: SYSTEM_RECIPES }
/** Sales edition, but the workspace overrides its LIVE default with a non-assist persona. */
const SALES_PLAIN_LIVE: FixtureOptions = {
  settings: { edition: 'sales', default_agents: { live: 'plain-live' } },
  systemRecipesBySlug: SYSTEM_RECIPES,
}
/** A (mis-authored) default whose BATCH persona is itself assist-only. */
const ASSIST_BATCH_DEFAULT: FixtureOptions = {
  settings: { edition: 'sales', default_agents: { batch: 'assist-batch' } },
  systemRecipesBySlug: SYSTEM_RECIPES,
}
const PERSONAS = ['SALES LIVE PERSONA', 'SALES POST-CALL PERSONA', 'PLAIN LIVE PERSONA', 'ASSIST BATCH PERSONA', 'ASSIST PERSONA', 'NARROW PERSONA']
/** The built-in persona's opening line — present iff no recipe persona ran. */
const BUILT_IN = ASSISTANT_PERSONA.split('\n')[0]

interface Case {
  name: string
  body: Body
  fixture: FixtureOptions
  /** What the case exists to prove, beyond "everything matches". */
  expect: {
    model: string
    getPackage: boolean
    web: boolean
    assistOnly: boolean
    /** The persona that must drive the turn: a recipe's prompt text, or 'built-in'. */
    persona?: string
    /**
     * The prompt riders the turn does without (riders.ts), stated per case: no
     * live package manifest → 'packages'; a notes or batch turn → 'talk'. Every
     * fixture user has a Jira server, so the MCP block is always present and
     * 'mcp-propose' is never omitted here.
     */
    omit?: RiderId[]
  }
}

const CASES: Case[] = [
  {
    name: 'copilot, built-in persona, packages attached, a corrections log',
    body: {
      capture_id: FIX.captureId,
      recent_chunks: ['Speaker 1: ship Friday', 'Speaker 2: agreed'],
      corrections_log: [{ field: 'title', agentProposed: 'Sync', userCorrected: 'Weekly sync' }],
    },
    fixture: { packageIds: ['pk-1', 'pk-2'] },
    expect: { model: 'deepseek/deepseek-v4-flash', getPackage: true, web: true, assistOnly: false },
  },
  {
    name: 'copilot, explicit ASSIST-ONLY recipe (write tools stripped, assist base prompt)',
    body: { capture_id: FIX.captureId, recent_chunks: ['a'], recipe_id: 'r-assist', prior_transcript: 'earlier' },
    fixture: { recipes: { 'r-assist': ASSIST_RECIPE }, packageIds: ['pk-1'] },
    expect: { model: 'deepseek/deepseek-v4-flash', getPackage: true, web: true, assistOnly: true },
  },
  {
    name: 'paired NOTES turn with an assist-only recipe (safety net → built-in; talk tools stripped)',
    body: { capture_id: FIX.captureId, recent_chunks: ['a'], live_role: 'notes', recipe_id: 'r-assist' },
    fixture: { recipes: { 'r-assist': ASSIST_RECIPE } },
    expect: { model: 'deepseek/deepseek-v4-flash', getPackage: false, web: true, assistOnly: false, omit: ['packages', 'talk'] },
  },
  {
    name: 'BATCH with user notes (batch riders; packages attached but never loaded)',
    body: { capture_id: FIX.captureId, mode: 'batch' },
    fixture: { userNotes: 'my own notes', packageIds: ['pk-1'] },
    expect: { model: 'deepseek/deepseek-v4-flash', getPackage: false, web: true, assistOnly: false, omit: ['packages', 'talk'] },
  },
  {
    name: 'EVAL capture (no web layer, no web tool, no edition default)',
    body: { capture_id: FIX.captureId, recent_chunks: ['a'] },
    fixture: { isEval: true, packageIds: ['pk-1'] },
    expect: { model: 'deepseek/deepseek-v4-flash', getPackage: true, web: false, assistOnly: false },
  },
  {
    // Auto model selection: an old workspace ai_models pick is no longer read (the name keys the frozen fixture).
    name: 'workspace live_agent model default (no recipe model)',
    body: { capture_id: FIX.captureId, recent_chunks: ['a'] },
    fixture: { settings: { ai_models: { live_agent: 'claude-haiku-4-5-20251001' } } },
    expect: { model: 'deepseek/deepseek-v4-flash', getPackage: false, web: true, assistOnly: false, omit: ['packages'] },
  },
  {
    // Auto model selection: a recipe's old model is ignored, the fixed model runs (the name keys the frozen fixture).
    name: 'recipe model OVERRIDE wins over the workspace default; narrowed reads drop get_package',
    body: { capture_id: FIX.captureId, recent_chunks: ['a'], recipe_id: 'r-narrow' },
    fixture: {
      settings: { ai_models: { live_agent: 'claude-haiku-4-5-20251001' } },
      recipes: {
        'r-narrow': {
          system_prompt: 'NARROW PERSONA',
          agent_config: { enabled_tools: ['actions'], disabled_tools: ['list_labels'] },
          model: 'claude-sonnet-4-5-20250929',
        },
      },
      packageIds: ['pk-1'],
    },
    expect: { model: 'deepseek/deepseek-v4-flash', getPackage: false, web: true, assistOnly: false },
  },

  // ── Persona resolution through the EDITION default (resolveDefaultRecipeForCapture) ──
  {
    name: 'EDITION copilot, no recipe_id → the assist-only LIVE default (assistOnly + pair_notes)',
    body: { capture_id: FIX.captureId, recent_chunks: ['a'] },
    fixture: SALES,
    expect: { model: 'deepseek/deepseek-v4-flash', getPackage: false, web: true, assistOnly: true, persona: 'SALES LIVE PERSONA', omit: ['packages'] },
  },
  {
    name: 'EDITION copilot, the workspace overrides the live default with a plain persona',
    body: { capture_id: FIX.captureId, recent_chunks: ['a'] },
    fixture: SALES_PLAIN_LIVE,
    expect: { model: 'deepseek/deepseek-v4-flash', getPackage: false, web: true, assistOnly: false, persona: 'PLAIN LIVE PERSONA', omit: ['packages'] },
  },
  {
    name: 'EDITION notes turn, no recipe_id → resolves the BATCH default (live default is assist-only)',
    body: { capture_id: FIX.captureId, recent_chunks: ['a'], live_role: 'notes' },
    fixture: SALES,
    expect: { model: 'deepseek/deepseek-v4-flash', getPackage: false, web: true, assistOnly: false, persona: 'SALES POST-CALL PERSONA', omit: ['packages', 'talk'] },
  },
  {
    name: 'EDITION notes turn, no recipe_id → the BATCH default even when the live default could write',
    body: { capture_id: FIX.captureId, recent_chunks: ['a'], live_role: 'notes' },
    fixture: SALES_PLAIN_LIVE,
    expect: { model: 'deepseek/deepseek-v4-flash', getPackage: false, web: true, assistOnly: false, persona: 'SALES POST-CALL PERSONA', omit: ['packages', 'talk'] },
  },
  {
    name: 'EDITION batch, no recipe_id → the edition BATCH default',
    body: { capture_id: FIX.captureId, mode: 'batch' },
    fixture: SALES,
    expect: { model: 'deepseek/deepseek-v4-flash', getPackage: false, web: true, assistOnly: false, persona: 'SALES POST-CALL PERSONA', omit: ['packages', 'talk'] },
  },
  {
    name: 'EDITION batch with an explicit ASSIST-ONLY recipe → safety net lands on the BATCH default',
    body: { capture_id: FIX.captureId, mode: 'batch', recipe_id: 'r-assist' },
    fixture: { ...SALES, recipes: { 'r-assist': ASSIST_RECIPE } },
    expect: { model: 'deepseek/deepseek-v4-flash', getPackage: false, web: true, assistOnly: false, persona: 'SALES POST-CALL PERSONA', omit: ['packages', 'talk'] },
  },
  {
    name: 'EDITION notes turn with an explicit ASSIST-ONLY recipe → safety net lands on the BATCH default',
    body: { capture_id: FIX.captureId, recent_chunks: ['a'], live_role: 'notes', recipe_id: 'r-assist' },
    fixture: { ...SALES, recipes: { 'r-assist': ASSIST_RECIPE } },
    expect: { model: 'deepseek/deepseek-v4-flash', getPackage: false, web: true, assistOnly: false, persona: 'SALES POST-CALL PERSONA', omit: ['packages', 'talk'] },
  },
  {
    name: 'EVAL copilot in an edition workspace → the built-in persona (never the edition default)',
    body: { capture_id: FIX.captureId, recent_chunks: ['a'] },
    fixture: { ...SALES, isEval: true },
    expect: { model: 'deepseek/deepseek-v4-flash', getPackage: false, web: false, assistOnly: false, persona: 'built-in', omit: ['packages'] },
  },
  {
    name: 'EVAL batch in an edition workspace with an assist-only recipe → safety net to the built-in',
    body: { capture_id: FIX.captureId, mode: 'batch', recipe_id: 'r-assist' },
    fixture: { ...SALES, isEval: true, recipes: { 'r-assist': ASSIST_RECIPE } },
    expect: { model: 'deepseek/deepseek-v4-flash', getPackage: false, web: false, assistOnly: false, persona: 'built-in', omit: ['packages', 'talk'] },
  },
  {
    name: 'a BATCH default that is itself assist-only → falls all the way back to the built-in',
    body: { capture_id: FIX.captureId, mode: 'batch', recipe_id: 'r-assist' },
    fixture: { ...ASSIST_BATCH_DEFAULT, recipes: { 'r-assist': ASSIST_RECIPE } },
    expect: { model: 'deepseek/deepseek-v4-flash', getPackage: false, web: true, assistOnly: false, persona: 'built-in', omit: ['packages', 'talk'] },
  },
  {
    name: 'a BATCH default that is itself assist-only, no recipe_id → the built-in',
    body: { capture_id: FIX.captureId, mode: 'batch' },
    fixture: ASSIST_BATCH_DEFAULT,
    expect: { model: 'deepseek/deepseek-v4-flash', getPackage: false, web: true, assistOnly: false, persona: 'built-in', omit: ['packages', 'talk'] },
  },
]

function claimsFor(
  body: Body,
  fixture: FixtureOptions,
  model: string = DEFAULT_MODEL,
  omit: readonly RiderId[] = [],
): LiveAgentTokenClaims {
  return {
    captureId: body.capture_id,
    workspaceId: FIX.workspaceId,
    userId: FIX.userId,
    currentMemberId: FIX.memberId,
    turnType: liveTurnTypeFromRequest(body.mode, body.live_role),
    ...(body.recipe_id ? { recipeId: body.recipe_id } : {}),
    model,
    isEvalCapture: fixture.isEval === true,
    allowAutoArchive: false,
    // The time guard's claim (time-guard.ts); none of these bodies sends a
    // window_age_ms, so no windowFlushedAt.
    turnKind: liveTurnKind({ isBatch: body.mode === 'batch', recordOnly: false }),
    // A talking tick's window tail, for the tool route's shadow nudge.worth
    // check only (never a prompt or ceiling input, so parity is unchanged).
    ...(() => {
      const recentTail = body.mode !== 'batch' && body.live_role !== 'notes' ? liveRecentTail(body.recent_chunks) : undefined
      return recentTail !== undefined ? { recentTail } : {}
    })(),
    // The prompt riders the route chose (riders.ts): minted only when non-empty.
    ...(omit.length > 0 ? { omit: [...omit] } : {}),
    exp: Date.now() + 60_000,
  }
}

/** Block 3 as the route builds it, from the request body + the fixture's batch columns. */
function transcriptBlockFor(body: Body, fixture: FixtureOptions): string {
  return body.mode === 'batch'
    ? composeLiveAgentTranscriptBlock({
        isBatch: true,
        batchUserNotes: (fixture.userNotes ?? '').trim(),
        batchTranscript: (fixture.transcript ?? 'Speaker 1: we will ship Friday.').trim(),
      })
    : composeLiveAgentTranscriptBlock({
        isBatch: false,
        recentChunks: body.recent_chunks ?? [],
        priorTranscript: body.prior_transcript,
      })
}

/** Every tool the live agent can be granted, by name — the REAL factories' objects. */
const REAL_TOOLS: Record<string, Tool> = (() => {
  const stub = {} as SupabaseClient
  return {
    ...(createLiveAgentTools('u', stub, 'w', 'c', null, null) as Record<string, Tool>),
    ...(buildLiveAgentReadTools('u', stub, 'w') as Record<string, Tool>),
  }
})()

// ── The FROZEN pre-port reference ──────────────────────────────────────────────
//
// fixtures/live-agent-pre-port.json is what the AI-SDK route handed generateText
// for every CASE below, captured at 43a05289 (the last commit with the
// in-process model call) — see its `_about`. The eve path is held to it byte
// for byte: a reordered layer, a changed separator, a doubled persona, a tool
// added to or dropped from a ceiling all fail here, even when both sides of the
// route ⇔ spec comparison drift together.

interface GoldenCase {
  model: string
  gateway: { user?: string; tags: string[] } | null
  pairNotes: boolean | null
  activeTools: string[]
  toolKeys: string[]
  instructions: number[]
  block2: number[]
  block3: string
}
const GOLDEN_SEGMENTS: string[] = GOLDEN.segments
const GOLDEN_DESCRIPTIONS: Record<string, string | null> = GOLDEN.descriptions
const unsegment = (ix: number[]) => ix.map((i) => GOLDEN_SEGMENTS[i]).join('\n\n')
function goldenCase(name: string): GoldenCase {
  const c = (GOLDEN.cases as Record<string, GoldenCase>)[name]
  if (!c) throw new Error(`no frozen pre-port reference for case "${name}"`)
  return c
}

/** The two capabilities eve mints natively — never in a spec's tool lists. */
const NATIVE = new Set(['search_tools', 'web_search'])

/**
 * The ONE intentional, documented delta from the pre-port reference (ws1b).
 * list_workspace_members / list_labels were hand-rolled in createLiveAgentTools
 * AND served by the read surface, so the old activeTools named each TWICE (once
 * in the staging half, once in the read half). One registry implementation now
 * serves both, pinned into every ceiling (LIVE_AGENT_PINNED_READ_TOOL_NAMES):
 * each is listed exactly ONCE, and its position in the list is not compared.
 * Everything else — including web_fetch, which the route never had and the
 * mount disables — must match the reference exactly.
 */
const PINNED_READS = ['list_workspace_members', 'list_labels']
const comparableTools = (names: readonly string[]) =>
  names.filter((n) => !NATIVE.has(n) && !PINNED_READS.includes(n))

const RECORD_WRITERS = ['write_summary', 'update_summary', 'propose_change', 'record_commitment', 'set_capture_title']
const TALKERS = ['say_to_user', 'ask_user']

/**
 * Drive the REAL route; return its JSON, the message it sent eve, the claims it
 * minted (verified with the real HMAC), and the usage row it logged.
 */
async function runRoute(body: Body, fixture: FixtureOptions) {
  h.client = createFakeSupabase(meetingFixture(fixture)).client
  h.captured = []
  h.usage = []
  const res = await POST(
    new Request('https://app.test/api/ai/live-agent', { method: 'POST', body: JSON.stringify(body) }),
  )
  expect(res.status).toBe(200)
  expect(h.captured).toHaveLength(1)
  const claims = verifyLiveAgentRunToken(h.captured[0].runToken)
  expect(claims, 'the route minted no verifiable run token').not.toBeNull()
  expect(h.usage).toHaveLength(1)
  return {
    json: (await res.json()) as Record<string, unknown>,
    message: h.captured[0].message,
    claims: claims!,
    usage: h.usage[0],
  }
}

describe('eve live-agent turn: what the route dispatches ⇔ what the spec rebuilds', () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-24T16:00:00Z'))
  })
  afterAll(() => {
    vi.useRealTimers()
  })
  beforeEach(() => {
    process.env.GATEWAY_USER_TAGGING = 'all'
    process.env.LIVE_AGENT_INTERNAL_SECRET = 'parity-secret'
    delete process.env.USE_GATEWAY
  })

  it.each(CASES)('$name', async ({ name, body, fixture, expect: want }) => {
    const { json, message, claims, usage } = await runRoute(body, fixture)
    const golden = goldenCase(name)

    // The claims the route minted are exactly the turn's durable facts —
    // including the model, which is the SAME value the usage row names.
    const { exp: _exp, ...expected } = claimsFor(body, fixture, usage.model as string, want.omit ?? [])
    void _exp
    const { exp: _mintedExp, ...minted } = claims
    void _mintedExp
    expect(minted).toEqual(expected)

    const client = createFakeSupabase(meetingFixture(fixture)).client
    const spec = await rebuildLiveAgentSpec(claims, { schemas: true, supabase: client })
    const block2 = await rebuildLiveAgentContextBlock(claims, body.corrections_log ?? [], { supabase: client })
    expect(spec).not.toBeNull()
    expect(block2).not.toBeNull()

    // The task message — Block 2 rebuilt from the claims, then Block 3.
    expect(message).toBe(composeLiveAgentMessage(block2!, transcriptBlockFor(body, fixture)))
    for (const c of body.corrections_log ?? []) expect(message).toContain(c.userCorrected)
    if (body.prior_transcript) expect(message).toContain(body.prior_transcript)
    for (const chunk of body.recent_chunks ?? []) expect(message).toContain(chunk)

    // ── Byte-level against the FROZEN pre-port route ──
    // The system prompt, all 7 layers.
    expect(spec!.systemPrompt).toBe(unsegment(golden.instructions))
    // Block 2 and the message (Block 2, the separator, Block 3).
    expect(block2).toBe(unsegment(golden.block2))
    expect(message).toBe(unsegment(golden.block2) + '\n\n---\n\n' + golden.block3)
    // The initial tool set: the old activeTools minus eve's native capabilities,
    // in order (the one documented delta: the pinned reads, listed once).
    expect(comparableTools(spec!.coreToolNames)).toEqual(comparableTools(golden.activeTools))
    for (const n of PINNED_READS) {
      expect(spec!.coreToolNames.filter((x) => x === n), n).toHaveLength(golden.activeTools.includes(n) ? 1 : 0)
    }
    expect(spec!.ceiling).not.toContain('web_fetch')
    // The ceiling: the old tools MAP minus eve's native capabilities, exactly.
    expect([...spec!.ceiling].sort()).toEqual(golden.toolKeys.filter((n) => !NATIVE.has(n)))
    // Each advertised tool carries the OLD route's description, byte for byte.
    for (const t of spec!.ceilingTools) expect(t.description, t.name).toBe(GOLDEN_DESCRIPTIONS[t.name])
    // The model slug, the attribution tags (+ runtime:eve), pair_notes.
    expect(spec!.model).toBe(golden.model)
    expect(spec!.gatewayTelemetry?.user).toBe(golden.gateway?.user)
    expect(spec!.gatewayTelemetry?.tags).toEqual([...(golden.gateway?.tags ?? []), 'runtime:eve'])
    if (claims.turnType !== 'batch') expect(json.pair_notes).toBe(golden.pairNotes)

    // The system prompt — every layer present exactly when it must be.
    const prompt = spec!.systemPrompt
    const isBatch = claims.turnType === 'batch'
    // The base, less the riders the turn does without (cut from a copy).
    const base = want.assistOnly
      ? cutRiders(LIVE_ASSIST_BASE_PROMPT, want.omit, 'assist')
      : cutRiders(BASE_SYSTEM_PROMPT, want.omit, 'base')
    expect(prompt.startsWith(base)).toBe(true)
    // The usage row records exactly what was cut.
    if (want.omit?.length) expect(usage.metadata).toMatchObject({ riders_omitted: want.omit })
    else expect((usage.metadata as Record<string, unknown> | undefined)?.riders_omitted).toBeUndefined()
    expect(prompt.includes(WEB_ACCESS_GUIDANCE)).toBe(want.web)
    expect(prompt.includes(LIVE_NOTES_PAIRING_PROMPT)).toBe(claims.turnType === 'notes')
    expect(prompt.includes(BATCH_SUMMARY_REQUIRED)).toBe(isBatch)
    expect(prompt.includes(BATCH_USER_NOTES_GUIDANCE)).toBe(isBatch && !!fixture.userNotes)

    // The initial tool set: get_package exactly when a live manifest seeds it.
    expect(spec!.coreToolNames.includes('get_package')).toBe(want.getPackage)
    expect(spec!.coreToolNames).not.toContain('search_tools')
    expect(spec!.coreToolNames).not.toContain('web_search')
    for (const name of spec!.coreToolNames) expect(spec!.ceiling, name).toContain(name)

    // The ceiling, by name, per turn type / persona.
    for (const name of RECORD_WRITERS) expect(spec!.ceiling.includes(name), name).toBe(!want.assistOnly)
    for (const name of TALKERS) expect(spec!.ceiling.includes(name), name).toBe(claims.turnType !== 'notes')
    for (const name of ['list_workspace_members', 'list_labels']) expect(spec!.ceiling, name).toContain(name)
    // Each advertised tool carries the REAL tool's description.
    for (const t of spec!.ceilingTools) {
      expect(t.description, t.name).toBe(REAL_TOOLS[t.name].description)
    }

    // Web access — the route's own predicate (Gateway on, not an eval).
    expect(spec!.webAccess).toBe(want.web)

    // WHICH model — the full chain, asserted by name, and the usage row the
    // route logged names the same model.
    expect(spec!.model).toBe(want.model)
    expect(gatewayModelSlug(usage.model as string)).toBe(spec!.model)
    expect(claims.model).toBe(usage.model)
    expect(usage.feature).toBe('live_agent')

    // WHICH persona drove the turn — by its text, so a resolution bug on BOTH
    // sides still fails (parity alone would not catch it).
    if (want.persona) {
      const others = PERSONAS.filter((p) => p !== want.persona && !want.persona!.includes(p))
      if (want.persona === 'built-in') {
        expect(prompt).toContain(BUILT_IN)
      } else {
        expect(prompt).toContain(want.persona)
        expect(prompt).not.toContain(BUILT_IN)
      }
      for (const p of others) expect(prompt, `must not carry ${p}`).not.toContain(p)
    }

    // assist-only + the pair_notes signal the client reads: the route's inline
    // persona resolution and the spec's agree.
    expect(spec!.assistOnly).toBe(want.assistOnly)
    if (isBatch) {
      expect(json).not.toHaveProperty('pair_notes')
      expect(spec!.pairNotes).toBe(false)
    } else {
      expect(spec!.pairNotes).toBe(json.pair_notes)
      // pair_notes is exactly "an assist-only copilot" — the sales edition's path.
      expect(spec!.pairNotes).toBe(claims.turnType === 'copilot' && want.assistOnly)
    }

    // Per-user attribution on the eve path: the live_agent feature + runtime:eve.
    expect(spec!.gatewayTelemetry?.user).toBeTruthy()
    expect(spec!.gatewayTelemetry?.tags).toContain('feature:live_agent')
    expect(spec!.gatewayTelemetry?.tags).toContain('runtime:eve')
  })

  it('a recipe_id the caller cannot see (device token → service-role client) is fenced on BOTH sides', async () => {
    // Another workspace's assist-only recipe on a cheap model. The fake has no
    // RLS (like the service-role client authenticateUser returns for a device
    // token), so only the visibility predicate keeps it out. Unfenced, the
    // route would bill it as claude-haiku and answer pair_notes: true while the
    // eve session (fenced) runs the workspace default persona and model.
    const fixture: FixtureOptions = {
      recipes: {
        'r-foreign': {
          system_prompt: 'FOREIGN PERSONA',
          agent_config: { capture_mode: 'assist_only' },
          model: 'claude-haiku-4-5-20251001',
        },
      },
      hiddenRecipeIds: ['r-foreign'],
    }
    const body: Body = { capture_id: FIX.captureId, recent_chunks: ['a'], recipe_id: 'r-foreign' }
    const { json, claims, usage } = await runRoute(body, fixture)
    const spec = await rebuildLiveAgentSpec(claims, { supabase: createFakeSupabase(meetingFixture(fixture)).client })
    expect(spec!.systemPrompt).not.toContain('FOREIGN PERSONA')
    expect(spec!.systemPrompt).toContain(BUILT_IN)
    expect(spec!.model).toBe('deepseek/deepseek-v4-flash')
    // The usage row names the model the session actually runs (fixed: a recipe's model is ignored).
    expect(usage.model).toBe('deepseek-v4-flash')
    expect(gatewayModelSlug(usage.model as string)).toBe(spec!.model)
    expect(json.pair_notes).toBe(false)
    expect(spec!.pairNotes).toBe(false)
    // The same recipe, VISIBLE to the caller, drives both sides (its persona, never its model).
    const visible: FixtureOptions = { ...fixture, hiddenRecipeIds: [] }
    const seen = await runRoute(body, visible)
    expect(seen.usage.model).toBe('deepseek-v4-flash')
    expect(seen.json.pair_notes).toBe(true)
  })

  it('the model eve runs is the SIGNED model the usage row names, even if a recipe changes mid-turn', async () => {
    // The live agent's model is fixed (a recipe's model is ignored), and the
    // spec still runs the model the token signed, never a re-resolved one.
    const cheap: FixtureOptions = {
      recipes: { 'r-mine': { system_prompt: 'MINE', agent_config: null, model: 'claude-haiku-4-5-20251001' } },
    }
    const body: Body = { capture_id: FIX.captureId, recent_chunks: ['a'], recipe_id: 'r-mine' }
    const { claims, usage } = await runRoute(body, cheap)
    expect(usage.model).toBe('deepseek-v4-flash')
    expect(claims.model).toBe('deepseek-v4-flash')

    const switched: FixtureOptions = {
      recipes: { 'r-mine': { system_prompt: 'MINE', agent_config: null, model: 'claude-sonnet-4-5-20250929' } },
    }
    const spec = await rebuildLiveAgentSpec(claims, { supabase: createFakeSupabase(meetingFixture(switched)).client })
    expect(spec!.model).toBe(gatewayModelSlug(usage.model as string))
    // A signed token naming another model keeps it (the token is the authority).
    const signedHaiku = { ...claims, model: 'claude-haiku-4-5-20251001' }
    const haiku = await rebuildLiveAgentSpec(signedHaiku, { supabase: createFakeSupabase(meetingFixture(switched)).client })
    expect(haiku!.model).toBe(gatewayModelSlug('claude-haiku-4-5-20251001'))
    // Not DeepSeek, so no thinking policy or host routing: the call is as before.
    expect(haiku).not.toHaveProperty('modelPolicy')
  })

  it('DeepSeek thinks on every turn (live copilot, notes and batch alike), all on private hosts', async () => {
    // Turn types that ran on DeepSeek, so carried a policy (a case on another
    // model carries none).
    const seen = new Set<string>()
    for (const c of CASES) {
      const { claims } = await runRoute(c.body, c.fixture)
      const spec = await rebuildLiveAgentSpec(claims, { supabase: createFakeSupabase(meetingFixture(c.fixture)).client })
      const want = deepseekSurfacePolicy(claims.model, 'on')
      if (want) seen.add(claims.turnType)
      if (want) expect(spec!.modelPolicy, c.name).toEqual(want)
      else expect(spec, c.name).not.toHaveProperty('modelPolicy')
    }
    expect([...seen].sort()).toEqual(['batch', 'copilot', 'notes'])
    expect(deepseekSurfacePolicy('deepseek-v4-flash', 'on')?.providerOptions).toEqual({ deepseek: { thinking: { type: 'enabled' } } })
  })

  it('the USE_GATEWAY kill switch drops web (the spec is the only prompt/tool source)', async () => {
    process.env.USE_GATEWAY = 'false'
    const c = CASES[0]
    const { claims } = await runRoute(c.body, c.fixture)
    const spec = await rebuildLiveAgentSpec(claims, {
      supabase: createFakeSupabase(meetingFixture(c.fixture)).client,
    })
    expect(spec!.webAccess).toBe(false)
    expect(spec!.systemPrompt).not.toContain(WEB_ACCESS_GUIDANCE)
  })

  it('omits gatewayTelemetry entirely when attribution is off', async () => {
    delete process.env.GATEWAY_USER_TAGGING
    const c = CASES[0]
    const spec = await rebuildLiveAgentSpec(claimsFor(c.body, c.fixture), {
      supabase: createFakeSupabase(meetingFixture(c.fixture)).client,
    })
    expect(spec).not.toHaveProperty('gatewayTelemetry')
  })

  it('carries real input schemas only on a schemas fetch', async () => {
    const c = CASES[0]
    const claims = claimsFor(c.body, c.fixture)
    const client = createFakeSupabase(meetingFixture(c.fixture)).client
    const bare = await rebuildLiveAgentSpec(claims, { supabase: client })
    const full = await rebuildLiveAgentSpec(claims, { schemas: true, supabase: client })
    expect(bare!.ceilingTools.every((t) => t.inputSchema === undefined)).toBe(true)
    const propose = full!.ceilingTools.find((t) => t.name === 'propose_change')
    expect(propose?.inputSchema).toMatchObject({ type: 'object' })
    expect(Object.keys((propose!.inputSchema as { properties: object }).properties)).toContain('change_type')
  })
})

describe('prompt riders: the route chooses, the token carries, the spec composes (riders.ts)', () => {
  beforeEach(() => {
    process.env.LIVE_AGENT_INTERNAL_SECRET = 'parity-secret'
    delete process.env.USE_GATEWAY
  })

  const TICK: Body = { capture_id: FIX.captureId, recent_chunks: ['Speaker 1: ship Friday'] }
  const NOTES: Body = { ...TICK, live_role: 'notes' }
  const PACKAGES: FixtureOptions = { packageIds: ['pk-1'] }
  const NO_MCP: FixtureOptions = { mcpServers: [] }

  const ROUND_TRIPS: Array<{ name: string; body: Body; fixture: FixtureOptions; omit: RiderId[] }> = [
    { name: 'copilot, packages + MCP → the full prompt', body: TICK, fixture: PACKAGES, omit: [] },
    { name: 'copilot, MCP, no packages', body: TICK, fixture: {}, omit: ['packages'] },
    { name: 'copilot, packages, no MCP', body: TICK, fixture: { ...PACKAGES, ...NO_MCP }, omit: ['mcp-propose'] },
    { name: 'copilot, neither', body: TICK, fixture: NO_MCP, omit: ['packages', 'mcp-propose'] },
    { name: 'notes, packages + MCP (talk only)', body: NOTES, fixture: PACKAGES, omit: ['talk'] },
    { name: 'notes, neither → all three', body: NOTES, fixture: NO_MCP, omit: ['packages', 'mcp-propose', 'talk'] },
    {
      name: 'assist-only copilot, neither → packages only (its base has no MCP or talk cut)',
      body: { ...TICK, recipe_id: 'r-assist' },
      fixture: { recipes: { 'r-assist': ASSIST_RECIPE }, ...NO_MCP },
      omit: ['packages'],
    },
  ]

  it.each(ROUND_TRIPS)('$name', async ({ body, fixture, omit }) => {
    const { claims, usage, message } = await runRoute(body, fixture)
    // Minted only when non-empty, and the usage row names the same list.
    if (omit.length) {
      expect(claims.omit).toEqual(omit)
      expect(usage.metadata).toMatchObject({ riders_omitted: omit })
    } else {
      expect(claims).not.toHaveProperty('omit')
      expect((usage.metadata as Record<string, unknown> | undefined)?.riders_omitted).toBeUndefined()
    }
    // The section is cut exactly when the turn lacks what it describes.
    expect(message.includes('<<<ATTACHED_CONTEXT_PACKAGES')).toBe(!omit.includes('packages'))
    expect(message.includes('## Connected external MCP servers')).toBe(!omit.includes('mcp-propose') && !body.recipe_id)

    const client = createFakeSupabase(meetingFixture(fixture)).client
    const spec = await rebuildLiveAgentSpec(claims, { supabase: client })
    const full = await rebuildLiveAgentSpec({ ...claims, omit: undefined }, { supabase: client })
    const prompt = spec!.systemPrompt
    const assistOnly = !!body.recipe_id
    // Riders only remove: the spec's prompt is the full one with the cuts made.
    const fullBase = assistOnly ? LIVE_ASSIST_BASE_PROMPT : BASE_SYSTEM_PROMPT
    expect(full!.systemPrompt.startsWith(fullBase)).toBe(true)
    expect(prompt.startsWith(cutRiders(fullBase, omit, assistOnly ? 'assist' : 'base'))).toBe(true)
    if (omit.length === 0) expect(prompt).toBe(full!.systemPrompt)
    else expect(prompt.length).toBeLessThan(full!.systemPrompt.length)

    expect(prompt.includes('## Attached Context Packages')).toBe(!omit.includes('packages'))
    if (!assistOnly) {
      expect(prompt.includes('- **propose_mcp_call** — ')).toBe(!omit.includes('mcp-propose'))
      expect(prompt.includes('- **say_to_user** — Speak a short heads-up')).toBe(!omit.includes('talk'))
      // The built-in persona (these fixtures resolve it): its live section goes with talk.
      expect(prompt.includes('## While the conversation is live, be useful in it')).toBe(!omit.includes('talk'))
      expect(prompt).toContain('## Ownership — MY action items vs OTHER people')
      expect(prompt).toContain('One hard exception: statements indicating thoughts of self-harm')
    }
    expect(prompt.includes(LIVE_NOTES_PAIRING_PROMPT)).toBe(body.live_role === 'notes')
    // The rest of the spec is untouched by riders.
    expect(spec!.ceiling).toEqual(full!.ceiling)
    expect(spec!.coreToolNames).toEqual(full!.coreToolNames)
  })
})

describe('the capture owner’s private chat never reaches another member’s turn', () => {
  const CHAT_BLOCK = '## Instructions from the user (live chat)'
  beforeEach(() => {
    process.env.LIVE_AGENT_INTERNAL_SECRET = 'parity-secret'
  })

  it('the OWNER’s live turn folds their own chat directives into Block 2 (route ⇔ spec)', async () => {
    const body = { capture_id: FIX.captureId, recent_chunks: ['a'] }
    const { message, claims } = await runRoute(body, {})
    const block2 = await rebuildLiveAgentContextBlock(claims, [], {
      supabase: createFakeSupabase(meetingFixture({})).client,
    })
    expect(message).toContain(CHAT_BLOCK)
    expect(message).toBe(composeLiveAgentMessage(block2!, transcriptBlockFor(body, {})))
  })

  it('a NON-OWNER member’s live turn gets no chat-tail block — the thread is the owner’s (mig 012/173 D6)', async () => {
    const fixture: FixtureOptions = { ownerUserId: 'someone-else' }
    const body = { capture_id: FIX.captureId, recent_chunks: ['a'] }
    const { message, claims } = await runRoute(body, fixture)
    const fake = createFakeSupabase(meetingFixture(fixture))
    const block2 = await rebuildLiveAgentContextBlock(claims, [], { supabase: fake.client })
    expect(block2).not.toContain(CHAT_BLOCK)
    expect(block2).not.toContain('skip the hiring tangent')
    expect(message).toBe(composeLiveAgentMessage(block2!, transcriptBlockFor(body, fixture)))
    // The fence is the query itself (service role has no RLS): scoped to the requester.
    const conv = fake.log.find((q) => q.table === 'chat_conversations')
    expect(conv?.filters).toContainEqual(['eq', 'user_id', FIX.userId])
  })
})

describe("what the agent already told the user (sidekick v1): the copilot's Block 2 only", () => {
  const TOLD = "## What you've already told them this call"
  const priorNudges = [{ text: 'You promised Dana the security docs last Tuesday.', created_at: '2026-09-24T15:55:00Z' }]
  beforeEach(() => {
    process.env.LIVE_AGENT_INTERNAL_SECRET = 'parity-secret'
  })

  it('a copilot turn carries its own heads-ups (route ⇔ spec)', async () => {
    const fixture: FixtureOptions = { priorNudges }
    const body = { capture_id: FIX.captureId, recent_chunks: ['a'] }
    const { message, claims } = await runRoute(body, fixture)
    const block2 = await rebuildLiveAgentContextBlock(claims, [], { supabase: createFakeSupabase(meetingFixture(fixture)).client })
    expect(message).toContain(TOLD)
    expect(message).toContain('You promised Dana the security docs last Tuesday.')
    expect(message).toBe(composeLiveAgentMessage(block2!, transcriptBlockFor(body, fixture)))
  })

  it.each([
    ['a paired notes turn', { capture_id: FIX.captureId, recent_chunks: ['a'], live_role: 'notes' as const }],
    ['a batch turn', { capture_id: FIX.captureId, mode: 'batch' as const }],
  ])('%s never sees them', async (_name, body) => {
    const fixture: FixtureOptions = { priorNudges }
    const { message, claims } = await runRoute(body, fixture)
    const block2 = await rebuildLiveAgentContextBlock(claims, [], { supabase: createFakeSupabase(meetingFixture(fixture)).client })
    expect(message).not.toContain(TOLD)
    expect(block2).not.toContain(TOLD)
  })
})

describe('the spec rebuild refuses turns the route would never have minted', () => {
  it('a caller whose membership was revoked after mint → null (no service-role reads for a non-member)', async () => {
    const fixture: FixtureOptions = { memberRevoked: true }
    const claims = claimsFor({ capture_id: FIX.captureId, recent_chunks: ['a'] }, fixture)
    const client = createFakeSupabase(meetingFixture(fixture)).client
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await rebuildLiveAgentSpec(claims, { supabase: client })).toBeNull()
    expect(await rebuildLiveAgentContextBlock(claims, [], { supabase: client })).toBeNull()
  })

  it('a NON-OWNER on another member’s PRIVATE capture → null (captures_select re-applied; no RLS here)', async () => {
    const fixture: FixtureOptions = { ownerUserId: 'someone-else', visibility: 'private' }
    const claims = claimsFor({ capture_id: FIX.captureId, recent_chunks: ['a'] }, fixture)
    const client = createFakeSupabase(meetingFixture(fixture)).client
    expect(await rebuildLiveAgentSpec(claims, { supabase: client })).toBeNull()
    expect(await rebuildLiveAgentContextBlock(claims, [], { supabase: client })).toBeNull()
  })

  it('a NON-OWNER with a NULL/unknown visibility → null (fails closed on anything but an explicit workspace)', async () => {
    const fixture: FixtureOptions = { ownerUserId: 'someone-else', visibility: null }
    const claims = claimsFor({ capture_id: FIX.captureId, recent_chunks: ['a'] }, fixture)
    const client = createFakeSupabase(meetingFixture(fixture)).client
    expect(await rebuildLiveAgentSpec(claims, { supabase: client })).toBeNull()
    expect(await rebuildLiveAgentContextBlock(claims, [], { supabase: client })).toBeNull()
  })

  it('a NON-OWNER on a WORKSPACE-visible capture is still served', async () => {
    const fixture: FixtureOptions = { ownerUserId: 'someone-else', visibility: 'workspace' }
    const claims = claimsFor({ capture_id: FIX.captureId, recent_chunks: ['a'] }, fixture)
    const client = createFakeSupabase(meetingFixture(fixture)).client
    expect(await rebuildLiveAgentSpec(claims, { supabase: client })).not.toBeNull()
  })

  it('the OWNER on their own PRIVATE capture is still served (eval clones are private, owned by the starter)', async () => {
    const fixture: FixtureOptions = { visibility: 'private' }
    const claims = claimsFor({ capture_id: FIX.captureId, recent_chunks: ['a'] }, fixture)
    const client = createFakeSupabase(meetingFixture(fixture)).client
    expect(await rebuildLiveAgentSpec(claims, { supabase: client })).not.toBeNull()
    const evalFixture: FixtureOptions = { visibility: 'private', isEval: true }
    const evalClaims = claimsFor({ capture_id: FIX.captureId, recent_chunks: ['a'] }, evalFixture)
    const evalClient = createFakeSupabase(meetingFixture(evalFixture)).client
    expect(await rebuildLiveAgentSpec(evalClaims, { supabase: evalClient })).not.toBeNull()
  })

  it('a BATCH token for a capture the caller does not own → null (owner-only reprocess)', async () => {
    const fixture: FixtureOptions = { ownerUserId: 'someone-else' }
    const claims = claimsFor({ capture_id: FIX.captureId, mode: 'batch' }, fixture)
    const client = createFakeSupabase(meetingFixture(fixture)).client
    expect(await rebuildLiveAgentSpec(claims, { supabase: client })).toBeNull()
  })

  it('a capture outside the claimed workspace → null', async () => {
    const claims = { ...claimsFor({ capture_id: FIX.captureId, recent_chunks: ['a'] }, {}), workspaceId: 'ws-other' }
    const client = createFakeSupabase(meetingFixture({})).client
    expect(await rebuildLiveAgentSpec(claims, { supabase: client })).toBeNull()
  })

  it('an eval claim is honored even if the row lost its flag (isolation only tightens)', async () => {
    const claims = { ...claimsFor({ capture_id: FIX.captureId, recent_chunks: ['a'] }, {}), isEvalCapture: true }
    const client = createFakeSupabase(meetingFixture({ isEval: false })).client
    const spec = await rebuildLiveAgentSpec(claims, { supabase: client })
    expect(spec!.webAccess).toBe(false)
  })

  it('re-applies the recipe SELECT policy to an explicit recipe on the service-role client', async () => {
    const fixture: FixtureOptions = { recipes: { 'r-assist': ASSIST_RECIPE } }
    const fake = createFakeSupabase(meetingFixture(fixture))
    const claims = claimsFor({ capture_id: FIX.captureId, recent_chunks: ['a'], recipe_id: 'r-assist' }, fixture)
    await rebuildLiveAgentSpec(claims, { supabase: fake.client })
    const recipeQuery = fake.log.find((q) => q.table === 'recipe')
    const or = recipeQuery?.filters.find(([m]) => m === 'or')
    expect(or?.[1]).toContain('is_system.eq.true')
    expect(or?.[1]).toContain(`and(workspace_id.eq.${FIX.workspaceId},visibility.eq.workspace)`)
    expect(or?.[1]).toContain(`created_by.eq.${FIX.userId}`)
  })
})

describe('the product doc (Phase 6): route ⇔ spec, on live turns only', () => {
  const POINTER = { product_doc: { document_id: 'doc-pf', set_by: FIX.memberId, set_at: '2026-09-01T00:00:00Z' } }
  const DOC = { id: 'doc-pf', content: '# Pricing\nPro is $20 per seat. SSO is on Enterprise only.' }
  const WITH_DOC: FixtureOptions = { settings: POINTER, productDoc: DOC, packageIds: ['pk-1'] }
  beforeEach(() => {
    process.env.LIVE_AGENT_INTERNAL_SECRET = 'parity-secret'
    clearProductDocCache()
  })

  it('a copilot turn carries the section, after the MCP block and right before the package manifest (route ⇔ spec)', async () => {
    const body = { capture_id: FIX.captureId, recent_chunks: ['a'] }
    const { message, claims } = await runRoute(body, WITH_DOC)
    // The rebuild reads it on its own (no cached copy from the route's read).
    clearProductDocCache()
    const fake = createFakeSupabase(meetingFixture(WITH_DOC))
    const block2 = await rebuildLiveAgentContextBlock(claims, [], { supabase: fake.client })
    expect(fake.log.some((q) => q.table === 'document' && eqValue(q, 'id') === DOC.id)).toBe(true)
    expect(message).toBe(composeLiveAgentMessage(block2!, transcriptBlockFor(body, WITH_DOC)))
    expect(block2).toContain(PRODUCT_FACTS_HEADING)
    expect(block2).toContain('Pro is $20 per seat.')
    const facts = block2!.indexOf(PRODUCT_FACTS_HEADING)
    expect(facts).toBeGreaterThan(block2!.indexOf('## Connected external MCP servers'))
    expect(facts).toBeLessThan(block2!.indexOf('package_id: pk-1'))
  })

  it('a paired notes turn carries it too (route ⇔ spec)', async () => {
    const body = { capture_id: FIX.captureId, recent_chunks: ['a'], live_role: 'notes' as const }
    const { message, claims } = await runRoute(body, WITH_DOC)
    clearProductDocCache()
    const block2 = await rebuildLiveAgentContextBlock(claims, [], { supabase: createFakeSupabase(meetingFixture(WITH_DOC)).client })
    expect(block2).toContain(PRODUCT_FACTS_HEADING)
    expect(message).toBe(composeLiveAgentMessage(block2!, transcriptBlockFor(body, WITH_DOC)))
  })

  it('a batch pass never carries it, and never reads it', async () => {
    const body = { capture_id: FIX.captureId, mode: 'batch' as const }
    const { message, claims } = await runRoute(body, WITH_DOC)
    const fake = createFakeSupabase(meetingFixture(WITH_DOC))
    const block2 = await rebuildLiveAgentContextBlock(claims, [], { supabase: fake.client })
    expect(message).not.toContain(PRODUCT_FACTS_HEADING)
    expect(block2).not.toContain(PRODUCT_FACTS_HEADING)
    expect(fake.log.some((q) => q.table === 'document' && eqValue(q, 'id') === DOC.id)).toBe(false)
  })

  it('no pointer → no section and no read: Block 2 is byte-identical to a workspace without the feature', async () => {
    const body = { capture_id: FIX.captureId, recent_chunks: ['a'] }
    const withoutPointer: FixtureOptions = { productDoc: DOC, packageIds: ['pk-1'] }
    const fake = createFakeSupabase(meetingFixture(withoutPointer))
    const plain = await runRoute(body, { packageIds: ['pk-1'] })
    const unpointed = await runRoute(body, withoutPointer)
    expect(unpointed.message).toBe(plain.message)
    expect(unpointed.message).not.toContain(PRODUCT_FACTS_HEADING)
    const block2 = await rebuildLiveAgentContextBlock(unpointed.claims, [], { supabase: fake.client })
    expect(block2).not.toContain(PRODUCT_FACTS_HEADING)
    expect(fake.log.some((q) => q.table === 'document' && eqValue(q, 'id') === DOC.id)).toBe(false)
  })

  it('a failed read renders nothing and still runs the turn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing: FixtureOptions = { ...WITH_DOC, productDocError: true }
    const body = { capture_id: FIX.captureId, recent_chunks: ['a'] }
    const { message } = await runRoute(body, failing)
    expect(message).not.toContain(PRODUCT_FACTS_HEADING)
    expect(warn).toHaveBeenCalledWith('[product-doc] skipped this turn:', expect.stringContaining('boom'))
    warn.mockRestore()
  })
})

describe('connected-app lookups (Phase 6 PR 3): route ⇔ spec, copilot turns only', () => {
  const LOOKUP = 'mcp__jira__getJiraIssue'
  const JIRA_WITH_READ = {
    id: 'srv-jira',
    display_name: 'Jira',
    tools_cache: [
      { name: 'create_issue', description: 'Create a Jira issue' },
      {
        name: 'getJiraIssue',
        description: 'Get a Jira issue by key',
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      },
    ],
    disabled_tools: [],
    require_approval_tools: [],
    is_enabled: true,
  }
  const WITH_READ: FixtureOptions = { mcpServers: [JIRA_WITH_READ] }
  const body = { capture_id: FIX.captureId, recent_chunks: ['a'] }
  const mcpReads = (log: Array<{ table: string }>) => log.filter((q) => q.table === 'connected_mcp_server')
  beforeEach(() => {
    process.env.LIVE_AGENT_INTERNAL_SECRET = 'parity-secret'
  })

  it('a copilot turn: the route stamps mcpLookups and adds the one line; the spec makes the lookup discoverable, never core', async () => {
    const { message, claims } = await runRoute(body, WITH_READ)
    expect(claims.mcpLookups).toBe(true)
    expect(message).toContain(MCP_LOOKUPS_LINE)
    const client = createFakeSupabase(meetingFixture(WITH_READ)).client
    const block2 = await rebuildLiveAgentContextBlock(claims, [], { supabase: client })
    expect(message).toBe(composeLiveAgentMessage(block2!, transcriptBlockFor(body, WITH_READ)))
    const spec = await rebuildLiveAgentSpec(claims, { schemas: true, supabase: client })
    expect(spec!.ceiling).toContain(LOOKUP)
    expect(spec!.ceiling).not.toContain('mcp__jira__create_issue')
    expect(spec!.coreToolNames).not.toContain(LOOKUP)
    const tool = spec!.ceilingTools.find((t) => t.name === LOOKUP)!
    expect(tool.description).toContain('[Jira] Read-only lookup in a connected app.')
    expect(tool.inputSchema).toMatchObject({ type: 'object', properties: { key: { type: 'string' } } })
    // A bare fetch carries no schema, like every other ceiling tool.
    const bare = await rebuildLiveAgentSpec(claims, { supabase: client })
    expect(bare!.ceilingTools.find((t) => t.name === LOOKUP)!.inputSchema).toBeUndefined()
  })

  it('no lookups → no stamp, and the spec never reads the servers', async () => {
    const { claims } = await runRoute(body, {})
    expect(claims).not.toHaveProperty('mcpLookups')
    const fake = createFakeSupabase(meetingFixture({}))
    const spec = await rebuildLiveAgentSpec(claims, { supabase: fake.client })
    expect(mcpReads(fake.log)).toHaveLength(0)
    expect(spec!.ceiling.some((n) => n.startsWith('mcp__'))).toBe(false)
  })

  it('a paired notes turn and an eval capture get no lookups (and no line)', async () => {
    const notes = await runRoute({ ...body, live_role: 'notes' as const }, WITH_READ)
    expect(notes.claims).not.toHaveProperty('mcpLookups')
    expect(notes.message).not.toContain(MCP_LOOKUPS_LINE)
    const evalTurn = await runRoute(body, { ...WITH_READ, isEval: true })
    expect(evalTurn.claims).not.toHaveProperty('mcpLookups')
    expect(evalTurn.message).not.toContain(MCP_LOOKUPS_LINE)
    // A stamped token on an eval capture still gets nothing (isolation only tightens).
    const client = createFakeSupabase(meetingFixture({ ...WITH_READ, isEval: true })).client
    const spec = await rebuildLiveAgentSpec({ ...evalTurn.claims, mcpLookups: true }, { supabase: client })
    expect(spec!.ceiling).not.toContain(LOOKUP)
  })

  it('an assist-only copilot with lookups reads the read-only variant, never propose_mcp_call (route ⇔ spec)', async () => {
    const fixture: FixtureOptions = { ...WITH_READ, recipes: { 'r-assist': ASSIST_RECIPE } }
    const assistBody = { ...body, recipe_id: 'r-assist' }
    const { message, claims } = await runRoute(assistBody, fixture)
    expect(claims.mcpLookups).toBe(true)
    expect(message).toContain(MCP_LOOKUPS_LINE)
    expect(message).not.toContain('propose_mcp_call')
    const client = createFakeSupabase(meetingFixture(fixture)).client
    const block2 = await rebuildLiveAgentContextBlock(claims, [], { supabase: client })
    expect(message).toBe(composeLiveAgentMessage(block2!, transcriptBlockFor(assistBody, fixture)))
    const spec = await rebuildLiveAgentSpec(claims, { supabase: client })
    expect(spec!.ceiling).toContain(LOOKUP)
    expect(spec!.ceiling).not.toContain('propose_mcp_call')
  })

  it('an assist-only copilot without lookups gets no MCP block at all', async () => {
    const fixture: FixtureOptions = { recipes: { 'r-assist': ASSIST_RECIPE } }
    const { message } = await runRoute({ ...body, recipe_id: 'r-assist' }, fixture)
    expect(message).not.toContain('## Connected external MCP servers')
    expect(message).not.toContain('propose_mcp_call')
  })
})

describe("a live turn on the person's own ChatGPT plan (the free tier)", () => {
  beforeEach(() => {
    process.env.GATEWAY_USER_TAGGING = 'all'
    process.env.LIVE_AGENT_INTERNAL_SECRET = 'parity-secret'
    delete process.env.USE_GATEWAY
    h.usageRow = { allowed: true, reason: 'chatgpt_plan' }
  })
  afterAll(() => {
    h.usageRow = undefined
  })

  it('the route signs the plan model, the usage row names it (billed at no cost), and the spec runs it with web on the person\'s plan', async () => {
    const body: Body = { capture_id: FIX.captureId, recent_chunks: ['Speaker 1: ship Friday'] }
    const { claims, usage } = await runRoute(body, {})
    expect(claims.model).toBe('chatgpt-plan/gpt-6-luna')
    expect(usage).toMatchObject({ provider: 'chatgpt-plan', model: 'chatgpt-plan/gpt-6-luna', feature: 'live_agent' })
    const spec = await rebuildLiveAgentSpec(claims, { supabase: createFakeSupabase(meetingFixture({})).client })
    expect(spec).toMatchObject({
      model: 'openai/gpt-6-luna',
      webAccess: true,
      chatgptPlan: { model: 'gpt-6-luna', helperModel: 'gpt-6-luna', reasoning: 'medium' },
    })
    expect(spec).not.toHaveProperty('modelPolicy')
    expect(spec).not.toHaveProperty('gatewayTelemetry')
    expect(spec!.systemPrompt).toContain(WEB_ACCESS_GUIDANCE)
  })

  it('a batch pass thinks on the plan at the same Think reasoning as a live turn, as DeepSeek does on Native Intelligence', async () => {
    const { claims } = await runRoute({ capture_id: FIX.captureId, mode: 'batch', prior_transcript: 'Speaker 1: ship Friday' }, {})
    const spec = await rebuildLiveAgentSpec(claims, { supabase: createFakeSupabase(meetingFixture({})).client })
    expect(spec!.chatgptPlan).toEqual({ model: 'gpt-6-luna', helperModel: 'gpt-6-luna', reasoning: 'medium' })
  })
})

