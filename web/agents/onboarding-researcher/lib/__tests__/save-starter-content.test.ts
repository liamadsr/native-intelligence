import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolContext } from 'eve/tools'
import { deriveStarterProjectId, deriveStarterActionId } from '../seed-id'

/**
 * Tests for save_starter_content — the workspace-seeding tool.
 *
 * Coverage:
 *   • owner derivation — tenant is the PRINCIPAL's, schema exposes no tenant lever
 *   • NOT-NULL columns populated on the project + actions (user_id, workspace_id,
 *     team_id, status_id, title, name) mirroring the app's create_action path
 *   • seeded marker written (context_data.seeded_by = 'onboarding')
 *   • server-side caps: at most 4 actions regardless of input; workspaceRename
 *     trimmed + clamped to 80 chars
 *   • idempotent re-run: a workspace whose deterministic starter project already
 *     exists short-circuits to a no-op returning the existing ids (no re-seed)
 *
 * The fake supabase service client records every insert/update/upsert and serves
 * programmable reads keyed by table, so we can both capture writes and steer the
 * idempotency branch.
 */

interface Recorded {
  table: string
  op: 'select' | 'upsert' | 'update'
  payload?: Record<string, unknown>
  options?: Record<string, unknown>
  filters: Record<string, unknown>
}

let recorded: Recorded[]
// Reads keyed `${table}:maybeSingle` (single-row reads) or `${table}:list`
// (awaited multi-row reads). Absent → sensible empty default.
let reads: Record<string, { data: unknown; error: unknown }>

function makeQuery(table: string) {
  const filters: Record<string, unknown> = {}

  const q: Record<string, unknown> = {
    select(_cols?: string) {
      recorded.push({ table, op: 'select', filters })
      return q
    },
    eq(col: string, val: unknown) {
      filters[col] = val
      return q
    },
    order() {
      return q
    },
    limit() {
      return q
    },
    maybeSingle: async () => reads[`${table}:maybeSingle`] ?? { data: null, error: null },
    // A bare-awaited select (`.eq().eq()` with no finalizer) resolves via then().
    then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
      return resolve(reads[`${table}:list`] ?? { data: [], error: null })
    },
    upsert(payload: Record<string, unknown>, options?: Record<string, unknown>) {
      recorded.push({ table, op: 'upsert', payload, options, filters })
      return Promise.resolve({ error: reads[`${table}:upsert-error`]?.error ?? null })
    },
    update(payload: Record<string, unknown>) {
      recorded.push({ table, op: 'update', payload, filters })
      const chain: Record<string, unknown> = {
        eq(col: string, val: unknown) {
          filters[col] = val
          return chain
        },
        then: (resolve: (v: { error: unknown }) => unknown) =>
          resolve({ error: reads[`${table}:update-error`]?.error ?? null }),
      }
      return chain
    },
  }
  return q
}

const fakeService = { from: (table: string) => makeQuery(table) }

vi.mock('../tool-context.js', async () => {
  const actual = await vi.importActual<typeof import('../tool-context')>('../tool-context')
  return { ...actual, serviceClient: () => fakeService }
})

import saveStarterContent from '../../tools/save_starter_content'

function ctxWith(
  principal: { principalId: string; workspaceId: string; principalType?: string } | null,
): ToolContext {
  const current =
    principal === null
      ? null
      : {
          authenticator: 'app',
          principalId: principal.principalId,
          principalType: principal.principalType ?? 'user',
          attributes: { workspaceId: principal.workspaceId },
        }
  return {
    session: { id: 'sess', auth: { current, initiator: current }, turn: { id: 'turn-1' } },
  } as unknown as ToolContext
}

const PRINCIPAL = { principalId: 'real-user', workspaceId: 'real-ws' }

/** Steer the "not yet seeded" happy path: no existing project, team + state resolve. */
function primeUnseeded() {
  reads['projects:maybeSingle'] = { data: null, error: null } // no existing starter project
  reads['team:maybeSingle'] = { data: { id: 'team-1' }, error: null }
  reads['workflow_state:maybeSingle'] = { data: { id: 'state-1' }, error: null }
  // The rename defense-in-depth reads the caller's member role; the default
  // principal is the workspace OWNER, so renames are allowed unless a test
  // overrides this to a non-owner role.
  reads['member:maybeSingle'] = { data: { role: 'owner' }, error: null }
}

