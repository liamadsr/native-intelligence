/**
 * Route tests for GET /api/internal/agent-run/spec — the eve coding-agent's
 * spec trust boundary (Phase 3).
 *
 * Load-bearing invariants:
 *   1. AUTH: 401 without the shared secret; 401 with a bad/expired/missing token.
 *   2. 404 when the run/action can't be rebuilt (missing run, missing
 *      repo/token/persona/task) — the run can't proceed.
 *   3. SHAPE: a rebuildable action-origin run returns the pinned EveSpec, with
 *      the persona system prompt, the `<issue>` task text (untrusted-fenced), the
 *      repo/branch, the GitHub token, and the cloud-environment defaults
 *      (trusted/allow-all, no setup, no env) when the run, its project and its
 *      workspace have no environment (migration 420, resolveRunEnvironment).
 *   4. FLOW-ORIGIN (action_id NULL): a runnable flow-origin row is served too —
 *      its spec comes from the row's own columns (task_prompt verbatim,
 *      repo_full_name, the agent recipe persona), in the workspace default
 *      cloud environment when there is one.
 *
 * The service client is a small table-backed fake; loadAgentPersona is mocked to
 * a fixed persona so we assert the composed prompt without touching the recipe
 * tables. computeActionTaskPrompt is the REAL one (imported by the route via
 * spec-rebuild), so the task-text parity is exercised end-to-end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const SECRET = 'test-agent-run-secret-spec-000000'

// ── Table-backed service-client fake ────────────────────────────────────────
// Per-test rows; each table's read resolves from `store`. Only reads are needed
// for the spec route (it never writes).
const store: Record<string, unknown> = {}

function makeClient() {
  const chain = (table: string): Record<string, unknown> => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order', 'limit', 'or']) c[m] = () => c
    c.maybeSingle = async () => ({ data: (store[table] as unknown) ?? null, error: null })
    c.single = async () => ({ data: (store[table] as unknown) ?? null, error: null })
    return c
  }
  return { from: (t: string) => chain(t) }
}

vi.mock('@/lib/admin', () => ({ getServiceClient: () => makeClient() }))
// The repo's default branch (a GitHub API call) — pinned so tests never go to the network.
vi.mock('@/lib/agent-run/github-default-branch', () => ({ resolveRepoDefaultBranch: vi.fn(async () => 'main') }))

// Fixed persona so the composed prompt is deterministic (recipe tables untouched).
vi.mock('@/lib/ai/agent-run-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/agent-run-context')>()
  return {
    ...actual, // keep the REAL composeActionTaskPrompt + composeEveCodingSystemPrompt
    loadAgentPersona: vi.fn(async () => ({
      name: 'Dev Bot',
      agentSystemPrompt: 'You are a careful engineer.',
      skills: [],
    })),
    loadAgentPersonaFromRecipe: vi.fn(async () => ({
      name: 'Flow Bot',
      agentSystemPrompt: 'You ship small PRs.',
      agentConfig: null,
      skills: [],
    })),
  }
})

import { GET } from '@/app/api/internal/agent-run/spec/route'
import { wrapUntrusted } from '@/lib/email/untrusted'
import { verifyGitPushToken } from '@/lib/agent-run/git-push-token'
import {
  mintAgentRunToken,
  verifyAgentRunToken,
  AGENT_RUN_SECRET_HEADER,
  AGENT_RUN_TOKEN_HEADER,
} from '@/lib/agent-run/agent-run-token'

function specReq(opts: { secret?: string | null; token?: string | null }) {
  const headers: Record<string, string> = {}
  if (opts.secret != null) headers[AGENT_RUN_SECRET_HEADER] = opts.secret
  if (opts.token != null) headers[AGENT_RUN_TOKEN_HEADER] = opts.token
  return new Request('http://localhost/api/internal/agent-run/spec', { method: 'GET', headers })
}

const CLAIMS = { agentRunId: 'run-1', workspaceId: 'ws-1', userId: 'user-1' }

/** A fully-runnable action-origin run: run + action(+project) + github token. */
function seedRunnable() {
  store.agent_run = {
    id: 'run-1',
    action_id: 'action-1',
    ai_team_member_id: 'member-1',
    triggered_by: 'user-1',
  }
  store.actions = {
    id: 'action-1',
    identifier: 'ENG-42',
    title: 'Add a widget',
    description: 'Build the widget.',
    priority: 'high',
    project_id: 'proj-1',
    workflow_state: { name: 'In Progress' },
    project: { name: 'Web', github_repo: 'acme/web' },
  }
  store.user_oauth_tokens = { access_token: 'ghp_spec_token' }
  store.projects = { environment_id: null }
  store.workspace = { default_cloud_environment_id: null }
  store.environment = null
}

