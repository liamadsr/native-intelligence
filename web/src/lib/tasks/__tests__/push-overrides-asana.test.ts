/**
 * Tests for the OVERRIDE half of src/lib/tasks/asana-push.ts.
 *
 * Kept apart from asana-push.test.ts, which pins the no-override behaviour and
 * must keep passing untouched.
 *
 * THE SECTION RULE is what most of this file is about. A section gid belongs to
 * exactly one project, so an overridden project makes the config's section_map
 * meaningless and it is suppressed wholesale rather than applied to a project it
 * does not describe. Getting this wrong is not cosmetic: it either 400s the
 * create or, worse, silently files the task under a stranger's column.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const hoistedApi = vi.hoisted(() => ({ createTask: vi.fn(), deleteTask: vi.fn() }))
class FakeUnauthorized extends Error {
  constructor() {
    super('401')
    this.name = 'AsanaUnauthorizedError'
  }
}
class FakeApiError extends Error {
  readonly status: number
  constructor(status: number, message = 'boom') {
    super(message)
    this.name = 'AsanaApiError'
    this.status = status
  }
}
vi.mock('@/lib/integrations/asana-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    createTask: hoistedApi.createTask,
    deleteTask: hoistedApi.deleteTask,
    AsanaUnauthorizedError: FakeUnauthorized,
    AsanaApiError: FakeApiError,
  }
})

const hoistedToken = vi.hoisted(() => ({ getValidTokenForAccount: vi.fn() }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoistedToken.getValidTokenForAccount,
}))

const hoistedConfig = vi.hoisted(() => ({ loadAsanaSyncState: vi.fn() }))
vi.mock('@/lib/tasks/asana-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, loadAsanaSyncState: hoistedConfig.loadAsanaSyncState }
})

const hoistedAdmin = vi.hoisted(() => ({ getUserById: vi.fn() }))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({ auth: { admin: { getUserById: hoistedAdmin.getUserById } } }),
}))

const { pushActionToAsana } = await import('../asana-push')
import type { AsanaPushOverrides } from '../push-overrides'

function makeDb(action: Record<string, unknown> | null) {
  function builder(table: string) {
    const api: Record<string, unknown> = {
      select: () => api,
      eq: () => api,
      order: () => api,
      limit: () => api,
      insert: (payload: Record<string, unknown>) => ({
        select: () => ({ single: async () => ({ data: { id: 'link-1', ...payload }, error: null }) }),
      }),
      maybeSingle: async () => {
        if (table === 'actions') return { data: action, error: null }
        if (table === 'member') return { data: { user_id: 'auth-1' }, error: null }
        return { data: null, error: null }
      },
    }
    return api
  }
  return { from: builder } as unknown as SupabaseClient
}

const ACTION = {
  id: 'act-1',
  identifier: 'ENG-42',
  title: 'Ship the thing',
  description: 'Do the work',
  due_at: '2026-07-30T17:00:00.000Z',
  all_day: true,
  assignee_id: null,
  workflow_state: { category: 'started' },
}

/** A config whose in_progress bucket maps to a section of project 111. */
const CONFIG = {
  asana_workspace_gid: 'ws-gid',
  project_gid: '111',
  project_name: 'Roadmap',
  section_map: {
    not_started: 'sect-todo',
    in_progress: 'sect-doing',
    done: 'sect-done',
    canceled: null,
  },
}

function push(overrides: AsanaPushOverrides, action: Record<string, unknown> | null = ACTION) {
  return pushActionToAsana({
    actionId: 'act-1',
    workspaceId: 'ws-1',
    userId: 'u-1',
    supabase: makeDb(action),
    overrides,
  })
}

/** The payload of the last create call. */
function sentPayload(): Record<string, unknown> {
  return hoistedApi.createTask.mock.calls.at(-1)?.[1] as Record<string, unknown>
}