beforeEach(() => {
  recorded = []
  reads = {}
})

describe('save_starter_content — owner derivation', () => {
  it('writes project + actions scoped to the PRINCIPAL workspace, ignoring model input', async () => {
    primeUnseeded()

    const res = await saveStarterContent.execute!(
      // No tenant/user fields in the schema — the model can only describe content.
      {
        projectName: 'Launch the beta',
        actions: [{ title: 'Connect your calendar' }, { title: 'Record your first meeting' }],
      },
      ctxWith(PRINCIPAL),
    )

    expect((res as { success: boolean }).success).toBe(true)

    const projUpsert = recorded.find((r) => r.table === 'projects' && r.op === 'upsert')
    expect(projUpsert?.payload?.workspace_id).toBe('real-ws')
    expect(projUpsert?.payload?.user_id).toBe('real-user')
    // deterministic project id derived from the PRINCIPAL workspace
    expect(projUpsert?.payload?.id).toBe(deriveStarterProjectId('real-ws'))

    // team + state were resolved scoped to the principal workspace
    const teamSelect = recorded.find((r) => r.table === 'team' && r.op === 'select')
    expect(teamSelect?.filters.workspace_id).toBe('real-ws')

    const actionUpserts = recorded.filter((r) => r.table === 'actions' && r.op === 'upsert')
    expect(actionUpserts).toHaveLength(2)
    for (const a of actionUpserts) {
      expect(a.payload?.workspace_id).toBe('real-ws')
      expect(a.payload?.user_id).toBe('real-user')
    }
  })

  it('rejects cleanly (no crash, no write) when the session has no workspace', async () => {
    const res = await saveStarterContent.execute!(
      { projectName: 'x', actions: [{ title: 'y' }] },
      ctxWith({ principalId: 'u', workspaceId: '' }),
    )
    expect(res).toEqual(
      expect.objectContaining({ success: false, error: expect.stringMatching(/workspace/i) }),
    )
    expect(recorded.filter((r) => r.op === 'upsert' || r.op === 'update')).toHaveLength(0)
  })

  it('rejects cleanly when the caller is not a user principal (localDev path)', async () => {
    const res = await saveStarterContent.execute!(
      { projectName: 'x', actions: [{ title: 'y' }] },
      ctxWith({ principalId: 'local', workspaceId: 'x', principalType: 'runtime' }),
    )
    expect((res as { success: boolean }).success).toBe(false)
    expect(recorded.filter((r) => r.op === 'upsert')).toHaveLength(0)
  })
})

describe('save_starter_content — NOT-NULL field population', () => {
  it('populates every NOT-NULL column on the project and actions', async () => {
    primeUnseeded()

    await saveStarterContent.execute!(
      { projectName: 'Ship v1', actions: [{ title: 'Invite a teammate', description: 'from Settings' }] },
      ctxWith(PRINCIPAL),
    )

    // projects NOT-NULL-without-default: user_id, name, workspace_id
    const proj = recorded.find((r) => r.table === 'projects' && r.op === 'upsert')?.payload
    expect(proj?.user_id).toBe('real-user')
    expect(proj?.workspace_id).toBe('real-ws')
    expect(proj?.name).toBe('Ship v1')

    // actions NOT-NULL-without-default: user_id, title, workspace_id, team_id, status_id
    // (identifier is left to the DB trigger — must NOT be set here)
    const act = recorded.find((r) => r.table === 'actions' && r.op === 'upsert')?.payload
    expect(act?.user_id).toBe('real-user')
    expect(act?.workspace_id).toBe('real-ws')
    expect(act?.team_id).toBe('team-1')
    expect(act?.status_id).toBe('state-1')
    expect(act?.title).toBe('Invite a teammate')
    expect(act?.project_id).toBe(deriveStarterProjectId('real-ws'))
    expect('identifier' in (act ?? {})).toBe(false)
    // seeded marker present and identifiable
    expect(act?.context_data).toEqual({ seeded_by: 'onboarding' })
    // source_type must be ABSENT: the actions_source_type_check constraint
    // allows only user/meeting_extraction/chat_suggestion/stt_extraction/
    // insight_suggestion (NULL passes) — 'onboarding' broke every insert on
    // the first live smoke. The demo capture's seeded actions omit it too.
    expect('source_type' in (act ?? {})).toBe(false)
  })

  it('fails cleanly when no team resolves for the workspace (no partial seed)', async () => {
    reads['projects:maybeSingle'] = { data: null, error: null }
    reads['team:maybeSingle'] = { data: null, error: null } // no team

    const res = await saveStarterContent.execute!(
      { projectName: 'x', actions: [{ title: 'y' }] },
      ctxWith(PRINCIPAL),
    )
    expect((res as { success: boolean }).success).toBe(false)
    // nothing was written
    expect(recorded.filter((r) => r.op === 'upsert')).toHaveLength(0)
  })
})