/** A shared, live cloud environment of ws-1 (migration 420's environment, kind cloud). */
function cloudEnv(over: Record<string, unknown> = {}) {
  return {
    id: 'env-1',
    kind: 'cloud',
    name: 'Web',
    workspace_id: 'ws-1',
    shared: true,
    created_by: null,
    network_access: 'restricted',
    env_vars: 'FOO=bar\nBAZ=qux',
    setup_script: 'npm ci',
    archived_at: null,
    ...over,
  }
}

beforeEach(() => {
  process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
  for (const k of Object.keys(store)) delete store[k]
})
afterEach(() => {
  delete process.env.AGENT_RUN_INTERNAL_SECRET
})

describe('GET /api/internal/agent-run/spec — auth', () => {
  it('401 without the shared secret', async () => {
    const res = await GET(specReq({ token: mintAgentRunToken(CLAIMS) }))
    expect(res.status).toBe(401)
  })
  it('401 with the secret but no token', async () => {
    const res = await GET(specReq({ secret: SECRET }))
    expect(res.status).toBe(401)
  })
  it('401 with a garbage token', async () => {
    const res = await GET(specReq({ secret: SECRET, token: 'not-a-token' }))
    expect(res.status).toBe(401)
  })
})

describe('GET /api/internal/agent-run/spec — 404 unrunnable', () => {
  it('404 when the run row is missing', async () => {
    // no store.agent_run
    const res = await GET(specReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS) }))
    expect(res.status).toBe(404)
  })

  it('404 for a flow-origin run with no repo, persona, or task on the row', async () => {
    store.agent_run = { id: 'run-1', action_id: null, ai_team_member_id: null, triggered_by: 'user-1' }
    store.user_oauth_tokens = { access_token: 'ghp_spec_token' }
    const res = await GET(specReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS) }))
    expect(res.status).toBe(404)
  })

  it('404 when the project has no repo', async () => {
    seedRunnable()
    ;(store.actions as { project: { github_repo: string | null } }).project.github_repo = null
    const res = await GET(specReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS) }))
    expect(res.status).toBe(404)
  })

  it('404 when there is no GitHub token for the user', async () => {
    seedRunnable()
    store.user_oauth_tokens = null
    const res = await GET(specReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS) }))
    expect(res.status).toBe(404)
  })

  it("404 and no GitHub token for a work run (kind='workspace') even with a persona and a repo'd project", async () => {
    seedRunnable()
    ;(store.agent_run as Record<string, unknown>).kind = 'workspace'
    const res = await GET(specReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS) }))
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('ghp_spec_token')
  })

  it('404 and no GitHub token for a canceled run (the token outlives the run)', async () => {
    seedRunnable()
    ;(store.agent_run as Record<string, unknown>).status = 'canceled'
    const res = await GET(specReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS) }))
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('ghp_spec_token')
  })

  it('404 for a run that is canceling', async () => {
    seedRunnable()
    ;(store.agent_run as Record<string, unknown>).status = 'canceling'
    const res = await GET(specReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS) }))
    expect(res.status).toBe(404)
  })

  it('200 for a running run (the liveness gate only refuses canceling/settled rows)', async () => {
    seedRunnable()
    ;(store.agent_run as Record<string, unknown>).status = 'running'
    const res = await GET(specReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS) }))
    expect(res.status).toBe(200)
  })
})

