/**
 * Route tests for POST /api/internal/work-run/tool — the eve work-agent's
 * tool-dispatch trust boundary (Loops v3 work proposals).
 *
 * Load-bearing invariants:
 *   1. The work-run ceiling is the registry tools classified read /
 *      internal-write (their required `sideEffect`): an admitted tool
 *      (create_action, create_email_draft, create_document) dispatches; a tool
 *      in any other class (publish_draft, publish_prospect_list,
 *      push_action_to_asana/jira/linear, create_flow, update_flow,
 *      update_sequence, update_skill, create_skill, accept_proposal,
 *      start_eval_run, delete_action, delete_calendar_event, delete_flow,
 *      delete_label, …) is rejected 403 TOOL_OUT_OF_CEILING and NEVER reaches
 *      dispatch. Every registry tool is checked against its class below.
 *   2. search_tools (read-only discovery) is always permitted.
 *   3. prototype-magic names ('__proto__', 'constructor') are rejected and never
 *      reach dispatch.
 *   4. AUTH: 401 without secret / token; a valid token for a run that is not a
 *      WORK run (kind != 'workspace') or not in the claimed workspace never
 *      reaches the ceiling or dispatch.
 *   5. STATUS: a canceled/canceling run is refused 409; a settled
 *      completed/failed run still dispatches (the user's follow-up chat).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TOOL_IMAGE_NOT_SHOWN } from '@/lib/ai/tools/tool-image'

const SECRET = 'test-work-run-tool-secret-abcdef0'

const executeSpy = vi.fn(async () => ({ ok: true }))
const stubTool = {
  description: 'stub',
  inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
  execute: executeSpy,
}

// Records the exact args the route hands createTools, so we can assert the work-run
// route requests the strict-workspace fence.
const createToolsArgs: { last?: unknown[] } = {}

// A fake service-role supabase modeling two entities: one in the run's OWN
// workspace (ws-1) and one in a FOREIGN workspace (ws-OTHER). resolveEntityWorkspace
// issues a fast-path query (id + workspace_id) and, when that misses AND strict is
// off, a slow-path query (id only). Strict must skip the slow path entirely.
const ENTITY_WORKSPACE: Record<string, string> = {
  'act-local': 'ws-1',
  'act-foreign': 'ws-OTHER',
}
// agent_run rows the route's run-kind gate looks up (id + workspace_id).
const RUNS: Record<
  string,
  {
    workspace_id: string
    kind: string
    status: string
    origin?: string
    origin_depth?: number
    chat_ceiling?: string[] | null
    teammate?: { allowed_side_effects: string[]; tool_allowlist: string[] | null } | null
    action_id?: string | null
    server_helper?: string | null
  }
> = {
  // Decision 9: a delegated action's work run, anchored to the action it works.
  'run-delegate': { workspace_id: 'ws-1', kind: 'workspace', status: 'running', origin: 'user', origin_depth: 0, action_id: 'act-local' },
  // Migration 299: chat work is bounded by what the delegating chat could call.
  'run-chat-docs-only': {
    workspace_id: 'ws-1', kind: 'workspace', status: 'running', origin: 'chat', origin_depth: 0,
    chat_ceiling: ['create_document', 'get_document'],
    teammate: { allowed_side_effects: ['read', 'internal-write'], tool_allowlist: null },
  },
  'run-chat-child-docs-only': {
    workspace_id: 'ws-1', kind: 'workspace', status: 'running', origin: 'delegation', origin_depth: 1,
    chat_ceiling: ['create_document', 'get_document'],
    teammate: { allowed_side_effects: ['read', 'internal-write'], tool_allowlist: null },
  },
  'run-chat-unbounded-legacy': {
    workspace_id: 'ws-1', kind: 'workspace', status: 'running', origin: 'chat', origin_depth: 0, chat_ceiling: null,
    teammate: { allowed_side_effects: ['read', 'internal-write'], tool_allowlist: null },
  },
  'run-1': { workspace_id: 'ws-1', kind: 'workspace', status: 'running' },
  // A server-started helper writes for one person (migration 369).
  'run-prep': { workspace_id: 'ws-1', kind: 'workspace', status: 'running', server_helper: 'meeting_prep' },
  // Sequence step 3: an ATTEMPTED run drafts (plan A.3), and a delegated child sits deeper.
  'run-attempt': { workspace_id: 'ws-1', kind: 'workspace', status: 'running', origin: 'attempt', origin_depth: 0 },
  'run-attempt-completed': { workspace_id: 'ws-1', kind: 'workspace', status: 'completed', origin: 'attempt', origin_depth: 0 },
  'run-child': { workspace_id: 'ws-1', kind: 'workspace', status: 'running', origin: 'delegation', origin_depth: 1 },
  // B PR 4: an attempted run done by a teammate is bounded by that teammate too.
  'run-attempt-reader': {
    workspace_id: 'ws-1', kind: 'workspace', status: 'running', origin: 'attempt', origin_depth: 0,
    teammate: { allowed_side_effects: ['read'], tool_allowlist: null },
  },
  'run-attempt-allowlist': {
    workspace_id: 'ws-1', kind: 'workspace', status: 'running', origin: 'attempt', origin_depth: 0,
    teammate: { allowed_side_effects: ['read', 'internal-write'], tool_allowlist: ['create_email_draft'] },
  },
  'run-user-reader': {
    workspace_id: 'ws-1', kind: 'workspace', status: 'running', origin: 'user', origin_depth: 0,
    teammate: { allowed_side_effects: ['read'], tool_allowlist: [] },
  },
  'run-coding': { workspace_id: 'ws-1', kind: 'coding', status: 'running' },
  'run-completed': { workspace_id: 'ws-1', kind: 'workspace', status: 'completed' },
  'run-failed': { workspace_id: 'ws-1', kind: 'workspace', status: 'failed' },
  'run-canceling': { workspace_id: 'ws-1', kind: 'workspace', status: 'canceling' },
  'run-canceled': { workspace_id: 'ws-1', kind: 'workspace', status: 'canceled' },
}
function fakeServiceClient() {
  return {
    from: (table: string) => {
      const eqs: Array<[string, unknown]> = []
      if (table === 'agent_run') {
        const runApi: Record<string, unknown> = {
          select: () => runApi,
          eq: (k: string, v: unknown) => {
            eqs.push([k, v])
            return runApi
          },
          maybeSingle: async () => {
            const id = eqs.find(([k]) => k === 'id')?.[1] as string | undefined
            const ws = eqs.find(([k]) => k === 'workspace_id')?.[1]
            const row = id ? RUNS[id] : undefined
            return {
              data:
                row && row.workspace_id === ws
                  ? { id, kind: row.kind, status: row.status, origin: row.origin, origin_depth: row.origin_depth, chat_ceiling: row.chat_ceiling ?? null, teammate: row.teammate ?? null, action_id: row.action_id ?? null, server_helper: row.server_helper ?? null }
                  : null,
              error: null,
            }
          },
        }
        return runApi
      }
      const api: Record<string, unknown> = {
        select: () => api,
        eq: (k: string, v: unknown) => {
          eqs.push([k, v])
          return api
        },
        maybeSingle: async () => {
          const wsEq = eqs.find(([k]) => k === 'workspace_id')
          const idEq = eqs.find(([k]) => k === 'id')
          const entityWs = idEq ? ENTITY_WORKSPACE[idEq[1] as string] : undefined
          if (wsEq && idEq) {
            // Fast path (id + workspace_id) — resolves only when they agree.
            return { data: entityWs === wsEq[1] ? { workspace_id: entityWs } : null, error: null }
          }
          if (idEq) {
            // Slow path (id only) — locates the row in whatever workspace it lives in.
            return { data: entityWs ? { workspace_id: entityWs } : null, error: null }
          }
          return { data: null, error: null }
        },
      }
      return api
    },
  }
}

vi.mock('@/lib/admin', () => ({ getServiceClient: () => fakeServiceClient() }))
// A stub for every createTools() entry — the names we test against must exist so
// the ceiling gate (not a "no such tool" 404) is what decides. `update_action` runs
// the REAL resolveEntityWorkspace under the strict flag the route passes, so we can
// prove the workspace fence end-to-end.
vi.mock('@/lib/ai/tools', async () => {
  const shared = await vi.importActual<typeof import('@/lib/ai/tools/_shared')>('@/lib/ai/tools/_shared')
  return {
    createTools: (
      userId: string,
      supabase: import('@supabase/supabase-js').SupabaseClient,
      workspaceId: string,
      _accessToken?: string,
      options?: { strictWorkspace?: boolean },
    ) => {
      createToolsArgs.last = [userId, supabase, workspaceId, _accessToken, options]
      const strict = options?.strictWorkspace ?? false
      return {
        create_action: stubTool,
        create_email_draft: stubTool,
        create_document: stubTool,
        publish_draft: stubTool,
        delete_action: stubTool,
        // Present in the tool map so ONLY the ceiling gate can stop them — without
        // the exclusion these would dispatch (200), not 404.
        publish_prospect_list: stubTool,
        push_action_to_asana: stubTool,
        push_action_to_jira: stubTool,
        push_action_to_linear: stubTool,
        create_flow: stubTool,
        update_flow: stubTool,
        update_sequence: stubTool,
        update_skill: stubTool,
        create_skill: stubTool,
        accept_proposal: stubTool,
        start_eval_run: stubTool,
        // Resolves an entity id via the REAL strict-aware resolver and echoes the
        // outcome, so a foreign id under strict comes back as not-found.
        update_action: {
          description: 'probe',
          inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
          execute: async (input: { id: string }) => {
            const resolved = await shared.resolveEntityWorkspace(
              supabase,
              userId,
              'actions',
              input.id,
              workspaceId,
              strict,
            )
            return { resolved }
          },
        },
      }
    },
  }
})
vi.mock('@/lib/ai/tool-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/tool-discovery')>()
  return { ...actual, createSearchToolsTool: () => ({ ...stubTool, description: 'search' }) }
})

import { POST } from '@/app/api/internal/work-run/tool/route'
import { TOOL_CATEGORIES, WORK_RUN_ADMITTED_SIDE_EFFECTS, isAttendedOnlyTool, isChatNativeTool } from '@/lib/ai/tool-registry'
import {
  mintAgentRunToken,
  AGENT_RUN_SECRET_HEADER,
  AGENT_RUN_TOKEN_HEADER,
} from '@/lib/agent-run/agent-run-token'

const CLAIMS = { agentRunId: 'run-1', workspaceId: 'ws-1', userId: 'user-1' }

function toolReq(opts: { secret?: string | null; token?: string | null; toolName?: unknown; input?: unknown }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.secret != null) headers[AGENT_RUN_SECRET_HEADER] = opts.secret
  if (opts.token != null) headers[AGENT_RUN_TOKEN_HEADER] = opts.token
  return new Request('http://localhost/api/internal/work-run/tool', {
    method: 'POST',
    headers,
    body: JSON.stringify({ toolName: opts.toolName, input: opts.input ?? {} }),
  })
}

beforeEach(() => {
  process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
  executeSpy.mockClear()
})
afterEach(() => vi.clearAllMocks())

function token() {
  return mintAgentRunToken(CLAIMS)
}

describe('work-run tool route — auth', () => {
  it('401s without secret', async () => {
    const res = await POST(toolReq({ token: token(), toolName: 'create_action' }))
    expect(res.status).toBe(401)
  })
  it('401s without a valid token', async () => {
    const res = await POST(toolReq({ secret: SECRET, toolName: 'create_action' }))
    expect(res.status).toBe(401)
  })
  it('403s a validly signed token for a CODING run, without dispatching', async () => {
    // Same key, same claim shape — only the agent_run row says which kind it is.
    const codingToken = mintAgentRunToken({ ...CLAIMS, agentRunId: 'run-coding' })
    const res = await POST(toolReq({ secret: SECRET, token: codingToken, toolName: 'create_action' }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('RUN_KIND_MISMATCH')
    expect(executeSpy).not.toHaveBeenCalled()
  })
  it('404s a token whose run is not in the claimed workspace, without dispatching', async () => {
    const foreign = mintAgentRunToken({ ...CLAIMS, workspaceId: 'ws-OTHER' })
    const res = await POST(toolReq({ secret: SECRET, token: foreign, toolName: 'create_action' }))
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('RUN_NOT_FOUND')
    expect(executeSpy).not.toHaveBeenCalled()
  })
  it('404s a token for a run that does not exist, without dispatching', async () => {
    const ghost = mintAgentRunToken({ ...CLAIMS, agentRunId: 'run-ghost' })
    const res = await POST(toolReq({ secret: SECRET, token: ghost, toolName: 'create_action' }))
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('RUN_NOT_FOUND')
    expect(executeSpy).not.toHaveBeenCalled()
  })
})

describe('work-run tool route — run status', () => {
  it('still dispatches for a settled completed/failed run (follow-up chat acts through these tools)', async () => {
    for (const agentRunId of ['run-completed', 'run-failed']) {
      executeSpy.mockClear()
      const settled = mintAgentRunToken({ ...CLAIMS, agentRunId })
      const res = await POST(toolReq({ secret: SECRET, token: settled, toolName: 'create_action' }))
      expect(res.status, agentRunId).toBe(200)
      expect(executeSpy).toHaveBeenCalledTimes(1)
    }
  })

  it('409s a canceled or canceling run, without dispatching', async () => {
    for (const agentRunId of ['run-canceling', 'run-canceled']) {
      executeSpy.mockClear()
      const canceled = mintAgentRunToken({ ...CLAIMS, agentRunId })
      const res = await POST(toolReq({ secret: SECRET, token: canceled, toolName: 'create_action' }))
      expect(res.status, agentRunId).toBe(409)
      expect((await res.json()).code).toBe('RUN_NOT_ACTIVE')
      expect(executeSpy).not.toHaveBeenCalled()
    }
  })
})

describe('work-run tool route — images', () => {
  it('an image a tool returns (read_chat_file on a photo) is stripped with a note: a run’s model never gets base64 as text', async () => {
    executeSpy.mockResolvedValueOnce({ success: true, file_name: 'a.png', __imageBase64: 'QUJD', __imageMimeType: 'image/jpeg' } as never)
    const res = await POST(toolReq({ secret: SECRET, token: token(), toolName: 'create_email_draft' }))
    expect(res.status).toBe(200)
    expect((await res.json()).output).toEqual({ success: true, file_name: 'a.png', image: TOOL_IMAGE_NOT_SHOWN })
  })
})

describe('work-run tool route — ceiling', () => {
  it('permits an in-ceiling tool (create_email_draft)', async () => {
    const res = await POST(toolReq({ secret: SECRET, token: token(), toolName: 'create_email_draft' }))
    expect(res.status).toBe(200)
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })

  it('permits create_action and create_document', async () => {
    for (const name of ['create_action', 'create_document']) {
      executeSpy.mockClear()
      const res = await POST(toolReq({ secret: SECRET, token: token(), toolName: name }))
      expect(res.status).toBe(200)
      expect(executeSpy).toHaveBeenCalledTimes(1)
    }
  })

  it('rejects publish_draft (delete class: hard-deletes the draft row) 403 without dispatching', async () => {
    const res = await POST(toolReq({ secret: SECRET, token: token(), toolName: 'publish_draft' }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('TOOL_OUT_OF_CEILING')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('rejects publish_prospect_list (writes the CRM) 403 without dispatching', async () => {
    const res = await POST(toolReq({ secret: SECRET, token: token(), toolName: 'publish_prospect_list' }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('TOOL_OUT_OF_CEILING')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('rejects every push_action_to_* tool (third-party issue/task write) 403 without dispatching', async () => {
    for (const name of ['push_action_to_asana', 'push_action_to_jira', 'push_action_to_linear']) {
      executeSpy.mockClear()
      const res = await POST(toolReq({ secret: SECRET, token: token(), toolName: name }))
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe('TOOL_OUT_OF_CEILING')
      expect(executeSpy).not.toHaveBeenCalled()
    }
  })

  it('rejects create_flow / update_flow (outbound HTTP automations) 403 without dispatching', async () => {
    for (const name of ['create_flow', 'update_flow']) {
      executeSpy.mockClear()
      const res = await POST(toolReq({ secret: SECRET, token: token(), toolName: name }))
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe('TOOL_OUT_OF_CEILING')
      expect(executeSpy).not.toHaveBeenCalled()
    }
  })

  it('rejects update_sequence (can resume live outbound email) 403 without dispatching', async () => {
    const res = await POST(toolReq({ secret: SECRET, token: token(), toolName: 'update_sequence' }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('TOOL_OUT_OF_CEILING')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('rejects update_skill / create_skill (automation re-aim, Discover publish) 403 without dispatching', async () => {
    for (const name of ['update_skill', 'create_skill']) {
      executeSpy.mockClear()
      const res = await POST(toolReq({ secret: SECRET, token: token(), toolName: name }))
      expect(res.status, name).toBe(403)
      expect((await res.json()).code).toBe('TOOL_OUT_OF_CEILING')
      expect(executeSpy).not.toHaveBeenCalled()
    }
  })

  it('rejects accept_proposal (runs staged MCP calls and deletes) 403 without dispatching', async () => {
    const res = await POST(toolReq({ secret: SECRET, token: token(), toolName: 'accept_proposal' }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('TOOL_OUT_OF_CEILING')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('rejects every delete-class tool 403 without dispatching', async () => {
    for (const name of ['delete_action', 'delete_calendar_event', 'delete_flow', 'delete_label']) {
      executeSpy.mockClear()
      const res = await POST(toolReq({ secret: SECRET, token: token(), toolName: name }))
      expect(res.status).toBe(403)
      expect(executeSpy).not.toHaveBeenCalled()
    }
  })

  it('rejects EVERY registry tool classified outside read/internal-write 403 TOOL_OUT_OF_CEILING', async () => {
    // Driven by the registry classification, not a hand list: a tool newly
    // classified external-write / automation-write / delete is covered here
    // without editing this file. The ceiling gate runs before the tool lookup,
    // so a name with no stub still proves the gate refused it.
    const outside = TOOL_CATEGORIES.flatMap((c) => c.tools).filter(
      (t) => !WORK_RUN_ADMITTED_SIDE_EFFECTS.has(t.sideEffect),
    )
    expect(outside.length).toBeGreaterThan(0)
    for (const t of outside) {
      executeSpy.mockClear()
      const res = await POST(toolReq({ secret: SECRET, token: token(), toolName: t.name }))
      expect(res.status, `${t.name} (${t.sideEffect})`).toBe(403)
      expect((await res.json()).code, t.name).toBe('TOOL_OUT_OF_CEILING')
      expect(executeSpy).not.toHaveBeenCalled()
    }
  })

  it('passes EVERY registry tool classified read/internal-write through the ceiling gate', async () => {
    // A name with a stub dispatches (200); a name without one reaches the tool
    // lookup and 404s as unknown. Either way it was NOT refused by the ceiling.
    // Minus the attended-only tools (bots v3 Phase 5) and the chat-native ones
    // (bots-v4 Phase A3: wait_for_bot_reply is a read): out of a work run by name.
    const admitted = TOOL_CATEGORIES.flatMap((c) => c.tools).filter(
      (t) => WORK_RUN_ADMITTED_SIDE_EFFECTS.has(t.sideEffect) && !isAttendedOnlyTool(t.name) && !isChatNativeTool(t.name),
    )
    expect(admitted.length).toBeGreaterThan(0)
    for (const t of admitted) {
      const res = await POST(toolReq({ secret: SECRET, token: token(), toolName: t.name }))
      expect(res.status, `${t.name} (${t.sideEffect})`).not.toBe(403)
      expect([200, 404], t.name).toContain(res.status)
    }
  })

  it('rejects start_eval_run (replays cases through another agent at scale) 403 without dispatching', async () => {
    const res = await POST(toolReq({ secret: SECRET, token: token(), toolName: 'start_eval_run' }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('TOOL_OUT_OF_CEILING')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('always permits search_tools', async () => {
    const res = await POST(toolReq({ secret: SECRET, token: token(), toolName: 'search_tools' }))
    expect(res.status).toBe(200)
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects prototype-magic names without dispatching', async () => {
    for (const name of ['__proto__', 'constructor', 'hasOwnProperty']) {
      executeSpy.mockClear()
      const res = await POST(toolReq({ secret: SECRET, token: token(), toolName: name }))
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe('TOOL_OUT_OF_CEILING')
      expect(executeSpy).not.toHaveBeenCalled()
    }
  })
})

describe('work-run tool route — strict workspace fence', () => {
  it('builds tools with strictWorkspace: true (the run is single-workspace fenced)', async () => {
    createToolsArgs.last = undefined
    await POST(toolReq({ secret: SECRET, token: token(), toolName: 'create_action' }))
    const opts = createToolsArgs.last?.[4] as { strictWorkspace?: boolean; automaticDrafts?: boolean } | undefined
    expect(opts?.strictWorkspace).toBe(true)
    // Its own turns draft for nobody who asked: the shared cap and the open-draft check hold.
    expect(opts?.automaticDrafts).toBe(true)
  })

  it("a server-started helper's documents are its person's by default; any other run's are the workspace's (369)", async () => {
    createToolsArgs.last = undefined
    await POST(toolReq({ secret: SECRET, token: mintAgentRunToken({ ...CLAIMS, agentRunId: 'run-prep' }), toolName: 'create_document' }))
    expect((createToolsArgs.last?.[4] as { defaultDocumentVisibility?: string } | undefined)?.defaultDocumentVisibility).toBe('private')

    createToolsArgs.last = undefined
    await POST(toolReq({ secret: SECRET, token: token(), toolName: 'create_document' }))
    expect((createToolsArgs.last?.[4] as { defaultDocumentVisibility?: string } | undefined)?.defaultDocumentVisibility).toBeUndefined()
  })

  it('a run with nobody watching files actions as suggested (the promotion guard), and its own action goes to review', async () => {
    createToolsArgs.last = undefined
    await POST(toolReq({ secret: SECRET, token: mintAgentRunToken({ ...CLAIMS, agentRunId: 'run-delegate' }), toolName: 'create_action' }))
    const opts = createToolsArgs.last?.[4] as { actionRules?: { fileActionsAsSuggested?: boolean; reviewActionIds?: string[] } } | undefined
    expect(opts?.actionRules).toMatchObject({ unattended: true, fileActionsAsSuggested: true, reviewActionIds: ['act-local'] })
    expect(typeof (opts?.actionRules as { filedByRun?: unknown } | undefined)?.filedByRun).toBe('function')
  })

  it('a run with no action of its own still files suggested, with nothing to route to review', async () => {
    createToolsArgs.last = undefined
    await POST(toolReq({ secret: SECRET, token: token(), toolName: 'create_action' }))
    const opts = createToolsArgs.last?.[4] as { actionRules?: { fileActionsAsSuggested?: boolean; reviewActionIds?: string[] } } | undefined
    expect(opts?.actionRules).toMatchObject({ unattended: true, fileActionsAsSuggested: true, reviewActionIds: [] })
    // Fail closed: with no ledger row to read what it filed, everything counts
    // as filed by this run, so it confirms none of it.
    const filed = await (opts?.actionRules as { filedByRun: (ids: string[]) => Promise<Set<string>> }).filedByRun(['AAA', 'bbb'])
    expect(filed).toEqual(new Set(['aaa', 'bbb']))
  })

  it("stamps the run's status writes as an AGENT's at depth 1 (the flow loop guard reads it)", async () => {
    createToolsArgs.last = undefined
    await POST(toolReq({ secret: SECRET, token: token(), toolName: 'create_action' }))
    const opts = createToolsArgs.last?.[4] as { origin?: { actor: string; depth: number; run_id?: string } } | undefined
    expect(opts?.origin).toMatchObject({ actor: 'agent', depth: 1 })
    expect(typeof opts?.origin?.run_id).toBe('string')
  })

  it('refuses a foreign-workspace entity id end to end (resolves as not-found)', async () => {
    // The entity lives in ws-OTHER; the run is bound to ws-1. Under the strict fence
    // the cross-workspace slow path is skipped, so it resolves to null — never
    // revealing that the id exists elsewhere.
    const res = await POST(
      toolReq({ secret: SECRET, token: token(), toolName: 'update_action', input: { id: 'act-foreign' } }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.output.resolved).toBeNull()
  })

  it('still resolves an entity that lives in the run’s OWN workspace', async () => {
    // A row fenced to ws-1 (the bound workspace) resolves on the fast path — strict
    // only closes the CROSS-workspace slow path, never the legitimate in-workspace one.
    const res = await POST(
      toolReq({ secret: SECRET, token: token(), toolName: 'update_action', input: { id: 'act-local' } }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.output.resolved).toEqual({ workspaceId: 'ws-1', crossWorkspace: false })
  })
})

// ── Sequence step 3: the profile and the depth come from the ROW's origin ──────
describe('work-run tool route — an ATTEMPTED run drafts (plan A.3)', () => {
  const attemptToken = (agentRunId = 'run-attempt') => mintAgentRunToken({ ...CLAIMS, agentRunId })

  it('admits artifact writes (create_document, create_email_draft) on an attempted run', async () => {
    for (const toolName of ['create_document', 'create_email_draft']) {
      const res = await POST(toolReq({ secret: SECRET, token: attemptToken(), toolName }))
      expect(res.status, toolName).toBe(200)
    }
  })

  it('refuses board writes (create_action, update_action) on an attempted run with 403 TOOL_OUT_OF_CEILING — and never dispatches', async () => {
    for (const toolName of ['create_action', 'update_action']) {
      const res = await POST(toolReq({ secret: SECRET, token: attemptToken(), toolName, input: { id: 'act-local' } }))
      expect(res.status, toolName).toBe(403)
      expect((await res.json()).code).toBe('TOOL_OUT_OF_CEILING')
    }
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('the follow-up chat on a SETTLED attempted run keeps the drafting ceiling', async () => {
    const res = await POST(toolReq({ secret: SECRET, token: attemptToken('run-attempt-completed'), toolName: 'create_action' }))
    expect(res.status).toBe(403)
  })

  it('the same person-started run still gets create_action (unchanged)', async () => {
    const res = await POST(toolReq({ secret: SECRET, token: token(), toolName: 'create_action' }))
    expect(res.status).toBe(200)
  })

  it('B PR 4: an attempted run done by a read-only teammate may read but not draft', async () => {
    const draft = await POST(toolReq({ secret: SECRET, token: attemptToken('run-attempt-reader'), toolName: 'create_document' }))
    expect(draft.status).toBe(403)
    expect((await draft.json()).code).toBe('TOOL_OUT_OF_CEILING')
    // Past the ceiling gate (the harness's entity lookup answers the rest).
    const read = await POST(toolReq({ secret: SECRET, token: attemptToken('run-attempt-reader'), toolName: 'get_document', input: { id: 'doc-1' } }))
    expect(read.status).not.toBe(403)
  })

  it('B PR 4: and to its allowlist; a person-started run is not bounded by its teammate', async () => {
    expect((await POST(toolReq({ secret: SECRET, token: attemptToken('run-attempt-allowlist'), toolName: 'create_email_draft' }))).status).toBe(200)
    expect((await POST(toolReq({ secret: SECRET, token: attemptToken('run-attempt-allowlist'), toolName: 'create_document' }))).status).toBe(403)
    expect((await POST(toolReq({ secret: SECRET, token: attemptToken('run-user-reader'), toolName: 'create_action' }))).status).toBe(200)
  })

  it('stamps an attempted run\'s status writes at depth 2, and a delegated child at 2 + its chain depth (fails closed to the drafting ceiling too)', async () => {
    createToolsArgs.last = undefined
    await POST(toolReq({ secret: SECRET, token: attemptToken(), toolName: 'create_document' }))
    expect((createToolsArgs.last?.[4] as unknown as { origin?: { depth: number } }).origin?.depth).toBe(2)
    createToolsArgs.last = undefined
    const child = await POST(toolReq({ secret: SECRET, token: attemptToken('run-child'), toolName: 'create_action' }))
    expect(child.status).toBe(403)
    await POST(toolReq({ secret: SECRET, token: attemptToken('run-child'), toolName: 'create_document' }))
    expect((createToolsArgs.last?.[4] as unknown as { origin?: { depth: number } }).origin?.depth).toBe(3)
  })
})

describe('work-run tool route — chat work is bounded by the delegating chat (migration 299)', () => {
  const runToken = (agentRunId: string) => mintAgentRunToken({ ...CLAIMS, agentRunId })

  it('a chat root may use only the tools its chat could call, though its teammate may draft email', async () => {
    expect((await POST(toolReq({ secret: SECRET, token: runToken('run-chat-docs-only'), toolName: 'create_document' }))).status).toBe(200)
    for (const toolName of ['create_email_draft', 'read_email', 'find']) {
      const res = await POST(toolReq({ secret: SECRET, token: runToken('run-chat-docs-only'), toolName }))
      expect(res.status, toolName).toBe(403)
      expect((await res.json()).code).toBe('TOOL_OUT_OF_CEILING')
    }
  })

  it('so does a teammate handoff under that chat root', async () => {
    expect((await POST(toolReq({ secret: SECRET, token: runToken('run-chat-child-docs-only'), toolName: 'create_document' }))).status).toBe(200)
    expect((await POST(toolReq({ secret: SECRET, token: runToken('run-chat-child-docs-only'), toolName: 'create_email_draft' }))).status).toBe(403)
  })

  it('a chat root with no recorded bound fails closed (no registry tools)', async () => {
    const res = await POST(toolReq({ secret: SECRET, token: runToken('run-chat-unbounded-legacy'), toolName: 'create_document' }))
    expect(res.status).toBe(403)
    expect(executeSpy).not.toHaveBeenCalled()
  })
})