describe('save_starter_content — server-side caps', () => {
  it('caps actions at 4 even if the schema somehow lets more through', async () => {
    primeUnseeded()

    // Call execute() directly with 6 actions — the schema's .max(4) is bypassed
    // here (execute doesn't re-validate), proving the tool's OWN slice() cap holds.
    const res = await saveStarterContent.execute!(
      {
        projectName: 'Too many',
        actions: [
          { title: 'a' },
          { title: 'b' },
          { title: 'c' },
          { title: 'd' },
          { title: 'e' },
          { title: 'f' },
        ],
      } as never,
      ctxWith(PRINCIPAL),
    )

    expect((res as { success: boolean; actionCount: number }).actionCount).toBe(4)
    const actionUpserts = recorded.filter((r) => r.table === 'actions' && r.op === 'upsert')
    expect(actionUpserts).toHaveLength(4)
  })

  it('trims and clamps workspaceRename to 80 chars', async () => {
    primeUnseeded()

    const longName = '  ' + 'X'.repeat(200) + '  '
    const res = await saveStarterContent.execute!(
      {
        projectName: 'p',
        actions: [{ title: 'a' }],
        workspaceRename: longName,
      },
      ctxWith(PRINCIPAL),
    )

    const rename = recorded.find((r) => r.table === 'workspace' && r.op === 'update')
    expect((rename?.payload?.name as string).length).toBe(80)
    // rename is scoped to the principal workspace, never a model-supplied id
    expect(rename?.filters.id).toBe('real-ws')
    expect((res as { workspaceRenamed?: string }).workspaceRenamed).toHaveLength(80)
  })

  it('does not rename the workspace when workspaceRename is blank', async () => {
    primeUnseeded()

    await saveStarterContent.execute!(
      { projectName: 'p', actions: [{ title: 'a' }], workspaceRename: '   ' },
      ctxWith(PRINCIPAL),
    )
    expect(recorded.filter((r) => r.table === 'workspace' && r.op === 'update')).toHaveLength(0)
  })

  it('does NOT rename the workspace when the caller is not the owner (RLS parity)', async () => {
    // Defense-in-depth: renaming is owner-only under the "Owners can update
    // workspace" RLS policy that this service-role write bypasses. A non-owner
    // run still seeds the project + actions, but the rename is refused.
    primeUnseeded()
    reads['member:maybeSingle'] = { data: { role: 'member' }, error: null }

    const res = await saveStarterContent.execute!(
      { projectName: 'p', actions: [{ title: 'a' }], workspaceRename: 'PWNED' },
      ctxWith(PRINCIPAL),
    )

    // Project + actions still seeded (those are not owner-gated) …
    expect((res as { success: boolean }).success).toBe(true)
    expect(recorded.filter((r) => r.table === 'projects' && r.op === 'upsert')).toHaveLength(1)
    expect(recorded.filter((r) => r.table === 'actions' && r.op === 'upsert')).toHaveLength(1)
    // … but NO workspace rename was written, and none is reported.
    expect(recorded.filter((r) => r.table === 'workspace' && r.op === 'update')).toHaveLength(0)
    expect((res as { workspaceRenamed?: string }).workspaceRenamed).toBeUndefined()
  })

  it('refuses the rename even on a re-run when the caller is not the owner', async () => {
    // A re-run (workspace already seeded) still applies renames — it must
    // honor the same owner gate so a non-owner can't rename via a replay.
    const projectId = deriveStarterProjectId('real-ws')
    primeUnseeded()
    reads['projects:maybeSingle'] = { data: { id: projectId, name: 'Existing' }, error: null }
    reads['member:maybeSingle'] = { data: { role: 'guest' }, error: null }

    const res = await saveStarterContent.execute!(
      { projectName: 'p', actions: [{ title: 'a' }], workspaceRename: 'PWNED' },
      ctxWith(PRINCIPAL),
    )

    expect((res as { success: boolean }).success).toBe(true)
    expect(recorded.filter((r) => r.table === 'workspace' && r.op === 'update')).toHaveLength(0)
    expect((res as { workspaceRenamed?: string }).workspaceRenamed).toBeUndefined()
  })
})