describe('GET /api/internal/agent-run/spec — shape + fail-open env', () => {
  it('returns the pinned EveSpec with persona, task text, repo, token, and fail-open env defaults', async () => {
    seedRunnable()
    const res = await GET(specReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS) }))
    expect(res.status).toBe(200)
    const spec = await res.json()

    // Persona system prompt composed from the mocked persona.
    expect(spec.systemPrompt).toContain('Dev Bot')
    expect(spec.systemPrompt).toContain('You are a careful engineer.')

    // Task text is the `<issue>` block, its title + description fenced as untrusted.
    expect(spec.taskPrompt).toContain('Work on Native Intelligence issue ENG-42:')
    expect(spec.taskPrompt).toContain('<issue identifier="ENG-42">')
    expect(spec.taskPrompt).toContain(`<title>${wrapUntrusted('Add a widget', 'WORKSPACE')}</title>`)
    expect(spec.taskPrompt).toContain('<status>In Progress</status>')
    expect(spec.taskPrompt).toContain('<priority>high</priority>')
    expect(spec.taskPrompt).toContain('<project name="Web"/>')
    expect(spec.taskPrompt).toContain('<repository url="https://github.com/acme/web">acme/web</repository>')
    expect(spec.taskPrompt).toContain(`<description>${wrapUntrusted('Build the widget.', 'WORKSPACE')}</description>`)

    expect(spec.repoFullName).toBe('acme/web')
    expect(spec.baseBranch).toBe('main')
    expect(spec.branchName).toBe('dial8/eng-42-run-1') // agentRunId 'run-1'.slice(0,8) === 'run-1'
    expect(spec.githubToken).toBe('ghp_spec_token')
    // The Strong tier (STRONG_MODEL): coding runs on the newest Sonnet.
    expect(spec.model).toBe('anthropic/claude-sonnet-5.5')

    // FAIL-OPEN defaults: no linked cloud environment → trusted/no-setup/no-env.
    expect(spec.networkAccess).toBe('trusted')
    expect(spec.setupScript).toBeNull()
    expect(spec.envVars).toEqual({})
  })

  it("carries the run's push token for the git push gate: bound to this run, and never a run token", async () => {
    seedRunnable()
    const res = await GET(specReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS) }))
    const spec = await res.json()
    expect(verifyGitPushToken(spec.gitPushToken)).toMatchObject({
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      repoFullName: 'acme/web',
      branchName: 'dial8/eng-42-run-1',
    })
    expect(verifyAgentRunToken(spec.gitPushToken)).toBeNull()
  })

  it('applies the project’s cloud environment (network/setup/env) when present', async () => {
    seedRunnable()
    store.projects = { environment_id: 'env-1' }
    store.environment = cloudEnv()
    const res = await GET(specReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS) }))
    expect(res.status).toBe(200)
    const spec = await res.json()
    expect(spec.networkAccess).toBe('restricted')
    expect(spec.setupScript).toBe('npm ci')
    expect(spec.envVars).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('an archived environment is skipped: the defaults, never its settings', async () => {
    seedRunnable()
    store.projects = { environment_id: 'env-1' }
    store.environment = cloudEnv({ archived_at: '2026-10-22T00:00:00Z' })
    const res = await GET(specReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS) }))
    expect(res.status).toBe(200)
    const spec = await res.json()
    expect(spec.networkAccess).toBe('trusted')
    expect(spec.setupScript).toBeNull()
  })
})

describe('GET /api/internal/agent-run/spec — flow-origin (action_id NULL)', () => {
  it('serves the spec from the row: task_prompt verbatim, row repo, recipe persona, no cloud env', async () => {
    store.agent_run = {
      id: 'run-1',
      action_id: null,
      flow_id: 'flow-1',
      ai_team_member_id: null,
      agent_recipe_id: 'recipe-1',
      task_prompt: 'Bump the lodash dependency and fix any breakage.',
      repo_full_name: 'acme/api',
      triggered_by: 'user-1',
    }
    store.user_oauth_tokens = { access_token: 'ghp_spec_token' }
    store.workspace = { default_cloud_environment_id: null }
    const res = await GET(specReq({ secret: SECRET, token: mintAgentRunToken(CLAIMS) }))
    expect(res.status).toBe(200)
    const spec = await res.json()
    expect(spec.systemPrompt).toContain('Flow Bot')
    expect(spec.taskPrompt).toBe('Bump the lodash dependency and fix any breakage.')
    expect(spec.repoFullName).toBe('acme/api')
    expect(spec.branchName).toBe('dial8/flow-run-1-run-1')
    expect(spec.githubToken).toBe('ghp_spec_token')
    expect(spec.networkAccess).toBe('trusted')
    expect(spec.setupScript).toBeNull()
    expect(spec.envVars).toEqual({})
  })
})