beforeEach(() => {
  vi.resetAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = 'https://dial8.ai'
  hoistedConfig.loadAsanaSyncState.mockResolvedValue({
    id: 'tss-1',
    accountId: 'acct-1',
    userId: 'u-1',
    config: CONFIG,
  })
  hoistedToken.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoistedApi.createTask.mockResolvedValue({
    gid: 'task-1',
    permalink_url: 'https://app.asana.com/0/111/task-1',
    name: 'Ship the thing',
    completed: false,
  })
  hoistedApi.deleteTask.mockResolvedValue(undefined)
})

describe('pushActionToAsana — destination overrides', () => {
  it('replaces the task name with the overridden title', async () => {
    await push({ title: 'A different name' })
    expect(sentPayload().name).toBe('A different name')
  })

  /**
   * THE SECTION RULE. The config maps this action's in_progress bucket to
   * sect-doing, a section of project 111 — meaningless in project 222, so the
   * task lands via the plain `projects` form with no section at all.
   */
  it('SUPPRESSES the config section map when the project is overridden', async () => {
    await push({ project_gid: '222' })
    const payload = sentPayload()
    expect(payload.projects).toEqual(['222'])
    expect(payload.memberships).toBeUndefined()
  })

  it('uses the overridden section when one is picked with the project', async () => {
    await push({ project_gid: '222', section_gid: 'sect-new' })
    const payload = sentPayload()
    expect(payload.memberships).toEqual([{ project: '222', section: 'sect-new' }])
    expect(payload.projects).toBeUndefined()
  })

  /** Same project, different column: the map still does not get a vote. */
  it('lets an explicit section override the mapped one in the SAME project', async () => {
    await push({ section_gid: 'sect-other' })
    expect(sentPayload().memberships).toEqual([{ project: '111', section: 'sect-other' }])
  })

  /** No project override → the map applies exactly as it always has. */
  it('keeps the mapped section when only unrelated fields are overridden', async () => {
    await push({ title: 'Renamed' })
    expect(sentPayload().memberships).toEqual([{ project: '111', section: 'sect-doing' }])
  })

  it('completes a destination the config never had', async () => {
    hoistedConfig.loadAsanaSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: { asana_workspace_gid: 'ws-gid' },
    })
    const result = await push({ project_gid: '222' })
    expect(result.ok).toBe(true)
    expect(sentPayload().projects).toEqual(['222'])
  })
})

describe('pushActionToAsana — overridden due date', () => {
  /**
   * `due_on` and `due_at` are mutually exclusive and Asana clears one when the
   * other is set, so an override sends the date-only form ALONE — never both,
   * and never the action's timed value alongside it.
   */
  it('sends `due_on` ALONE, dropping the action’s own due fields', async () => {
    await push({ due_on: '2026-09-09' }, { ...ACTION, all_day: false })
    const payload = sentPayload()
    expect(payload.due_on).toBe('2026-09-09')
    expect(payload.due_at).toBeUndefined()
  })

  it('falls back to the action’s due fields with no override', async () => {
    await push({ title: 'Renamed' })
    expect(sentPayload().due_on).toBe('2026-07-30')
  })
})

describe('pushActionToAsana — overridden assignee', () => {
  it('sends the picked gid and never looks up an email', async () => {
    await push({ assignee_gid: '333' }, { ...ACTION, assignee_id: 'mem-1' })
    expect(sentPayload().assignee).toBe('333')
    expect(hoistedAdmin.getUserById).not.toHaveBeenCalled()
  })

  /**
   * The unassigned retry covers BOTH assignee shapes — a picked gid that has
   * lost project access fails exactly like an email that isn't a member.
   */
  it('retries WITHOUT the assignee when a picked gid is rejected', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoistedApi.createTask
      .mockRejectedValueOnce(new FakeApiError(400, 'assignee not found'))
      .mockResolvedValueOnce({ gid: 'task-1', permalink_url: null, name: 'x', completed: false })

    const result = await push({ assignee_gid: '333' })
    expect(result.ok).toBe(true)
    expect(hoistedApi.createTask).toHaveBeenCalledTimes(2)
    expect(sentPayload().assignee).toBeUndefined()
  })
})