describe('save_starter_content — re-run self-heal (no frozen partial seeds)', () => {
  it('re-runs upsert into the SAME deterministic ids and report the canonical (first-run) name', async () => {
    // The first live smoke exposed this exact trap: run 1 wrote the project but
    // every action insert failed (constraint violation); the old "already
    // seeded → no-op" short-circuit then froze the workspace at zero actions
    // forever. A re-run must WRITE (upsert; ignoreDuplicates makes true replays
    // harmless) so the missing actions get filled in.
    const projectId = deriveStarterProjectId('real-ws')
    primeUnseeded()
    // Canonical read-back returns the FIRST run's name — the report must use
    // it, not this call's differing input.
    reads['projects:maybeSingle'] = { data: { id: projectId, name: 'Existing project' }, error: null }

    const res = await saveStarterContent.execute!(
      { projectName: 'A totally different name', actions: [{ title: 'new' }] },
      ctxWith(PRINCIPAL),
    )

    const body = res as {
      success: boolean
      projectId: string
      projectName: string
      actionIds: string[]
    }
    expect(body.success).toBe(true)
    expect(body.projectId).toBe(projectId)
    expect(body.projectName).toBe('Existing project')
    expect(body.actionIds).toEqual([deriveStarterActionId(projectId, 0)])

    // The re-run WRITES (that is the self-heal) — into the same ids.
    const projUpserts = recorded.filter((r) => r.table === 'projects' && r.op === 'upsert')
    expect(projUpserts).toHaveLength(1)
    expect(projUpserts[0]?.payload?.id).toBe(projectId)
    const actUpserts = recorded.filter((r) => r.table === 'actions' && r.op === 'upsert')
    expect(actUpserts).toHaveLength(1)
    expect(actUpserts[0]?.payload?.id).toBe(deriveStarterActionId(projectId, 0))
  })

  it('uses ignoreDuplicates upserts so a step replay cannot duplicate', async () => {
    primeUnseeded()

    await saveStarterContent.execute!(
      { projectName: 'p', actions: [{ title: 'a' }] },
      ctxWith(PRINCIPAL),
    )

    const proj = recorded.find((r) => r.table === 'projects' && r.op === 'upsert')
    expect(proj?.options).toEqual(expect.objectContaining({ onConflict: 'id', ignoreDuplicates: true }))
    const act = recorded.find((r) => r.table === 'actions' && r.op === 'upsert')
    expect(act?.options).toEqual(expect.objectContaining({ onConflict: 'id', ignoreDuplicates: true }))
  })
})

describe('deriveStarterProjectId / deriveStarterActionId', () => {
  it('project id is a stable function of the workspace', () => {
    expect(deriveStarterProjectId('ws-1')).toBe(deriveStarterProjectId('ws-1'))
    expect(deriveStarterProjectId('ws-1')).not.toBe(deriveStarterProjectId('ws-2'))
  })

  it('produces syntactically valid v5 UUIDs', () => {
    const re = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    expect(deriveStarterProjectId('ws-1')).toMatch(re)
    expect(deriveStarterActionId(deriveStarterProjectId('ws-1'), 0)).toMatch(re)
  })

  it('action ids are distinct per ordinal and never collide with the project id', () => {
    const pid = deriveStarterProjectId('ws-1')
    const a0 = deriveStarterActionId(pid, 0)
    const a1 = deriveStarterActionId(pid, 1)
    expect(a0).not.toBe(a1)
    expect(a0).not.toBe(pid)
  })
})
